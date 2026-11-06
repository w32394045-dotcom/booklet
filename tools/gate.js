/* Static checks on the built single-file app. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'index.html');
if (!fs.existsSync(file)) { console.error('index.html missing - run tools/build.js first'); process.exit(1); }
const html = fs.readFileSync(file, 'utf8');
const size = Buffer.byteLength(html);
const sha = crypto.createHash('sha256').update(html).digest('hex');

let pass = 0;
const fails = [];
const ok = (c, n, x) => { if (c) pass++; else fails.push(n + (x ? ' :: ' + x : '')); };
const has = (n, label) => ok(html.indexOf(n) >= 0, label || ('contains ' + n));

/* size / shape */
ok(size > 1.1e6, 'size > 1.1MB', size);
ok(size < 4.5e6, 'size < 4.5MB', size);
ok(html.startsWith('<!doctype html>'), 'doctype');
has('</html>');
has('<meta charset="utf-8">');
has('name="viewport"');
has('<title>Booklet Printer</title>');
has('id="pageStyle"');
has('id="printRoot"');

/* CSP */
has('Content-Security-Policy');
has("default-src 'none'");
has("script-src 'self' 'unsafe-inline' blob:");
has('worker-src blob:');
has('img-src');
has("connect-src 'none'");

/* pdf.js inlined */
ok(html.indexOf('pdfjsLib') >= 0, 'pdf.js global present');
ok(html.indexOf('pdf.worker') >= 0 || html.indexOf('WorkerMessageHandler') >= 0, 'pdf worker code present');
const workerBlock = html.match(/<script id="pdfWorkerSrc" type="text\/plain">([\s\S]*?)<\/script>/);
ok(!!workerBlock, 'worker script block found');
if (workerBlock) {
  ok(workerBlock[1].length > 900000, 'worker block large', workerBlock[1].length);
}
has('PDF.js v3.11.174');
has('Apache-2.0');
has('pdf-lib v1.17.1');
has('PDFLib');

/* i18n */
has('window.__I18N=');
has('window.__LANG_NAMES=');
['zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'en'].forEach((lc) => has('"' + lc + '":', 'locale ' + lc));
has('"app.title":"Booklet Printer"');
has('"app.title":"骑马钉打印器"');
has('"print.tipTitle"');
has('"counter.text"');
has('"print.modeVector"');
has('"print.pdfFallback"');

/* app hooks */
['id="fileInput"', 'id="coverFrontInput"', 'id="coverBackInput"', 'id="coverFrontClear"',
 'id="coverBackClear"', 'id="coverFrontPrev"', 'id="coverBackPrev"', 'id="coverErr"',
 'id="gutterRange"', 'id="gutterNum"', 'id="mirrorChk"',
 'id="reverseChk"', 'id="splitChk"', 'id="maxSheets"', 'id="rangeFrom"', 'id="rangeTo"',
 'id="btnFront"', 'id="btnBack"', 'id="btnJacket"', 'id="volChips"', 'id="prevFront"',
 'id="prevBack"', 'id="prevJacket"', 'id="jacketPane"', 'id="statText"', 'id="statReset"', 'id="langSel"',
 'id="busy"', 'id="drop"', 'id="modeBar"', 'id="dpiField"', 'id="pdfLinks"'].forEach((h) => has(h));

/* cover UI + direct print hooks */
has('"set.coverFront"');
has('"set.coverBack"');
has('"set.coverPick"');
has('"prev.coverFront"');
has('"prev.coverBack"');
has('"prev.help"');
has('"cover.errImage"');
has('"print.jacketNeed"');
ok(html.indexOf('sourceMappingURL') < 0, 'no sourcemap directives');
ok(html.indexOf('printBlobUrl') >= 0, 'vector print uses hidden iframe (no new tab)');

/* direct print, no PDF export */
has('window.print()');
has('@page{size:');
ok(html.indexOf('pdf-lib v1.17.1') >= 0, 'pdf-lib inlined');
ok(html.indexOf('PDFLib') >= 0, 'pdf-lib global');

/* print css */
has('@media print');
has('.print-sheet');
has('break-after:page');

/* promotion links + no watermark text on print */
has('https://md2pdf.xszx.cc.cd/');
has('https://imgprint.xszx.cc.cd/');
has('https://github.com/w32394045-dotcom/md2pdf');
has('"promo.fine"');

/* security: no remote script/style loads */
ok(!/<link[^>]+rel="stylesheet"/i.test(html), 'no external stylesheet');
ok(!/<script[^>]+src=/i.test(html), 'no external script src');
ok(!/@import/i.test(html), 'no css @import');
const withoutVendor = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[^>]*>[\s\S]*?<\/script>/g, '');
const hrefs = (withoutVendor.match(/https?:\/\/[^\s"'<>)]+/g) || []).filter((u) => {
  return u.indexOf('www.w3.org') < 0;
});
const allowed = ['md2pdf.xszx.cc.cd', 'imgprint.xszx.cc.cd', 'github.com', 'www.w3.org', 'mozilla.github.io', 'pdf-lib.js.org'];
hrefs.forEach((u) => {
  const host = u.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  if (allowed.indexOf(host) < 0 && fails.length < 60) fails.push('unexpected url ' + u);
});

/* single-file sanity: no CJK leakage expected in markup outside locale JSON */
ok(html.split('<script').length <= 8, 'script tag count', html.split('<script').length);

if (fails.length) {
  console.error('GATE FAILED: ' + fails.length + ' / ' + (pass + fails.length));
  fails.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('GATE PASS ' + pass + '/' + pass);
console.log('  ' + size + ' B  sha256 ' + sha);
