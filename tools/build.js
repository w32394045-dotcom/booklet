/* Build booklet.html from src/ + locales/ + vendor/, with strict validation. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const src = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const errors = [];
const fail = (m) => errors.push(m);

const head = src('src/head.html');
const style = src('src/style.css');
const body = src('src/body.html');
const core = src('src/core.js');
const app = src('src/app.js');
const i18n = JSON.parse(src('locales/i18n.json'));

/* Drop sourcemap directives: they would trigger blocked connect-src requests in the signed build. */
const stripMap = (s) => s.replace(/\n?\/\/# sourceMappingURL=[^\n]*/g, '');
const lib = stripMap(src('vendor/pdf.min.js'));
const worker = stripMap(src('vendor/pdf.worker.min.js'));
const pdflib = stripMap(src('vendor/pdf-lib.min.js'));

const LOCALES = ['zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'en'];
const ALLOWED_HOSTS = ['md2pdf.xszx.cc.cd', 'imgprint.xszx.cc.cd', 'github.com', 'www.w3.org'];
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/* ---- locales ---- */
const dicts = i18n.locales || {};
if (Object.keys(dicts).length !== LOCALES.length) fail('locale count ' + Object.keys(dicts).length);
LOCALES.forEach((lc) => {
  if (!dicts[lc]) fail('missing locale ' + lc);
});
const base = dicts.en;
const keys = Object.keys(base).sort();
if (keys.length < 60) fail('too few i18n keys: ' + keys.length);
LOCALES.forEach((lc) => {
  const d = dicts[lc] || {};
  const kk = Object.keys(d).sort();
  if (JSON.stringify(kk) !== JSON.stringify(keys)) fail('key mismatch in ' + lc);
  keys.forEach((k) => {
    const v = d[k];
    if (typeof v !== 'string' || !v.trim()) fail('empty value ' + lc + '.' + k);
    const ph = (s) => (s.match(/\{\d+\}/g) || []).sort().join(',');
    if (ph(v) !== ph(base[k])) fail('placeholder mismatch ' + lc + '.' + k + ' [' + ph(v) + ' vs ' + ph(base[k]) + ']');
  });
});
Object.keys(i18n.langNames || {}).forEach((lc) => {
  if (LOCALES.indexOf(lc) < 0) fail('extra langName ' + lc);
});
LOCALES.forEach((lc) => {
  if (!(i18n.langNames || {})[lc]) fail('missing langName ' + lc);
});

/* ---- i18n usage ---- */
const used = new Set();
const attrRe = /data-i18n(?:-[a-z]+)?="([^"]+)"/g;
let m;
while ((m = attrRe.exec(body))) used.add(m[1]);
const tRe = /\bt\('([^']+)'/g;
while ((m = tRe.exec(app))) used.add(m[1]);
for (const k of used) if (!base[k]) fail('unknown i18n key used: ' + k);
for (const k of keys) if (!used.has(k)) fail('unused i18n key: ' + k);

/* ---- no CJK outside locales ---- */
[['head.html', head], ['style.css', style], ['body.html', body], ['core.js', core], ['app.js', app]].forEach(([n, s]) => {
  if (CJK.test(s)) fail('CJK found outside i18n files in ' + n);
});

/* ---- external URLs ---- */
[['head.html', head], ['body.html', body], ['style.css', style], ['core.js', core], ['app.js', app]].forEach(([n, s]) => {
  const urls = s.match(/https?:\/\/[^\s"'<>)]+/g) || [];
  urls.forEach((u) => {
    const host = u.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
    if (ALLOWED_HOSTS.indexOf(host) < 0) fail('unexpected external URL in ' + n + ': ' + u);
  });
});

/* ---- syntax ---- */
try { new vm.Script(core, { filename: 'core.js' }); } catch (e) { fail('core.js syntax: ' + e.message); }
try { new vm.Script(app, { filename: 'app.js' }); } catch (e) { fail('app.js syntax: ' + e.message); }

/* ---- vendor safety ---- */
if (/<\/script/i.test(lib)) fail('pdf.min.js contains </script');
if (/<\/script/i.test(worker)) fail('pdf.worker.min.js contains </script');
if (/<\/script/i.test(pdflib)) fail('pdf-lib.min.js contains </script');
if (lib.indexOf('sourceMappingURL') >= 0 || worker.indexOf('sourceMappingURL') >= 0 || pdflib.indexOf('sourceMappingURL') >= 0) fail('sourceMappingURL not stripped');
if (lib.length < 300000) fail('pdf.min.js too small');
if (worker.length < 900000) fail('pdf.worker.min.js too small');
if (pdflib.length < 400000) fail('pdf-lib.min.js too small');
if (pdflib.indexOf('PDFLib') < 0) fail('pdf-lib global missing');

/* ---- required structure ---- */
[['id="app"', body], ['id="printRoot"', body], ['id="pageStyle"', body], ['id="modeBar"', body],
 ['id="dpiField"', body], ['id="pdfLinks"', body],
 ['id="btnFront"', body], ['id="btnBack"', body], ['id="btnJacket"', body], ['id="gutterRange"', body],
 ['id="coverFrontInput"', body], ['id="coverBackInput"', body], ['id="coverFrontClear"', body],
 ['id="coverBackClear"', body], ['id="coverFrontPrev"', body], ['id="coverBackPrev"', body],
 ['id="coverModeBar"', body], ['id="coverGrid"', body], ['id="coverHintCustom"', body],
 ['id="coverErr"', body], ['id="prevFront"', body], ['id="prevBack"', body], ['id="prevJacket"', body],
 ['id="jacketPane"', body], ['id="langSel"', body], ['id="statText"', body]].forEach(([needle, s]) => {
  if (s.indexOf(needle) < 0) fail('missing ' + needle);
});
if (body.indexOf('type="file"') < 0 && body.indexOf("type=file") < 0) fail('missing file input');
if (app.indexOf('window.print()') < 0) fail('app does not call window.print()');
if (/window\.open\s*\(/.test(app)) fail('app must not open popup windows');
if (app.indexOf('@page{size:') < 0) fail('app does not set @page size');
if (app.indexOf('window.PDFLib') < 0) fail('app does not use the inlined PDFLib global');

/* ---- assemble ---- */
const styleTag = '<style>' + style + '</style>';
let html = head.replace('</head>', styleTag + '</head>') + body;
const i18nScript = '<script>window.__I18N=' + JSON.stringify(dicts) +
  ';window.__LANG_NAMES=' + JSON.stringify(i18n.langNames || {}) + ';</script>';
const licence = '<!-- PDF.js v3.11.174 - Apache-2.0 - https://mozilla.github.io/pdf.js/ (inlined; sourcemap directive stripped) -->\n' +
  '<!-- pdf-lib v1.17.1 - MIT - https://pdf-lib.js.org/ (inlined; sourcemap directive stripped) -->';
const workerBlock = '<script id="pdfWorkerSrc" type="text/plain">' + worker + '</script>';
const scripts = '\n' + i18nScript + '\n' + workerBlock + '\n' + licence + '\n' +
  '<script>' + lib + '</script>\n' +
  '<script>' + pdflib + '</script>\n' +
  '<script>' + core + '</script>\n' +
  '<script>' + app + '</script>\n';
html = html.replace('</body>', scripts + '</body>');

if (errors.length) {
  console.error('BUILD FAILED (' + errors.length + '):');
  errors.slice(0, 40).forEach((e) => console.error('  - ' + e));
  process.exit(1);
}

const out = path.join(root, 'index.html');
fs.writeFileSync(out, html, 'utf8');
const sha = crypto.createHash('sha256').update(html).digest('hex');
console.log('built ' + out);
console.log('  size   ' + Buffer.byteLength(html) + ' B');
console.log('  sha256 ' + sha);
console.log('  i18n   ' + keys.length + ' keys x ' + LOCALES.length + ' locales');
console.log('  pdf.js inline ' + lib.length + ' B, worker ' + worker.length + ' B, pdf-lib ' + pdflib.length + ' B');
