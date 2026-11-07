/* Booklet core: pure layout math (no DOM access). */
/*==CORE-START==*/
(function (root) {
  'use strict';

  var PAPER = {
    A4: { w: 297, h: 210 },
    A3: { w: 420, h: 297 },
    Letter: { w: 279.4, h: 215.9 }
  };

  var DEFAULTS = {
    paper: 'A4',
    dpi: 300,
    gutter: 6,
    safe: 4,
    mirror: false,
    reverse: false,
    autoSplit: true,
    maxSheets: 20,
    rangeFrom: 1,
    rangeTo: 0,
    printMode: 'vector',
    coverMode: 'page'
  };

  var COVER_MODES = ['page', 'custom', 'blank'];

  var DPI_LIST = [200, 300, 400];

  function num(v, d) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : d;
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function intOr(v, d) {
    var n = Math.round(num(v, d));
    return isFinite(n) ? n : d;
  }

  function boolOr(v, d) {
    if (v === true || v === 'true' || v === 1 || v === '1') return true;
    if (v === false || v === 'false' || v === 0 || v === '0') return false;
    return d;
  }

  function sanitizeCfg(src, pageCount) {
    src = src || {};
    var cfg = {
      paper: PAPER[src.paper] ? src.paper : DEFAULTS.paper,
      dpi: DPI_LIST.indexOf(+src.dpi) >= 0 ? +src.dpi : DEFAULTS.dpi,
      gutter: clamp(num(src.gutter, DEFAULTS.gutter), 0, 30),
      safe: clamp(num(src.safe, DEFAULTS.safe), 0, 20),
      mirror: boolOr(src.mirror, DEFAULTS.mirror),
      reverse: boolOr(src.reverse, DEFAULTS.reverse),
      autoSplit: boolOr(src.autoSplit, DEFAULTS.autoSplit),
      maxSheets: clamp(intOr(src.maxSheets, DEFAULTS.maxSheets), 4, 50),
      rangeFrom: Math.max(1, intOr(src.rangeFrom, 1)),
      rangeTo: Math.max(0, intOr(src.rangeTo, 0)),
      printMode: src.printMode === 'raster' ? 'raster' : DEFAULTS.printMode,
      coverMode: COVER_MODES.indexOf(src.coverMode) >= 0 ? src.coverMode : DEFAULTS.coverMode
    };
    if (pageCount > 0) {
      cfg.rangeFrom = clamp(cfg.rangeFrom, 1, pageCount);
      if (cfg.rangeTo <= 0 || cfg.rangeTo > pageCount) cfg.rangeTo = pageCount;
      if (cfg.rangeTo < cfg.rangeFrom) {
        var t0 = cfg.rangeFrom;
        cfg.rangeFrom = cfg.rangeTo;
        cfg.rangeTo = t0;
      }
    }
    return cfg;
  }

  function sheetSize(cfg) {
    var p = PAPER[cfg.paper] || PAPER.A4;
    return { w: p.w, h: p.h };
  }

  /* Sheet is always landscape; the gutter is reserved around the fold line. */
  function geometry(cfg) {
    var s = sheetSize(cfg);
    var g = clamp(num(cfg.gutter, DEFAULTS.gutter), 0, 30);
    var half = s.w / 2;
    return {
      sheet: { w: s.w, h: s.h },
      gutter: g,
      left: { x: 0, y: 0, w: half - g / 2, h: s.h },
      right: { x: half + g / 2, y: 0, w: half - g / 2, h: s.h }
    };
  }

  function planRange(pageCount, cfg) {
    var from = clamp(intOr(cfg.rangeFrom, 1), 1, pageCount);
    var to = clamp(intOr(cfg.rangeTo, pageCount), 1, pageCount);
    if (to < from) {
      var tmp = from;
      from = to;
      to = tmp;
    }
    var selected = to - from + 1;
    var N = 4 * Math.ceil(selected / 4);
    var S = N / 4;
    var chunk = cfg.maxSheets * 4;
    var chunks = [];
    if (cfg.autoSplit && selected > chunk) {
      for (var start = 0; start < selected; start += chunk) {
        chunks.push({ start: start, count: Math.min(chunk, selected - start) });
      }
    } else {
      chunks.push({ start: 0, count: selected });
    }
    var volumes = chunks.map(function (ch) {
      var vN = 4 * Math.ceil(ch.count / 4);
      return {
        start: ch.start,
        count: ch.count,
        N: vN,
        S: vN / 4,
        from: from + ch.start,
        to: from + ch.start + ch.count - 1
      };
    });
    return {
      pageCount: pageCount,
      from: from,
      to: to,
      selected: selected,
      N: N,
      S: S,
      padded: N - selected,
      volumes: volumes,
      thick: volumes.some(function (v) { return v.S > 25; })
    };
  }

  function sourcePage(vol, local) {
    if (local == null || local < 1 || local > vol.count) return null;
    return vol.from + local - 1;
  }

  function sheetSlots(k, N) {
    return {
      front: { left: N - 2 * (k - 1), right: 2 * k - 1 },
      back: { left: 2 * k, right: N - 2 * k + 1 }
    };
  }

  function jobsForVolume(vol, cfg) {
    var front = [];
    var back = [];
    var k;
    var s;
    var b;
    for (k = 1; k <= vol.S; k++) {
      s = sheetSlots(k, vol.N);
      front.push({
        k: k,
        left: sourcePage(vol, s.front.left),
        right: sourcePage(vol, s.front.right)
      });
    }
    for (k = 1; k <= vol.S; k++) {
      b = sheetSlots(k, vol.N).back;
      var l = sourcePage(vol, b.left);
      var r = sourcePage(vol, b.right);
      back.push({
        k: k,
        left: cfg.mirror ? r : l,
        right: cfg.mirror ? l : r
      });
    }
    if (cfg.reverse) back.reverse();
    return { front: front, back: back };
  }

  /* Jacket: outside face of the separate cover sheet: back cover left, front cover right.
     Sides are tokens ('front' / 'back'); null means that panel stays blank. */
  function jacketSheet(hasFront, hasBack) {
    return [{ k: 1, left: hasBack ? 'back' : null, right: hasFront ? 'front' : null }];
  }

  /* Fit a page (size in pt) into a panel (size in mm), centered, keeping ratio. */
  function fitPage(pageWpt, pageHpt, panelWmm, panelHmm) {
    var pwPt = panelWmm * 72 / 25.4;
    var phPt = panelHmm * 72 / 25.4;
    var f = Math.min(pwPt / pageWpt, phPt / pageHpt);
    var wmm = pageWpt * f * 25.4 / 72;
    var hmm = pageHpt * f * 25.4 / 72;
    return {
      f: f,
      wmm: wmm,
      hmm: hmm,
      xmm: (panelWmm - wmm) / 2,
      ymm: (panelHmm - hmm) / 2
    };
  }

  function pageNumbers(job) {
    var out = [];
    job.forEach(function (s) {
      [s.left, s.right].forEach(function (p) {
        if (p != null) out.push(p);
      });
    });
    out.sort(function (a, b) { return a - b; });
    return out.filter(function (v, i) { return i === 0 || v !== out[i - 1]; });
  }

  var api = {
    PAPER: PAPER,
    DEFAULTS: DEFAULTS,
    DPI_LIST: DPI_LIST,
    COVER_MODES: COVER_MODES,
    num: num,
    clamp: clamp,
    sanitizeCfg: sanitizeCfg,
    sheetSize: sheetSize,
    geometry: geometry,
    planRange: planRange,
    sourcePage: sourcePage,
    sheetSlots: sheetSlots,
    jobsForVolume: jobsForVolume,
    jacketSheet: jacketSheet,
    fitPage: fitPage,
    pageNumbers: pageNumbers
  };

  root.BookletCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
/*==CORE-END==*/
