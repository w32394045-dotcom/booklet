/* End-to-end browser test with headless Chrome (CDP): rendering, imposition, print channel. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const dir = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe'
  : '/usr/bin/google-chrome');
const PORT = 9631;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'booklet-chrome-'));
fs.mkdirSync(profile, { recursive: true });

const pdfB64 = fs.readFileSync(path.join(dir, 'fixtures', 'p10.pdf')).toString('base64');
const coverB64 = fs.readFileSync(path.join(dir, 'fixtures', 'p08.pdf')).toString('base64');
const url = pathToFileURL(path.join(dir, 'index.html')).href;

let pass = 0;
const fails = [];
const ok = (c, n, x) => { if (c) pass++; else fails.push(n + (x === undefined ? '' : ' :: ' + x)); };
const eq = (a, b, n) => ok(JSON.stringify(a) === JSON.stringify(b), n, JSON.stringify(a) + ' != ' + JSON.stringify(b));
const approx = (a, b, n, tol) => ok(Math.abs(a - b) <= (tol || 1.5), n, a + ' ~ ' + b);

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
  '--no-default-browser-check', '--disable-crash-reporter', '--remote-debugging-port=' + PORT,
  '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', windowsHide: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, msgId = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function ev(expression, awaitPromise) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: !!awaitPromise, returnByValue: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception && (r.exceptionDetails.exception.description || r.exceptionDetails.exception.value);
    throw new Error('EVAL: ' + (d || JSON.stringify(r.exceptionDetails)));
  }
  return r.result ? r.result.value : undefined;
}
async function evj(expression) { return JSON.parse(await ev(expression, true)); }
async function waitFor(expression, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 20000)) {
    try { if (await ev(expression)) return true; } catch (e) {}
    await sleep(250);
  }
  return false;
}
async function printPdf() {
  const r = await send('Page.printToPDF', {
    printBackground: true, preferCSSPageSize: true,
    marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0
  });
  return r.data;
}
async function setFile(selector, filePath) {
  const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
  const q = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
  if (!q.nodeId) throw new Error('no node for ' + selector);
  await send('DOM.setFileInputFiles', { files: [filePath], nodeId: q.nodeId });
}

(async () => {
  try {
    for (let i = 0; i < 100; i++) {
      try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) break; } catch (e) {}
      await sleep(200);
    }
    const tab = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?about:blank', { method: 'PUT' })).json();
    ws = new WebSocket(tab.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      }
    };
    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
    await send('Page.navigate', { url });
    ok(await waitFor('!!window.booklet && !!window.pdfjsLib', 20000), 'app boots with pdf.js');
    if (!(await ev('!!window.booklet'))) throw new Error('no app api');

    /* ---------- 1. initial UI ---------- */
    const init = await evj('JSON.stringify({lib:!!window.pdfjsLib,api:!!window.booklet,langs:document.querySelectorAll("#langSel option").length,plannone:document.getElementById("planBar").textContent.length>0})');
    ok(init.lib && init.api, 'api + lib available');
    eq(init.langs, 7, '7 languages in selector');
    ok(init.plannone, 'plan bar initial message');

    /* ---------- 2. load 10 page PDF ---------- */
    await ev('window.booklet.loadBase64(' + JSON.stringify(pdfB64) + ',"p10.pdf")', true);
    const st = await evj('JSON.stringify(window.booklet.getState())');
    eq(st.pageCount, 10, 'page count 10');
    eq([st.plan.from, st.plan.to, st.plan.selected, st.plan.N, st.plan.S, st.plan.padded, st.plan.volumes.length],
      [1, 10, 10, 12, 3, 2, 1], 'plan for 10 pages');
    eq(st.cfg.paper, 'A4', 'default paper A4');

    const front = await evj('JSON.stringify(window.booklet.getJobs("front"))');
    const back = await evj('JSON.stringify(window.booklet.getJobs("back"))');
    eq(front.map((s) => [s.left, s.right]), [[null, 1], [10, 3], [8, 5]], 'front imposition 10p');
    eq(back.map((s) => [s.left, s.right]), [[2, null], [4, 9], [6, 7]], 'back imposition 10p');

    /* ---------- 3. thumbnails / preview geometry ---------- */
    const thumbs = await waitFor('document.querySelectorAll("#prevFront img[src]").length>=5 && document.querySelectorAll("#prevBack img[src]").length>=5', 40000);
    ok(thumbs, 'thumbnails rendered');
    const counts = await evj('JSON.stringify({f:document.querySelectorAll("#prevFront .sheet-card").length,b:document.querySelectorAll("#prevBack .sheet-card").length,fi:document.querySelectorAll("#prevFront img[src]").length,bi:document.querySelectorAll("#prevBack img[src]").length,fb:document.querySelectorAll("#prevFront .mini-pane.blank").length,bb:document.querySelectorAll("#prevBack .mini-pane.blank").length,err:window.booklet.getState().thumbError,thumbCount:window.booklet.getState().thumbCount})');
    ok(!counts.err, 'no thumbnail render error', counts.err);
    eq([counts.f, counts.b], [3, 3], 'sheet cards per pass');
    eq([counts.fi, counts.bi], [5, 5], 'page images per pass (10 total)');
    eq([counts.fb, counts.bb], [1, 1], 'blank panels drawn');
    eq(counts.thumbCount, 10, 'thumbs only for the selected pages');
    await ev('window.booklet.setConfig({gutter:6,paper:"A4"})', true);
    await sleep(200);

    const pgeo = await evj(`(function(){var s=document.querySelector('#prevFront .mini-sheet');var r=s.getBoundingClientRect();var ps=s.querySelectorAll('.mini-pane');var a=ps[0].getBoundingClientRect(),b=ps[1].getBoundingClientRect();return JSON.stringify({ar:r.width/r.height,w:r.width,gap:b.left-(a.left+a.width)});})()`);
    approx(pgeo.ar, 297 / 210, 'preview sheet aspect ~A4 landscape', 0.03);
    approx(pgeo.gap / pgeo.w * 100, 6 / 297 * 100, 'preview gutter ~6mm', 0.6);

    await ev(`window.__pMut=0;window.__pObs=new MutationObserver(function(ms){window.__pMut+=ms.length});window.__pObs.observe(document.getElementById('prevFront'),{childList:true,subtree:true,attributes:true});`);
    await ev(`(function(){var r=document.getElementById('gutterRange');for(var i=0;i<8;i++){r.value=String(6+i);r.dispatchEvent(new Event('input',{bubbles:true}));}})()`);
    await sleep(400);
    const sliderMut = await ev('window.__pMut');
    ok(sliderMut < 4, 'gutter slider keeps the preview DOM stable', sliderMut);
    const sliderGap = await evj(`(function(){var s=document.querySelector('#prevFront .mini-sheet');var ps=s.querySelectorAll('.mini-pane');var a=ps[0].getBoundingClientRect(),b=ps[1].getBoundingClientRect();return JSON.stringify({gap:b.left-(a.left+a.width),w:s.getBoundingClientRect().width});})()`);
    approx(sliderGap.gap / sliderGap.w * 100, 13 / 297 * 100, 'preview gutter follows 13mm', 0.6);
    await ev('window.booklet.setConfig({gutter:6})', true);

    /* ---------- 3b. big PDF: thumbs only for the current booklet ---------- */
    const p40B64 = fs.readFileSync(path.join(dir, 'fixtures', 'p40.pdf')).toString('base64');
    await ev('window.booklet.loadBase64(' + JSON.stringify(p40B64) + ',"p40.pdf")', true);
    await ev('window.booklet.setConfig({autoSplit:true,maxSheets:5,rangeFrom:1,rangeTo:40,gutter:6})', true);
    const split = await evj('JSON.stringify(window.booklet.getState().plan)');
    eq(split.volumes.length, 2, 'p40 splits into 2 booklets');
    eq([split.volumes[0].from, split.volumes[0].to], [1, 20], 'first booklet covers pages 1-20');
    ok(await waitFor('window.booklet.getState().thumbCount===20', 90000), 'thumbs limited to the current booklet (20 of 40 pages)');
    eq(await ev('window.booklet.getState().thumbCount'), 20, 'other volume not thumbnailed yet');
    await ev(`document.getElementById('volChips').children[1].click()`);
    ok(await waitFor('window.booklet.getState().thumbCount===40', 90000), 'second booklet thumbnailed on demand');
    await ev(`document.getElementById('volChips').children[0].click()`);
    await ev('window.booklet.loadBase64(' + JSON.stringify(pdfB64) + ',"p10.pdf")', true);
    await ev('window.booklet.setConfig({autoSplit:true,maxSheets:20,rangeFrom:1,rangeTo:10,gutter:6})', true);

    /* ---------- 4. gutter geometry in print DOM ---------- */
    await ev('window.booklet.setConfig({dpi:200,gutter:12})', true);
    const dom = await evj('window.booklet.buildPrintDom("front").then(function(){var s=[...document.querySelectorAll("#printRoot .print-sheet")];return JSON.stringify({sheets:s.length,style:document.getElementById("pageStyle").textContent,imgs:[...document.querySelectorAll("#printRoot .print-sheet:nth-child(2) img")].map(function(i){return [parseFloat(i.style.left),parseFloat(i.style.width)]})});})');
    eq(dom.sheets, 3, 'print DOM sheet count');
    eq(dom.style, '@page{size:297mm 210mm;margin:0}', 'A4 landscape @page');
    eq(dom.imgs.length, 2, 'two images on second sheet');
    const gap = dom.imgs[1][0] - (dom.imgs[0][0] + dom.imgs[0][1]);
    approx(gap, 12, 'center gutter = 12mm gap', 0.2);
    const blobOk = await ev('[...document.querySelectorAll("#printRoot img")].every(function(i){return i.src.indexOf("blob:")===0})');
    ok(blobOk, 'print images are local blob URLs');

    /* ---------- 5. real print channel ---------- */
    const frontPdf = await printPdf();
    fs.writeFileSync(path.join(os.tmpdir(), 'booklet-out-front.pdf'), Buffer.from(frontPdf, 'base64'));
    const fp = await evj('window.booklet.countPdfPages(' + JSON.stringify(frontPdf) + ').then(JSON.stringify)');
    eq(fp.pages, 3, 'front print PDF page count');
    approx(fp.wpt, 841.89, 'A4 landscape width pt', 1.5);
    approx(fp.hpt, 595.28, 'A4 landscape height pt', 1.5);

    /* A3 */
    await ev('window.booklet.setConfig({paper:"A3",gutter:0})', true);
    await ev('window.booklet.buildPrintDom("back")', true);
    const style3 = await ev('document.getElementById("pageStyle").textContent');
    eq(style3, '@page{size:420mm 297mm;margin:0}', 'A3 landscape @page');
    const backPdf = await printPdf();
    fs.writeFileSync(path.join(os.tmpdir(), 'booklet-out-back-a3.pdf'), Buffer.from(backPdf, 'base64'));
    const bp = await evj('window.booklet.countPdfPages(' + JSON.stringify(backPdf) + ').then(JSON.stringify)');
    eq(bp.pages, 3, 'A3 back print PDF page count');
    approx(bp.wpt, 1190.55, 'A3 landscape width pt', 2);
    approx(bp.hpt, 841.89, 'A3 landscape height pt', 2);

    /* ---------- 6. flip toggles ---------- */
    await ev('window.booklet.setConfig({paper:"A4",mirror:true,reverse:true})', true);
    const bm = await evj('JSON.stringify(window.booklet.getJobs("back"))');
    eq(bm.map((s) => [s.left, s.right]), [[7, 6], [9, 4], [null, 2]], 'mirror+reverse back order');

    /* ---------- 7. page range subset ---------- */
    await ev('window.booklet.setConfig({rangeFrom:3,rangeTo:8,mirror:false,reverse:false})', true);
    const st2 = await evj('JSON.stringify(window.booklet.getState())');
    eq([st2.plan.from, st2.plan.to, st2.plan.selected, st2.plan.N, st2.plan.S], [3, 8, 6, 8, 2], 'subset plan 3-8');
    eq(st2.plan.padded, 2, 'subset padding');
    const sf = await evj('JSON.stringify(window.booklet.getJobs("front"))');
    const sb = await evj('JSON.stringify(window.booklet.getJobs("back"))');
    eq(sf.map((s) => [s.left, s.right]), [[null, 3], [8, 5]], 'subset front pages');
    eq(sb.map((s) => [s.left, s.right]), [[4, null], [6, 7]], 'subset back pages');

    /* ---------- 8. covers: separate front/back image uploads + jacket ---------- */
    const noCover = await evj('JSON.stringify({disabled:document.getElementById("btnJacket").disabled,imgs:document.querySelectorAll("#prevJacket img[src]").length,hasCover:window.booklet.getState().hasCover})');
    eq(noCover.disabled, true, 'jacket pass disabled without covers');
    eq(noCover.hasCover, false, 'no cover initially');
    eq(noCover.imgs, 0, 'empty jacket preview');

    await setFile('#coverFrontInput', path.join(dir, 'fixtures', 'cover-front.png'));
    ok(await waitFor('window.booklet.getState().covers.front.kind==="image"', 20000), 'front cover accepts a PNG image');
    await setFile('#coverBackInput', path.join(dir, 'fixtures', 'cover-back.png'));
    ok(await waitFor('window.booklet.getState().covers.back.kind==="image"', 20000), 'back cover accepts a PNG image');
    const cov = await evj('JSON.stringify({hasCover:window.booklet.getState().hasCover,front:window.booklet.getState().covers.front.kind,back:window.booklet.getState().covers.back.kind,imgs:document.querySelectorAll("#prevJacket img[src]").length,jobs:window.booklet.getJobs("jacket"),disabled:document.getElementById("btnJacket").disabled,coverErr:document.getElementById("coverErr").classList.contains("hidden")})');
    eq([cov.front, cov.back], ['image', 'image'], 'both cover images stored');
    eq(cov.imgs, 2, 'jacket preview shows both covers');
    eq([cov.jobs[0].left, cov.jobs[0].right], ['back', 'front'], 'jacket left = back cover, right = front cover');
    eq(cov.disabled, false, 'jacket pass enabled with covers');
    ok(cov.coverErr, 'no cover error shown');

    const jd = await evj('window.booklet.buildPrintDom("jacket").then(function(){return JSON.stringify({sheets:document.querySelectorAll("#printRoot .print-sheet").length,imgs:document.querySelectorAll("#printRoot img").length,style:document.getElementById("pageStyle").textContent})})');
    eq([jd.sheets, jd.imgs], [1, 2], 'jacket raster sheet with both cover images');
    eq(jd.style, '@page{size:297mm 210mm;margin:0}', 'jacket @page size');
    const jacketPdf = await printPdf();
    const jp = await evj('window.booklet.countPdfPages(' + JSON.stringify(jacketPdf) + ').then(JSON.stringify)');
    eq(jp.pages, 1, 'jacket print PDF = 1 page');
    const vj = await evj('window.booklet.buildVectorPdf("jacket").then(JSON.stringify)');
    eq(vj.pages, 1, 'vector jacket from image covers');
    ok(vj.size > 4000, 'vector jacket embeds the images', vj.size);
    await ev('window.booklet.cleanupPrint()');

    await ev('document.getElementById("coverBackClear").click()');
    const onlyFront = await evj('JSON.stringify({back:window.booklet.getState().covers.back.kind,jobs:window.booklet.getJobs("jacket"),imgs:document.querySelectorAll("#prevJacket img[src]").length})');
    eq(onlyFront.back, '', 'back cover cleared');
    eq(onlyFront.jobs[0].left, null, 'jacket left panel blank without back cover');
    eq(onlyFront.imgs, 1, 'one jacket preview image left');

    await ev('window.booklet.loadCoverBase64(' + JSON.stringify(coverB64) + ',"cover.pdf","front")', true);
    eq(await ev('window.booklet.getState().covers.front.kind'), 'pdf', 'front cover can still be a PDF');


    /* ---------- 8b. vector PDF mode + fallback ---------- */
    const vecB64 = fs.readFileSync(path.join(dir, 'fixtures', 'vector8.pdf')).toString('base64');
    const rotB64 = fs.readFileSync(path.join(dir, 'fixtures', 'rotated.pdf')).toString('base64');
    await ev('window.booklet.loadBase64(' + JSON.stringify(vecB64) + ',"vector8.pdf")', true);
    await ev('window.booklet.setConfig({printMode:"vector",rangeFrom:1,rangeTo:8,paper:"A4",gutter:6,mirror:false,reverse:false})', true);
    const vst = await evj('JSON.stringify({mode:window.booklet.getState().cfg.printMode,dpiHidden:document.getElementById("dpiField").classList.contains("hidden"),on:document.querySelector(".modebtn.on").getAttribute("data-mode"),btn:document.getElementById("btnFront").textContent})');
    eq(vst.mode, 'vector', 'vector mode active');
    eq(vst.on, 'vector', 'mode button active');
    ok(vst.dpiHidden, 'dpi field hidden in vector mode');
    ok(vst.btn.length > 0, 'vector mode button label');
    const vres = await evj('window.booklet.buildVectorPdf("front").then(JSON.stringify)');
    eq(vres.pages, 2, 'vector front pdf pages');
    ok(vres.size > 1000 && vres.size < 400000, 'vector pdf compact', vres.size);
    const vana = await evj('window.booklet.analyzePdf(' + JSON.stringify(vres.base64) + ').then(JSON.stringify)');
    eq(vana.pages, 2, 'vector pdf re-parsed pages');
    approx(vana.wpt, 841.89, 'vector page width pt', 1.5);
    approx(vana.hpt, 595.28, 'vector page height pt', 1.5);
    ok(vana.text.indexOf('PAGE 1') >= 0 && vana.text.indexOf('PAGE 8') >= 0, 'vector text preserved (not rasterized)', vana.text.slice(0, 120));
    const vjacket = await evj('window.booklet.buildVectorPdf("jacket").then(JSON.stringify)');
    eq(vjacket.pages, 1, 'vector jacket pdf pages');
    await ev('window.booklet.loadBase64(' + JSON.stringify(rotB64) + ',"rotated.pdf")', true);
    await ev('window.booklet.setConfig({printMode:"vector"})', true);
    const rot = await ev('window.booklet.buildVectorPdf("front").then(function(){return "ok"}).catch(function(e){return "err:"+((e&&e.code)||(e&&e.message)||e)})', true);
    ok(typeof rot === 'string' && rot.indexOf('err:') === 0, 'rotated pdf rejected for vector mode', rot);
    await ev('window.booklet.setConfig({printMode:"raster"})', true);
    const rdom = await evj('window.booklet.buildPrintDom("front").then(function(){return JSON.stringify({sheets:document.querySelectorAll("#printRoot .print-sheet").length,style:document.getElementById("pageStyle").textContent})})', true);
    eq(rdom.sheets, 2, 'raster mode still works');
    await ev('window.booklet.cleanupPrint()');

    /* ---------- 8c. vector print: hidden iframe, no popup window ---------- */
    await ev('window.booklet.loadBase64(' + JSON.stringify(vecB64) + ',"vector8.pdf")', true);
    await ev('window.booklet.setConfig({printMode:"vector",rangeFrom:1,rangeTo:8,paper:"A4",gutter:6,mirror:false,reverse:false})', true);
    await waitFor('document.querySelectorAll("#prevFront img[src]").length>=4', 40000);
    await ev(`window.__opens=0;window.__frames=[];window.__open0=window.open;window.open=function(){window.__opens++;return null;};
      new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){if(n.tagName==='IFRAME'&&n.getAttribute('title')==='booklet-print')window.__frames.push(n.src||'');});});}).observe(document.body,{childList:true});
      document.getElementById("pdfLinks").innerHTML='';`);
    await ev('document.getElementById("btnFront").click()');
    ok(await waitFor('window.__frames.length>0', 30000), 'vector print creates the hidden print iframe');
    await sleep(1200);
    const dp = await evj('JSON.stringify({opens:window.__opens,frames:window.__frames,framesLeft:document.querySelectorAll("iframe[title=booklet-print]").length,links:document.querySelectorAll("#pdfLinks a").length,href:(document.querySelector("#pdfLinks a")||{}).href||""})');
    eq(dp.opens, 0, 'vector print never opens a popup window');
    eq(dp.frames.length, 1, 'exactly one hidden print iframe');
    ok(dp.links >= 2, 'PDF open/download links kept as fallback', dp.links);
    eq(dp.href.indexOf('blob:'), 0, 'fallback link points at the generated PDF');
    ok(await waitFor('document.querySelectorAll("iframe[title=booklet-print]").length===0', 12000), 'print iframe cleaned up afterwards');
    await ev('window.open=window.__open0;');

    /* ---------- 9. i18n ---------- */
    await ev('window.booklet.setLang("zh-CN")');
    ok((await ev('document.title')).indexOf('骑马钉') >= 0, 'zh-CN title');
    ok((await ev('document.documentElement.lang')) === 'zh-CN', 'html lang zh-CN');
    await ev('window.booklet.setLang("ja")');
    ok((await ev('document.title')).indexOf('中綴じ') >= 0, 'ja title');
    const unresolved = await evj('JSON.stringify([...document.querySelectorAll("[data-i18n]")].filter(function(el){return el.textContent===el.getAttribute("data-i18n")}).length)');
    eq(unresolved, 0, 'all data-i18n resolved in ja');
    await ev('window.booklet.setLang("en")');
    ok((await ev('document.title')) === 'Booklet Printer', 'en title restored');

    /* ---------- 10. stats persistence ---------- */
    await ev('localStorage.setItem("booklet.stats.v1",JSON.stringify({front:3,back:2,jacket:1,sheets:9}))');
    await send('Page.reload');
    ok(await waitFor('!!window.booklet', 20000), 'reload ok');
    await sleep(500);
    const stat = await ev('document.getElementById("statText").textContent');
    ok(stat.indexOf('3') >= 0 && stat.indexOf('9') >= 0, 'persisted stats shown', stat);
    await ev('document.getElementById("statReset").click()');
    const stat2 = await ev('document.getElementById("statText").textContent');
    ok(stat2.indexOf('3') < 0, 'stats reset', stat2);

    /* ---------- 11. invalid PDF ---------- */
    const bad = await ev('window.booklet.loadBase64("aGVsbG8=","bad.pdf").then(function(){return "loaded"}).catch(function(){return "rejected"})', true);
    eq(bad, 'rejected', 'invalid pdf rejected');

    /* ---------- 12. screenshot ---------- */
    await ev('window.booklet.setLang("zh-CN")');
    await ev('window.booklet.loadBase64(' + JSON.stringify(pdfB64) + ',"p10.pdf")', true);
    await ev('window.booklet.setConfig({printMode:"vector",rangeFrom:1,rangeTo:10,gutter:6,paper:"A4"})', true);
    await waitFor('document.querySelectorAll("#prevFront img").length>=5', 40000);
    await sleep(400);
    try {
      const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 72 });
      fs.writeFileSync(path.join(os.tmpdir(), 'booklet-ui.jpg'), Buffer.from(shot.data, 'base64'));
    } catch (e) { /* screenshot optional */ }
  } catch (e) {
    fails.push('EXCEPTION: ' + e.message);
  } finally {
    try { if (ws) ws.close(); } catch (e) {}
    try { chrome.kill(); } catch (e) {}
  }
  if (fails.length) {
    console.error('BROWSER TESTS FAILED: ' + fails.length + ' / ' + (pass + fails.length));
    fails.forEach((f) => console.error('  - ' + f));
    process.exit(1);
  }
  console.log('BROWSER TESTS PASS ' + pass + '/' + pass);
})();
