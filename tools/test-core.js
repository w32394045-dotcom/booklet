/* Unit tests for the pure imposition core (extracted from src/core.js). */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src', 'core.js'), 'utf8');
const m = src.match(/\/\*==CORE-START==\*\/([\s\S]*?)\/\*==CORE-END==\*\//);
if (!m) { console.error('CORE markers missing'); process.exit(1); }
const ctx = {};
vm.createContext(ctx);
vm.runInContext(m[1], ctx);
const C = ctx.BookletCore;

let pass = 0;
const fails = [];
function ok(cond, name, extra) {
  if (cond) { pass++; } else { fails.push(name + (extra ? ' :: ' + extra : '')); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, JSON.stringify(a) + ' != ' + JSON.stringify(b)); }
function approx(a, b, name, tol) {
  tol = tol == null ? 0.05 : tol;
  ok(Math.abs(a - b) <= tol, name, a + ' ~ ' + b);
}

/* sanitize */
const d = C.sanitizeCfg(null, 0);
eq(d.paper, 'A4', 'default paper');
eq(d.dpi, 300, 'default dpi');
eq(d.gutter, 6, 'default gutter');
eq(d.autoSplit, true, 'default autoSplit');
eq(d.maxSheets, 20, 'default maxSheets');
eq(d.rangeFrom, 1, 'default rangeFrom');
eq(d.rangeTo, 0, 'default rangeTo');
eq(d.printMode, 'vector', 'default printMode');
eq(C.sanitizeCfg({ printMode: 'raster' }, 0).printMode, 'raster', 'printMode raster');
eq(C.sanitizeCfg({ printMode: 'weird' }, 0).printMode, 'vector', 'printMode fallback');
eq(C.sanitizeCfg(null, 0).coverMode, 'page', 'default coverMode page');
eq(C.sanitizeCfg({ coverMode: 'custom' }, 0).coverMode, 'custom', 'coverMode custom');
eq(C.sanitizeCfg({ coverMode: 'blank' }, 0).coverMode, 'blank', 'coverMode blank');
eq(C.sanitizeCfg({ coverMode: 'weird' }, 0).coverMode, 'page', 'coverMode fallback');
eq(C.sanitizeCfg(null, 0).safe, 4, 'default safety margin 4mm');
eq(C.sanitizeCfg({ safe: 0 }, 0).safe, 0, 'safety margin 0 allowed');
eq(C.sanitizeCfg({ safe: 99 }, 0).safe, 20, 'safety margin clamp high');
eq(C.sanitizeCfg({ safe: -3 }, 0).safe, 0, 'safety margin clamp low');

const s1 = C.sanitizeCfg({ gutter: 99, dpi: 123, maxSheets: 2, paper: 'X9' }, 0);
eq(s1.gutter, 30, 'gutter clamp high');
eq(s1.dpi, 300, 'dpi fallback');
eq(s1.maxSheets, 4, 'maxSheets clamp low');
eq(s1.paper, 'A4', 'paper fallback');
eq(C.sanitizeCfg({ gutter: -5 }, 0).gutter, 0, 'gutter clamp low');
eq(C.sanitizeCfg({ maxSheets: 99 }, 0).maxSheets, 50, 'maxSheets clamp high');
eq(C.sanitizeCfg({ dpi: 400 }, 0).dpi, 400, 'dpi 400 ok');
eq(C.sanitizeCfg({ mirror: 'true', reverse: '1', autoSplit: 'false' }, 0).mirror, true, 'string bool true');
eq(C.sanitizeCfg({ mirror: 'true', reverse: '1', autoSplit: 'false' }, 0).reverse, true, 'string 1 bool');
eq(C.sanitizeCfg({ autoSplit: 'false' }, 0).autoSplit, false, 'string false bool');
eq(C.sanitizeCfg({ rangeFrom: 30, rangeTo: 10 }, 100).rangeFrom, 10, 'rangeFrom swaps');
eq(C.sanitizeCfg({ rangeFrom: 30, rangeTo: 10 }, 100).rangeTo, 30, 'rangeTo swaps');
eq(C.sanitizeCfg({ rangeFrom: 300 }, 100).rangeFrom, 100, 'rangeFrom clamp pageCount');
eq(C.sanitizeCfg({ rangeTo: 999 }, 100).rangeTo, 100, 'rangeTo clamp pageCount');
eq(C.sanitizeCfg({ rangeFrom: 5, rangeTo: 0 }, 100).rangeTo, 100, 'rangeTo 0 -> all');

/* paper */
eq(C.sheetSize(C.sanitizeCfg({ paper: 'A4' }, 0)), { w: 297, h: 210 }, 'A4 sheet');
eq(C.sheetSize(C.sanitizeCfg({ paper: 'A3' }, 0)), { w: 420, h: 297 }, 'A3 sheet');
eq(C.sheetSize(C.sanitizeCfg({ paper: 'Letter' }, 0)), { w: 279.4, h: 215.9 }, 'Letter sheet');

/* geometry */
const g0 = C.geometry(C.sanitizeCfg({ gutter: 0 }, 0));
eq(g0.sheet, { w: 297, h: 210 }, 'geo sheet');
approx(g0.left.w, 148.5, 'geo g0 left w');
eq(g0.left.x, 0, 'geo g0 left x');
approx(g0.right.x, 148.5, 'geo g0 right x');
approx(g0.right.w, 148.5, 'geo g0 right w');
const g6 = C.geometry(C.sanitizeCfg({ gutter: 6 }, 0));
approx(g6.left.w, 145.5, 'geo g6 left w');
approx(g6.right.x, 151.5, 'geo g6 right x');
approx(g6.left.w + g6.right.w + 6, 297, 'gutter accounted');
const g40 = C.geometry(C.sanitizeCfg({ gutter: 40 }, 0));
approx(g40.left.w, 133.5, 'geometry clamps gutter');
const g3 = C.geometry(C.sanitizeCfg({ paper: 'A3', gutter: 0 }, 0));
approx(g3.left.w, 210, 'A3 panel width');
approx(g3.sheet.h, 297, 'A3 sheet height');

/* fit */
const f0 = C.fitPage(595.28, 841.89, 148.5, 210);
approx(f0.wmm, 148.5, 'fit A4->A5 wmm', 0.1);
approx(f0.hmm, 210, 'fit A4->A5 hmm', 0.1);
approx(f0.xmm, 0, 'fit x', 0.1);
approx(f0.ymm, 0, 'fit y', 0.1);
const f1 = C.fitPage(612, 792, 148.5, 210); /* letter page into A5 panel */
ok(f1.hmm <= 210 + 0.01 && f1.wmm <= 148.5 + 0.01, 'fit contains page');
approx(f1.xmm * 2 + f1.wmm, 148.5, 'fit centered x', 0.01);
approx(f1.ymm * 2 + f1.hmm, 210, 'fit centered y', 0.01);

/* plans */
const p12 = C.planRange(12, C.sanitizeCfg({}, 12));
eq([p12.from, p12.to, p12.selected, p12.N, p12.S, p12.padded, p12.volumes.length], [1, 12, 12, 12, 3, 0, 1], 'plan 12');
const p10 = C.planRange(10, C.sanitizeCfg({}, 10));
eq([p10.N, p10.S, p10.padded], [12, 3, 2], 'plan 10 padded');
const p1 = C.planRange(1, C.sanitizeCfg({}, 1));
eq([p1.N, p1.S, p1.padded], [4, 1, 3], 'plan 1');
const p8 = C.planRange(8, C.sanitizeCfg({}, 8));
eq([p8.N, p8.S], [8, 2], 'plan 8');
const p104 = C.planRange(104, C.sanitizeCfg({ autoSplit: false }, 104));
eq([p104.N, p104.S], [104, 26], 'plan 104');
eq(p104.thick, true, 'plan thick flag');
eq(p8.thick, false, 'plan not thick flag');
const p104s = C.planRange(104, C.sanitizeCfg({}, 104));
eq(p104s.volumes.length, 2, 'plan 104 auto split');
eq([p104s.volumes[0].S, p104s.volumes[1].S], [20, 6], 'plan 104 split sizes');

const cfgRange = C.sanitizeCfg({ rangeFrom: 5, rangeTo: 104, maxSheets: 20 }, 400);
const pr = C.planRange(400, cfgRange);
eq([pr.from, pr.to, pr.selected, pr.N, pr.S, pr.volumes.length], [5, 104, 100, 100, 25, 2], 'plan range 5-104');
eq(pr.volumes[0].from, 5, 'vol1 from');
eq([pr.volumes[0].count, pr.volumes[0].N, pr.volumes[0].S, pr.volumes[0].to], [80, 80, 20, 84], 'vol1 sizes');
eq(pr.volumes[1].from, 85, 'vol2 from');
eq([pr.volumes[1].count, pr.volumes[1].N, pr.volumes[1].S, pr.volumes[1].to], [20, 20, 5, 104], 'vol2 sizes');
const sumSel = pr.volumes.reduce((a, v) => a + v.count, 0);
eq(sumSel, 100, 'volumes sum selected');
const prNo = C.planRange(400, C.sanitizeCfg({ rangeFrom: 5, rangeTo: 104, autoSplit: false }, 400));
eq(prNo.volumes.length, 1, 'no split one volume');
eq(prNo.volumes[0].S, 25, 'no split sheets');
const pSwap = C.planRange(100, C.sanitizeCfg({ rangeFrom: 30, rangeTo: 10 }, 100));
eq([pSwap.from, pSwap.to, pSwap.selected], [10, 30, 21], 'range swaps');

/* slots */
eq(C.sheetSlots(1, 8), { front: { left: 8, right: 1 }, back: { left: 2, right: 7 } }, 'slots k1 N8');
eq(C.sheetSlots(2, 8), { front: { left: 6, right: 3 }, back: { left: 4, right: 5 } }, 'slots k2 N8');

/* jobs full doc */
const vol8 = p8.volumes[0];
const j8 = C.jobsForVolume(vol8, C.sanitizeCfg({}, 8));
eq(j8.front, [{ k: 1, left: 8, right: 1 }, { k: 2, left: 6, right: 3 }], 'jobs 8 front');
eq(j8.back, [{ k: 1, left: 2, right: 7 }, { k: 2, left: 4, right: 5 }], 'jobs 8 back');
j8.front.forEach((s) => ok(s.left + s.right === 9, 'front pair sums N+1'));
j8.back.forEach((s) => ok(s.left + s.right === 9, 'back pair sums N+1'));

const vol12 = p12.volumes[0];
const j12 = C.jobsForVolume(vol12, C.sanitizeCfg({}, 12));
eq(j12.front.map((s) => [s.left, s.right]), [[12, 1], [10, 3], [8, 5]], 'jobs 12 front');
eq(j12.back.map((s) => [s.left, s.right]), [[2, 11], [4, 9], [6, 7]], 'jobs 12 back');

const jm = C.jobsForVolume(vol8, C.sanitizeCfg({ mirror: true }, 8));
eq(jm.back, [{ k: 1, left: 7, right: 2 }, { k: 2, left: 5, right: 4 }], 'jobs mirror back');
const jr = C.jobsForVolume(vol8, C.sanitizeCfg({ reverse: true }, 8));
eq(jr.back.map((s) => [s.left, s.right]), [[4, 5], [2, 7]], 'jobs reverse back');
eq(jr.front.map((s) => [s.left, s.right]), [[8, 1], [6, 3]], 'reverse keeps front');
const jmr = C.jobsForVolume(vol8, C.sanitizeCfg({ mirror: true, reverse: true }, 8));
eq(jmr.back.map((s) => [s.left, s.right]), [[5, 4], [7, 2]], 'jobs mirror+reverse');

/* blanks */
const vol10 = p10.volumes[0];
const j10 = C.jobsForVolume(vol10, C.sanitizeCfg({}, 10));
eq(j10.front[0], { k: 1, left: null, right: 1 }, 'blank front 12');
eq(j10.back[0], { k: 1, left: 2, right: null }, 'blank back 11');
eq(j10.back[2], { k: 3, left: 6, right: 7 }, 'last back pair');
const used10 = C.pageNumbers(j10.front).concat(C.pageNumbers(j10.back));
eq(used10.indexOf(null), -1, 'no null pages in pageNumbers');
eq(JSON.stringify(C.pageNumbers(j10.front).concat(C.pageNumbers(j10.back)).sort((a, b) => a - b)),
  JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 'pages 1..10 used exactly once');
eq(C.pageNumbers(j10.front).length + C.pageNumbers(j10.back).length, 10, 'page count');

/* volume local mapping */
eq(C.sourcePage({ from: 85, count: 20 }, 1), 85, 'sourcePage first');
eq(C.sourcePage({ from: 85, count: 20 }, 20), 104, 'sourcePage last');
eq(C.sourcePage({ from: 85, count: 20 }, 21), null, 'sourcePage blank');
eq(C.sourcePage({ from: 85, count: 20 }, null), null, 'sourcePage null');

/* jacket */
eq(C.jacketSheet(false, false), [{ k: 1, left: null, right: null }], 'jacket blank');
eq(C.jacketSheet(true, false), [{ k: 1, left: null, right: 'front' }], 'jacket front only');
eq(C.jacketSheet(false, true), [{ k: 1, left: 'back', right: null }], 'jacket back only');
eq(C.jacketSheet(true, true), [{ k: 1, left: 'back', right: 'front' }], 'jacket front+back');

if (fails.length) {
  console.error('CORE TESTS FAILED: ' + fails.length + ' / ' + (pass + fails.length));
  fails.forEach((f) => console.error('  - ' + f));
  process.exit(1);
}
console.log('CORE TESTS PASS ' + pass + '/' + pass);
