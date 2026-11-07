/* Booklet app: pdf.js page rendering + direct-print imposition. */
(function () {
  'use strict';

  var C = window.BookletCore;
  var PL = window.PDFLib;
  var I18N = window.__I18N || {};
  var LANG_NAMES = window.__LANG_NAMES || {};
  var LANGS = ['zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'en'];
  var LS_LANG = 'booklet.lang.v1';
  var LS_CFG = 'booklet.cfg.v1';
  var LS_STATS = 'booklet.stats.v1';

  var state = {
    pdf: null,
    pdfName: '',
    pdfSize: 0,
    pdfBytes: null,
    pdfLibDoc: null,
    pageCount: 0,
    covers: { front: newCover(), back: newCover() },
    cfg: null,
    plan: null,
    vol: 0,
    done: {},
    stats: { front: 0, back: 0, jacket: 0, sheets: 0 },
    thumbs: {},
    thumbSig: '',
    thumbToken: 0,
    thumbError: '',
    previewSig: '',
    previewJobs: null,
    marginLast: { t: 4, r: 4, b: 4, l: 4 },
    quality: null,
    busy: false,
    printing: false,
    printCtx: null,
    vectorUrls: []
  };

  function newCover() {
    return { kind: '', name: '', thumb: '', err: '', img: null, pdf: null, libDoc: null };
  }

  var lang = 'en';

  function $(id) { return document.getElementById(id); }

  function t(key) {
    var dict = I18N[lang] || I18N.en || {};
    var s = dict[key];
    if (s == null) s = (I18N.en || {})[key];
    if (s == null) return key;
    for (var i = 1; i < arguments.length; i++) {
      s = s.split('{' + (i - 1) + '}').join(String(arguments[i]));
    }
    return s;
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function load(k) {
    try {
      var s = localStorage.getItem(k);
      return s ? JSON.parse(s) : null;
    } catch (e) { return null; }
  }
  function yieldUI() { return new Promise(function (r) { setTimeout(r, 0); }); }

  function bytesText(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  function showBusy(text) {
    $('busyText').textContent = text || t('print.busy');
    $('busy').classList.remove('hidden');
  }
  function hideBusy() { $('busy').classList.add('hidden'); }

  function showFileError(msg) {
    $('fileErr').textContent = msg;
    $('fileErr').classList.remove('hidden');
  }

  /* ---------------- i18n ---------------- */

  function applyI18n() {
    var nodes = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    }
    document.documentElement.lang = lang;
    document.title = t('app.title');
    var sel = $('langSel');
    sel.innerHTML = '';
    LANGS.forEach(function (code) {
      var o = document.createElement('option');
      o.value = code;
      o.textContent = LANG_NAMES[code] || code;
      sel.appendChild(o);
    });
    sel.value = lang;
    renderRangeInfo();
    renderPlanBar();
    renderSteps();
    renderStats();
    renderQualityHint();
  }

  function detectLang() {
    var stored = null;
    try { stored = localStorage.getItem(LS_LANG); } catch (e) {}
    if (stored && I18N[stored]) return stored;
    var nav = (navigator.language || 'en').toLowerCase();
    if (nav.indexOf('zh') === 0) {
      if (nav.indexOf('tw') >= 0 || nav.indexOf('hk') >= 0 || nav.indexOf('hant') >= 0) return 'zh-TW';
      return 'zh-CN';
    }
    var two = nav.slice(0, 2);
    if (I18N[two]) return two;
    return 'en';
  }

  function setLang(code) {
    if (!I18N[code]) return;
    lang = code;
    try { localStorage.setItem(LS_LANG, code); } catch (e) {}
    applyI18n();
    renderPreviews();
  }

  /* ---------------- config inputs ---------------- */

  function cfgFromInputs() {
    var on = $('safeChk').checked;
    var mT = on ? parseFloat($('mTop').value) : 0;
    var mR = on ? parseFloat($('mRight').value) : 0;
    var mB = on ? parseFloat($('mBottom').value) : 0;
    var mL = on ? parseFloat($('mLeft').value) : 0;
    return C.sanitizeCfg({
      paper: $('paperSel').value,
      dpi: +$('dpiSel').value,
      gutter: parseFloat($('gutterNum').value),
      safe: on ? Math.max(mT, mR, mB, mL) : 0,
      mTop: mT,
      mRight: mR,
      mBottom: mB,
      mLeft: mL,
      mirror: $('mirrorChk').checked,
      reverse: $('reverseChk').checked,
      autoSplit: $('splitChk').checked,
      maxSheets: parseInt($('maxSheets').value, 10),
      rangeFrom: parseInt($('rangeFrom').value, 10),
      rangeTo: parseInt($('rangeTo').value, 10)
    }, state.pageCount);
  }

  function syncInputs(cfg) {
    $('paperSel').value = cfg.paper;
    $('dpiSel').value = String(cfg.dpi);
    $('gutterRange').value = String(cfg.gutter);
    $('gutterNum').value = String(cfg.gutter);
    var m = { t: cfg.mTop, r: cfg.mRight, b: cfg.mBottom, l: cfg.mLeft };
    var safeOn = !!(m.t || m.r || m.b || m.l);
    if (safeOn) state.marginLast = m;
    $('safeChk').checked = safeOn;
    $('mTop').value = String(safeOn ? m.t : state.marginLast.t);
    $('mRight').value = String(safeOn ? m.r : state.marginLast.r);
    $('mBottom').value = String(safeOn ? m.b : state.marginLast.b);
    $('mLeft').value = String(safeOn ? m.l : state.marginLast.l);
    ['mTop', 'mRight', 'mBottom', 'mLeft'].forEach(function (id) { $(id).disabled = !safeOn; });
    $('mirrorChk').checked = cfg.mirror;
    $('reverseChk').checked = cfg.reverse;
    $('splitChk').checked = cfg.autoSplit;
    $('maxSheets').value = String(cfg.maxSheets);
    $('rangeFrom').value = String(cfg.rangeFrom);
    $('rangeTo').value = state.pageCount ? String(cfg.rangeTo) : '';
    $('rangeFrom').max = String(state.pageCount || 1);
    $('rangeTo').max = String(state.pageCount || 1);
  }

  function onCfgChange() {
    state.cfg = cfgFromInputs();
    state.done = {};
    recalc();
  }

  /* Gutter/margins only shift content inside the panel; no re-imposition, no preview rebuild. */
  function onGutterChange() {
    state.cfg = cfgFromInputs();
    var m = { t: state.cfg.mTop, r: state.cfg.mRight, b: state.cfg.mBottom, l: state.cfg.mLeft };
    if (m.t || m.r || m.b || m.l) state.marginLast = m;
    save(LS_CFG, state.cfg);
    updatePreviewStyle();
  }

  function recalc() {
    if (!state.pdf) {
      state.plan = null;
      syncInputs(state.cfg);
      renderRangeInfo();
      renderPlanBar();
      renderPreviews();
      renderSteps();
      updateCoverModeUi();
      return;
    }
    state.cfg = C.sanitizeCfg(state.cfg, state.pageCount);
    syncInputs(state.cfg);
    state.plan = C.planRange(state.pageCount, state.cfg);
    if (state.vol >= state.plan.volumes.length) state.vol = 0;
    save(LS_CFG, state.cfg);
    renderRangeInfo();
    renderPlanBar();
    renderVolChips();
    renderPreviews();
    renderSteps();
    updateCoverModeUi();
    maybeThumbs();
  }

  function renderRangeInfo() {
    var el = $('rangeInfo');
    if (!el) return;
    el.textContent = state.pageCount ? t('set.rangeInfo', state.pageCount) : '';
  }

  /* ---------------- summaries / stats ---------------- */

  function renderPlanBar() {
    var el = $('planBar');
    if (!state.plan) {
      el.innerHTML = '<span class="big">' + esc(t('plan.none')) + '</span>';
      return;
    }
    var p = state.plan;
    var html = '<div class="big">' + esc(t('plan.main', p.selected, p.N, p.volumes[0].S)) + '</div>';
    if (p.padded) html += '<div class="vols">' + esc(t('plan.pad', p.padded)) + '</div>';
    if (p.volumes.length > 1) {
      var parts = p.volumes.map(function (v, i) {
        return t('plan.volItem', i + 1, v.from, v.to, v.S);
      });
      html += '<div class="vols">' + esc(t('plan.volumes', p.volumes.length)) + ' ' + esc(parts.join('  /  ')) + '</div>';
    }
    if (p.thick) html += '<div class="warn">' + esc(t('plan.thick', p.volumes[0].S)) + '</div>';
    el.innerHTML = html;
  }

  function renderStats() {
    var s = state.stats;
    $('statText').textContent = t('counter.text', s.front, s.back, s.jacket, s.sheets);
  }

  function loadStats() {
    var s = load(LS_STATS) || {};
    return {
      front: +s.front || 0,
      back: +s.back || 0,
      jacket: +s.jacket || 0,
      sheets: +s.sheets || 0
    };
  }
  function saveStats() { save(LS_STATS, state.stats); }

  /* ---------------- preview ---------------- */

  function revokeUrl(u) {
    if (!u) return;
    try { URL.revokeObjectURL(u); } catch (e) {}
  }

  function clearThumbs() {
    Object.keys(state.thumbs).forEach(function (k) { revokeUrl(state.thumbs[k]); });
    state.thumbs = {};
  }

  function hasAnyCover() {
    return !!(state.covers.front.kind || state.covers.back.kind);
  }

  function coverMode() {
    return (state.cfg && state.cfg.coverMode) || 'page';
  }

  /* page: no jacket pass (page 1 is the cover); custom: uploaded front/back; blank: one empty jacket sheet. */
  function jacketSides() {
    var mode = coverMode();
    if (mode === 'page') return [];
    if (mode === 'blank') return C.jacketSheet(false, false);
    return C.jacketSheet(!!state.covers.front.kind, !!state.covers.back.kind);
  }

  function jacketEnabled() {
    var mode = coverMode();
    if (mode === 'page') return false;
    if (mode === 'blank') return true;
    return hasAnyCover();
  }

  function paneHtml(side, pageNo, pos) {
    var cls = 'mini-pane';
    var tag = '';
    if (side) {
      tag = side === 'front' ? t('prev.coverFront') : t('prev.coverBack');
      if (!state.covers[side].kind) cls += ' blank';
    } else if (pageNo == null) {
      cls += ' blank';
    } else {
      tag = String(pageNo);
    }
    return '<div class="' + cls + '" data-side="' + esc(side || '') + '" data-pos="' + (pos || '') + '">' +
      '<span class="pg">' + esc(tag) + '</span>' +
      '<span class="pbl">' + esc(t('prev.blank')) + '</span>' +
      '<img alt="" decoding="async"></div>';
  }

  function pairLabel(s) {
    if (s.left === 'front' || s.left === 'back' || s.right === 'front' || s.right === 'back') {
      return t('prev.pair', s.left ? t('prev.coverBack') : '-', s.right ? t('prev.coverFront') : '-');
    }
    return t('prev.pair', s.left == null ? '-' : s.left, s.right == null ? '-' : s.right);
  }

  function fillSheetList(el, sheets, jacket) {
    var html = '';
    sheets.forEach(function (s) {
      html += '<div class="sheet-card" data-k="' + s.k + '">' +
        '<div class="sheet-k"><span>' + esc(t('prev.sheet', s.k)) + '</span><span>' + esc(pairLabel(s)) + '</span></div>' +
        '<div class="mini-sheet">' +
        paneHtml(jacket ? s.left : null, jacket ? null : s.left, 'left') +
        paneHtml(jacket ? s.right : null, jacket ? null : s.right, 'right') +
        '</div></div>';
    });
    el.innerHTML = html || '<div class="hint">' + esc(t('prev.empty')) + '</div>';
  }

  function previewSignature() {
    var p = state.plan;
    return [state.pageCount, p.from, p.to, p.N, p.volumes.length, state.vol,
      state.cfg.mirror ? 1 : 0, state.cfg.reverse ? 1 : 0,
      coverMode(),
      state.covers.front.kind + ':' + state.covers.front.name,
      state.covers.back.kind + ':' + state.covers.back.name,
      lang].join('|');
  }

  function updatePreviewStyle() {
    var cfg = state.cfg || C.DEFAULTS;
    var s = C.sheetSize(cfg);
    var g = C.clamp(C.num(cfg.gutter, 0), 0, 30);
    var m = margins();
    var side = Math.max(m.l, m.r);
    var pct = function (mm) { return (mm / Math.max(1, s.w) * 100).toFixed(3) + '%'; };
    var root = document.documentElement;
    root.style.setProperty('--sheet-ar', s.w + '/' + s.h);
    root.style.setProperty('--gut', (g / s.w * 100).toFixed(3) + '%');
    root.style.setProperty('--m-t', pct(m.t));
    root.style.setProperty('--m-r', pct(side));
    root.style.setProperty('--m-b', pct(m.b));
    root.style.setProperty('--m-l', pct(side));
  }

  /* Printer margins per edge (mm); page content is kept out of them. */
  function margins() {
    var cfg = state.cfg || C.DEFAULTS;
    return {
      t: C.clamp(C.num(cfg.mTop, C.DEFAULTS.mTop), 0, 30),
      r: C.clamp(C.num(cfg.mRight, C.DEFAULTS.mRight), 0, 30),
      b: C.clamp(C.num(cfg.mBottom, C.DEFAULTS.mBottom), 0, 30),
      l: C.clamp(C.num(cfg.mLeft, C.DEFAULTS.mLeft), 0, 30)
    };
  }

  /* Content rectangle inside each panel: printer margins only on the paper's outer edges,
     the fold side keeps just the gutter. */
  function contentRects() {
    var geo = C.geometry(state.cfg);
    var m = margins();
    var side = Math.max(m.l, m.r);
    var w = Math.max(20, geo.left.w - side);
    var h = Math.max(20, geo.sheet.h - m.t - m.b);
    return {
      left: { x: geo.left.x + side, y: m.b, w: w, h: h },
      right: { x: geo.right.x, y: m.b, w: w, h: h },
      side: side,
      sheet: geo.sheet
    };
  }

  function syncPane(el, side, pageNo) {
    var img = el.querySelector('img');
    var url = '';
    if (side) url = state.covers[side].kind ? state.covers[side].thumb : '';
    else if (pageNo != null) url = state.thumbs[pageNo] || '';
    if (url) {
      if (img.getAttribute('src') !== url) img.setAttribute('src', url);
      el.classList.remove('blank');
    } else {
      if (img.hasAttribute('src')) img.removeAttribute('src');
      el.classList.add('blank');
    }
  }

  function syncPreviewImages() {
    if (!state.previewJobs) return;
    var rows = [
      ['prevFront', state.previewJobs.front, false],
      ['prevBack', state.previewJobs.back, false],
      ['prevJacket', state.previewJobs.jacket, true]
    ];
    rows.forEach(function (row) {
      var cards = $(row[0]).querySelectorAll('.sheet-card');
      var sheets = row[1] || [];
      for (var i = 0; i < cards.length && i < sheets.length; i++) {
        var panes = cards[i].querySelectorAll('.mini-pane');
        if (panes.length < 2) continue;
        var s = sheets[i];
        syncPane(panes[0], row[2] ? s.left : null, row[2] ? null : s.left);
        syncPane(panes[1], row[2] ? s.right : null, row[2] ? null : s.right);
      }
    });
  }

  function renderPreviews(force) {
    $('jacketPane').classList.remove('hidden');
    updatePreviewStyle();
    if (!state.plan || !state.pdf) {
      $('prevFront').innerHTML = '';
      $('prevBack').innerHTML = '';
      $('prevJacket').innerHTML = '<div class="hint">' + esc(t('print.jacketNeed')) + '</div>';
      state.previewSig = '';
      state.previewJobs = null;
      return;
    }
    var vol = state.plan.volumes[state.vol];
    var jobs = C.jobsForVolume(vol, state.cfg);
    var jacket = jacketSides();
    state.previewJobs = { front: jobs.front, back: jobs.back, jacket: jacket };
    var sig = previewSignature();
    if (force || sig !== state.previewSig) {
      state.previewSig = sig;
      fillSheetList($('prevFront'), jobs.front, false);
      fillSheetList($('prevBack'), jobs.back, false);
      if (coverMode() === 'page') {
        $('prevJacket').innerHTML = '<div class="hint">' + esc(t('print.jacketPage')) + '</div>';
        state.previewJobs = { front: jobs.front, back: jobs.back, jacket: [] };
      } else {
        fillSheetList($('prevJacket'), jacket, true);
      }
    }
    syncPreviewImages();
  }

  function updateCoverModeUi() {
    var mode = coverMode();
    var bar = $('coverModeBar');
    if (bar) {
      var btns = bar.querySelectorAll('.covmode');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('on', btns[i].getAttribute('data-cover') === mode);
      }
    }
    var grid = $('coverGrid');
    if (grid) grid.classList.toggle('hidden', mode !== 'custom');
    var hint = $('coverHintCustom');
    if (hint) hint.classList.toggle('hidden', mode !== 'custom');
    var err = $('coverErr');
    if (err && mode !== 'custom') err.classList.add('hidden');
  }

  function setCoverMode(mode) {
    if (C.COVER_MODES.indexOf(mode) < 0) return;
    state.cfg.coverMode = mode;
    save(LS_CFG, state.cfg);
    updateCoverModeUi();
    renderPreviews(true);
    renderSteps();
  }

  function renderVolChips() {
    var box = $('volChips');
    if (!state.plan || state.plan.volumes.length < 2) { box.innerHTML = ''; return; }
    var html = '';
    state.plan.volumes.forEach(function (v, i) {
      html += '<button type="button" class="chipbtn' + (i === state.vol ? ' on' : '') + '" data-vol="' + i + '">' +
        esc(t('print.volumeLabel', i + 1, v.from, v.to)) + '</button>';
    });
    box.innerHTML = html;
  }

  function renderSteps() {
    var done = state.done[state.vol] || {};
    var vector = !(state.cfg && state.cfg.printMode === 'raster');
    [['Front', 'front'], ['Back', 'back'], ['Jacket', 'jacket']].forEach(function (pair) {
      var step = $('step' + pair[0]);
      var btn = $('btn' + pair[0]);
      var needJacket = pair[1] === 'jacket';
      step.classList.toggle('done', !!done[pair[1]]);
      btn.disabled = !state.pdf || state.busy || (needJacket && !jacketEnabled());
      btn.textContent = done[pair[1]] ? t('print.done') : (vector ? t('print.pdfBtn') : t('print.btn'));
    });
    var frontHelp = $('stepFront').querySelector('.step-s');
    if (frontHelp) {
      frontHelp.textContent = vector
        ? t('print.pdfStep1s', (state.cfg && state.cfg.paper) || 'A4')
        : t('print.step1s', (state.cfg && state.cfg.paper) || 'A4');
    }
    var dpiField = $('dpiField');
    if (dpiField) dpiField.classList.toggle('hidden', vector);
    var bar = $('modeBar');
    if (bar) {
      var btns = bar.querySelectorAll('.modebtn');
      for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('on', btns[i].getAttribute('data-mode') === (vector ? 'vector' : 'raster'));
      }
    }
    var hint = $('volHint');
    if (hint) {
      hint.textContent = (state.plan && state.pdf)
        ? t('print.volumeLabel', state.vol + 1, state.plan.volumes[state.vol].from, state.plan.volumes[state.vol].to)
        : '';
    }
    var jh = $('jacketHint');
    if (jh) {
      var mode = coverMode();
      jh.textContent = mode === 'page'
        ? t('print.jacketPage')
        : (mode === 'blank'
          ? t('print.blankJacket')
          : (hasAnyCover() ? t('print.coverOn') : t('print.coverOff')));
    }
  }

  /* ---------------- pdf.js ---------------- */

  function initPdfjs() {
    var el = $('pdfWorkerSrc');
    if (!window.pdfjsLib) return false;
    if (el && el.textContent) {
      var url = URL.createObjectURL(new Blob([el.textContent], { type: 'application/javascript' }));
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = url;
    }
    return true;
  }

  function openPdf(bytes) {
    return window.pdfjsLib.getDocument({
      data: bytes,
      isEvalSupported: false,
      useSystemFonts: true,
      disableAutoFetch: true,
      disableStream: true
    }).promise;
  }

  function readAsArray(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(new Uint8Array(fr.result)); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsArrayBuffer(file);
    });
  }

  async function renderPage(doc, pageNo, opt) {
    var page = await doc.getPage(pageNo);
    var base = page.getViewport({ scale: 1 });
    var scale;
    if (opt.panelWmm) {
      var f = Math.min((opt.panelWmm * 72 / 25.4) / base.width, (opt.panelHmm * 72 / 25.4) / base.height);
      scale = f * opt.dpi / 72;
    } else {
      scale = opt.dpi / 72;
    }
    var vp = page.getViewport({ scale: scale });
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(vp.width));
    cv.height = Math.max(1, Math.round(vp.height));
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    var blob = await new Promise(function (res) {
      cv.toBlob(function (b) { res(b); }, 'image/jpeg', 0.92);
    });
    page.cleanup();
    return {
      url: URL.createObjectURL(blob),
      wmm: cv.width / opt.dpi * 25.4,
      hmm: cv.height / opt.dpi * 25.4
    };
  }

  function renderThumb(doc, pageNo) {
    return renderPage(doc, pageNo, { dpi: 34 });
  }

  /* Pages that the current preview/print pass actually needs. */
  function currentVolumePages() {
    var pages = [];
    if (!state.plan) return pages;
    var vol = state.plan.volumes[state.vol];
    for (var p = vol.from; p <= vol.to; p++) pages.push(p);
    return pages;
  }

  async function ensureThumbs() {
    if (!state.pdf || !state.plan) return;
    var pages = currentVolumePages();
    var sig = state.pageCount + ':' + state.plan.from + ':' + state.plan.to + ':' + state.vol + ':' + pages.length;
    if (sig === state.thumbSig) return;
    var missing = pages.filter(function (p) { return !state.thumbs[p]; });
    if (!missing.length) { state.thumbSig = sig; syncPreviewImages(); return; }
    state.thumbSig = sig;
    var token = ++state.thumbToken;
    var cursor = 0;
    var done = 0;
    showBusy(t('print.busy') + ' 0/' + missing.length);
    try {
      async function worker() {
        while (cursor < missing.length) {
          if (token !== state.thumbToken) return;
          var pageNo = missing[cursor++];
          try {
            var info = await renderThumb(state.pdf, pageNo);
            if (token !== state.thumbToken) { revokeUrl(info.url); return; }
            state.thumbs[pageNo] = info.url;
            syncPreviewImages();
          } catch (e) {
            state.thumbError = String((e && e.message) || e);
          }
          done++;
          $('busyText').textContent = t('print.busy') + ' ' + done + '/' + missing.length;
        }
      }
      var jobs = [];
      var lanes = Math.min(4, missing.length);
      for (var i = 0; i < lanes; i++) jobs.push(worker());
      await Promise.all(jobs);
    } finally {
      if (token === state.thumbToken) hideBusy();
    }
  }

  function maybeThumbs() {
    if (!state.pdf || !state.plan) return;
    ensureThumbs();
  }

  /* ---------------- loading ---------------- */

  async function loadBytes(bytes, name, size) {
    $('fileErr').classList.add('hidden');
    var keepBytes = new Uint8Array(bytes);
    var doc = await openPdf(bytes);
    if (state.pdf) { try { state.pdf.destroy(); } catch (e) {} }
    state.pdf = doc;
    state.pdfName = name || 'document.pdf';
    state.pdfSize = size || keepBytes.length;
    state.pdfBytes = keepBytes;
    state.pdfLibDoc = null;
    revokeVectorUrls();
    var oldLinks = $('pdfLinks');
    if (oldLinks) { oldLinks.classList.add('hidden'); oldLinks.innerHTML = ''; }
    state.pageCount = doc.numPages;
    state.cfg = C.sanitizeCfg(Object.assign({}, state.cfg, {
      rangeFrom: 1,
      rangeTo: doc.numPages
    }), doc.numPages);
    state.done = {};
    state.vol = 0;
    state.thumbSig = '';
    state.thumbError = '';
    state.previewSig = '';
    state.quality = null;
    clearThumbs();
    syncInputs(state.cfg);
    $('fileChip').classList.remove('hidden');
    $('fileName').textContent = state.pdfName;
    $('fileMeta').textContent = t('file.meta', state.pageCount, bytesText(Math.round(state.pdfSize)));
    recalc();
    analyzeQuality();
  }

  /* Estimate the effective resolution of image-only (scanned) pages, so blur can be diagnosed. */
  async function analyzeQuality() {
    if (!state.pdf || !state.plan) return;
    var pages = [];
    var vol = state.plan.volumes[state.vol];
    for (var p = vol.from; p <= vol.to && pages.length < 2; p++) pages.push(p);
    var worst = null;
    for (var i = 0; i < pages.length; i++) {
      try {
        var page = await state.pdf.getPage(pages[i]);
        var vp = page.getViewport({ scale: 1 });
        var ops = await page.getOperatorList();
        var OPS = window.pdfjsLib.OPS || {};
        var text = await page.getTextContent();
        var imgW = 0;
        var imgH = 0;
        for (var j = 0; j < ops.fnArray.length; j++) {
          var fn = ops.fnArray[j];
          if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
            var args = ops.argsArray[j] || [];
            if (args.length >= 3) {
              imgW = Math.max(imgW, +(args[1] || 0));
              imgH = Math.max(imgH, +(args[2] || 0));
            }
          }
        }
        page.cleanup();
        if (imgW > 0 && text.items.length < 20) {
          var dpi = Math.round(Math.min(imgW / (vp.width / 72), imgH / (vp.height / 72)));
          if (!worst || dpi < worst) worst = dpi;
        }
      } catch (e) {}
    }
    state.quality = worst ? { scanDpi: worst } : null;
    renderQualityHint();
  }

  function renderQualityHint() {
    var el = $('qualityHint');
    if (!el) return;
    var q = state.quality;
    if (q && q.scanDpi) {
      el.textContent = t('print.scanTip', q.scanDpi);
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  async function loadPdfFile(file) {
    try {
      var bytes = await readAsArray(file);
      await loadBytes(bytes, file.name, file.size);
    } catch (e) {
      showFileError(t('file.err'));
    }
  }

  /* Cover sides: separate front / back uploads; image or single-page PDF. */

  function revokeCover(slot) {
    if (!slot) return;
    revokeUrl(slot.thumb);
    if (slot.img && slot.img.url) revokeUrl(slot.img.url);
    if (slot.pdf && slot.pdf.doc) { try { slot.pdf.doc.destroy(); } catch (e) {} }
    slot.kind = '';
    slot.name = '';
    slot.thumb = '';
    slot.err = '';
    slot.img = null;
    slot.pdf = null;
    slot.libDoc = null;
  }

  function canvasToBlob(cv, type, quality) {
    return new Promise(function (res, rej) {
      cv.toBlob(function (b) { if (b) res(b); else rej(new Error('TO_BLOB')); }, type, quality);
    });
  }

  /* Decode only for size/preview; the original bytes are embedded as-is when possible. */
  function loadImageUrl(url) {
    return new Promise(function (res, rej) {
      var img = new Image();
      img.onload = function () { res(img); };
      img.onerror = function () { rej(new Error('DECODE')); };
      img.src = url;
    });
  }

  function guessImageMime(name) {
    if (/\.png$/i.test(name || '')) return 'image/png';
    if (/\.webp$/i.test(name || '')) return 'image/webp';
    return 'image/jpeg';
  }

  async function imageMeta(file) {
    var url = URL.createObjectURL(file);
    try {
      var img = await loadImageUrl(url);
      return { url: url, w: img.naturalWidth, h: img.naturalHeight };
    } catch (e) {
      revokeUrl(url);
      throw e;
    }
  }

  /* Re-encode only when pdf-lib cannot embed the original image (webp, odd PNG, ...). */
  async function coverImageBytes(slot) {
    if (slot.img.encoded) return slot.img.encoded;
    var img = await loadImageUrl(slot.img.url);
    var maxDim = 4000;
    var scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    var w = Math.max(1, Math.round(img.naturalWidth * scale));
    var h = Math.max(1, Math.round(img.naturalHeight * scale));
    var cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    var mime = slot.img.mime === 'image/png' ? 'image/png' : 'image/jpeg';
    var blob = await canvasToBlob(cv, mime, 0.92);
    var buf = await blob.arrayBuffer();
    slot.img.encoded = { bytes: new Uint8Array(buf), mime: mime, w: w, h: h };
    return slot.img.encoded;
  }

  function updateCoverUi(side) {
    var slot = state.covers[side];
    var cap = side === 'front' ? 'Front' : 'Back';
    var prev = $('cover' + cap + 'Prev');
    var meta = $('cover' + cap + 'Meta');
    var clear = $('cover' + cap + 'Clear');
    if (!prev) return;
    if (slot.kind) {
      prev.innerHTML = '<img alt="" src="' + esc(slot.thumb) + '">';
      meta.textContent = slot.name;
      clear.classList.remove('hidden');
    } else {
      prev.innerHTML = '<span>' + esc(t('set.coverNone')) + '</span>';
      meta.textContent = '';
      clear.classList.add('hidden');
    }
    var errBox = $('coverErr');
    var msg = state.covers.front.err || state.covers.back.err || '';
    if (errBox) {
      if (msg) { errBox.textContent = msg; errBox.classList.remove('hidden'); }
      else errBox.classList.add('hidden');
    }
  }

  async function loadCoverSide(side, file) {
    var slot = state.covers[side];
    var isImage = !!(file.type && file.type.indexOf('image/') === 0);
    slot.err = '';
    try {
      if (isImage) {
        var meta = await imageMeta(file);
        var orig = await readAsArray(file);
        revokeCover(slot);
        slot.kind = 'image';
        slot.name = file.name || 'cover';
        slot.img = {
          url: meta.url,
          w: meta.w,
          h: meta.h,
          mime: (file.type && file.type.indexOf('image/') === 0) ? file.type : guessImageMime(file.name),
          bytes: new Uint8Array(orig),
          encoded: null
        };
        slot.thumb = meta.url;
      } else {
        var bytes = await readAsArray(file);
        var keep = new Uint8Array(bytes);
        var doc = await openPdf(bytes);
        var thumb = (await renderThumb(doc, 1)).url;
        revokeCover(slot);
        slot.kind = 'pdf';
        slot.name = file.name || 'cover.pdf';
        slot.pdf = { doc: doc, bytes: keep };
        slot.thumb = thumb;
      }
      updateCoverUi(side);
      renderPreviews(true);
      renderSteps();
    } catch (e) {
      slot.err = isImage ? t('cover.errImage') : t('cover.err');
      updateCoverUi(side);
    }
  }

  function clearCoverSide(side) {
    revokeCover(state.covers[side]);
    updateCoverUi(side);
    renderPreviews(true);
    renderSteps();
  }

  /* ---------------- print ---------------- */

  function currentVolume() {
    return state.plan ? state.plan.volumes[state.vol] : null;
  }

  async function coverPanel(token, panelWmm, panelHmm) {
    var slot = state.covers[token];
    if (!slot || !slot.kind) return null;
    if (slot.kind === 'image') {
      var fit = C.fitPage(slot.img.w, slot.img.h, panelWmm, panelHmm);
      return { url: slot.img.url, wmm: fit.wmm, hmm: fit.hmm };
    }
    if (!slot.pdf || !slot.pdf.doc) return null;
    return await renderPage(slot.pdf.doc, 1, { panelWmm: panelWmm, panelHmm: panelHmm, dpi: state.cfg.dpi });
  }

  async function buildJob(kind) {
    var geo = C.geometry(state.cfg);
    var rects = contentRects();
    var content = rects.left;
    if (kind === 'jacket') {
      var jSheets = jacketSides();
      var tokens = [];
      jSheets.forEach(function (s) {
        [s.left, s.right].forEach(function (tk) {
          if (tk && tokens.indexOf(tk) < 0) tokens.push(tk);
        });
      });
      var jCache = {};
      for (var ti = 0; ti < tokens.length; ti++) {
        showBusy(t('print.busy') + ' ' + (ti + 1) + '/' + tokens.length);
        await yieldUI();
        jCache[tokens[ti]] = await coverPanel(tokens[ti], content.w, content.h);
      }
      return { sheets: jSheets, cache: jCache, geo: geo, rects: rects, kind: kind };
    }
    var sheets = C.jobsForVolume(currentVolume(), state.cfg)[kind];
    var needed = [];
    sheets.forEach(function (s) {
      [s.left, s.right].forEach(function (p) {
        if (p != null && needed.indexOf(p) < 0) needed.push(p);
      });
    });
    needed.sort(function (a, b) { return a - b; });
    var cache = {};
    var cursor = 0;
    var doneCount = 0;
    var panelWmm = content.w;
    var panelHmm = content.h;
    var dpi = state.cfg.dpi;
    async function lane() {
      while (cursor < needed.length) {
        var pageNo = needed[cursor++];
        var info = await renderPage(state.pdf, pageNo, { panelWmm: panelWmm, panelHmm: panelHmm, dpi: dpi });
        cache[pageNo] = info;
        doneCount++;
        $('busyText').textContent = t('print.busy') + ' ' + doneCount + '/' + needed.length;
      }
    }
    showBusy(t('print.busy') + ' 0/' + needed.length);
    var lanes = [];
    /* 600 DPI canvases are big; render one at a time to keep memory sane. */
    var laneCount = Math.min(state.cfg.dpi >= 600 ? 1 : 2, needed.length);
    for (var l = 0; l < laneCount; l++) lanes.push(lane());
    await Promise.all(lanes);
    return { sheets: sheets, cache: cache, geo: geo, rects: rects, kind: kind };
  }

  function addPanel(sheet, pageNo, rect, cache) {
    if (pageNo == null) return;
    var info = cache[pageNo];
    if (!info) return;
    var img = document.createElement('img');
    img.src = info.url;
    img.alt = '';
    img.style.left = (rect.x + (rect.w - info.wmm) / 2) + 'mm';
    img.style.top = (rect.y + (rect.h - info.hmm) / 2) + 'mm';
    img.style.width = info.wmm + 'mm';
    img.style.height = info.hmm + 'mm';
    sheet.appendChild(img);
  }

  function decodeImages(root) {
    var imgs = root.querySelectorAll('img');
    return Promise.all(Array.prototype.map.call(imgs, function (img) {
      if (img.decode) return img.decode().catch(function () {});
      return new Promise(function (res) { img.onload = res; img.onerror = res; });
    }));
  }

  async function buildPrintDom(job) {
    var root = $('printRoot');
    root.innerHTML = '';
    var sh = job.geo.sheet;
    job.sheets.forEach(function (s) {
      var sheet = document.createElement('div');
      sheet.className = 'print-sheet';
      sheet.style.width = sh.w + 'mm';
      sheet.style.height = sh.h + 'mm';
      addPanel(sheet, s.left, job.rects.left, job.cache);
      addPanel(sheet, s.right, job.rects.right, job.cache);
      root.appendChild(sheet);
    });
    $('pageStyle').textContent = '@page{size:' + sh.w + 'mm ' + sh.h + 'mm;margin:0}';
    job.urls = Object.keys(job.cache).map(function (k) { return job.cache[k].url; });
    await decodeImages(root);
    return job;
  }

  function mmToPt(mm) { return mm * 72 / 25.4; }

  function revokeVectorUrls() {
    (state.vectorUrls || []).forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    state.vectorUrls = [];
  }

  function bytesToBase64(bytes) {
    var chunk = 0x8000;
    var out = '';
    for (var i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(out);
  }

  async function mainLibDoc() {
    if (!PL) throw { code: 'VECTOR_UNAVAILABLE' };
    if (state.pdfLibDoc) return state.pdfLibDoc;
    try {
      state.pdfLibDoc = await PL.PDFDocument.load(state.pdfBytes, { updateMetadata: false });
    } catch (e) {
      throw { code: 'VECTOR_LOAD' };
    }
    return state.pdfLibDoc;
  }

  /* pdf.js displays the CropBox view of a page; embed exactly that box or the output jumps. */
  function pageViewBox(p) {
    var size = p.getSize();
    var media = p.getMediaBox ? p.getMediaBox() : { x: 0, y: 0, width: size.width, height: size.height };
    var crop = p.getCropBox ? p.getCropBox() : media;
    var x0 = Math.max(media.x, crop.x);
    var y0 = Math.max(media.y, crop.y);
    var x1 = Math.min(media.x + media.width, crop.x + crop.width);
    var y1 = Math.min(media.y + media.height, crop.y + crop.height);
    return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
  }

  /* pdf.js shows the page's CropBox view; pdf-lib embeds the MediaBox, which would print a
     different crop than the preview. Such pages fall back to rendered printing instead. */
  async function pageEntry(out, srcPage, panelWmm, panelHmm) {
    var view = pageViewBox(srcPage);
    var media = srcPage.getMediaBox ? srcPage.getMediaBox() : view;
    if (Math.abs(view.x - media.x) > 0.01 || Math.abs(view.y - media.y) > 0.01 ||
      Math.abs(view.width - media.width) > 0.01 || Math.abs(view.height - media.height) > 0.01) {
      throw { code: 'VECTOR_CROPBOX' };
    }
    var fit = C.fitPage(view.width, view.height, panelWmm, panelHmm);
    return {
      type: 'page',
      embed: await out.embedPage(srcPage),
      wPt: mmToPt(fit.wmm),
      hPt: mmToPt(fit.hmm)
    };
  }

  async function coverVectorEntry(token, out, panelWmm, panelHmm) {
    var slot = state.covers[token];
    if (!slot || !slot.kind) return null;
    if (slot.kind === 'image') {
      var imgBytes = slot.img.bytes;
      var imgMime = slot.img.mime;
      var imgW = slot.img.w;
      var imgH = slot.img.h;
      var embedded = null;
      try {
        embedded = imgMime === 'image/png' ? await out.embedPng(imgBytes) : await out.embedJpg(imgBytes);
      } catch (e) {
        var enc = await coverImageBytes(slot);
        imgBytes = enc.bytes;
        imgMime = enc.mime;
        imgW = enc.w;
        imgH = enc.h;
        try {
          embedded = imgMime === 'image/png' ? await out.embedPng(imgBytes) : await out.embedJpg(imgBytes);
        } catch (e2) {
          throw { code: 'VECTOR_LOAD' };
        }
      }
      var fitImg = C.fitPage(imgW, imgH, panelWmm, panelHmm);
      return { type: 'image', embed: embedded, wPt: mmToPt(fitImg.wmm), hPt: mmToPt(fitImg.hmm) };
    }
    if (!slot.libDoc) {
      if (!PL) throw { code: 'VECTOR_UNAVAILABLE' };
      try {
        slot.libDoc = await PL.PDFDocument.load(slot.pdf.bytes, { updateMetadata: false });
      } catch (e) {
        throw { code: 'VECTOR_LOAD' };
      }
    }
    var srcPage = await slot.libDoc.getPage(0);
    var rot = srcPage.getRotation ? (srcPage.getRotation().angle % 360) : 0;
    if (rot !== 0) throw { code: 'VECTOR_ROTATION' };
    return await pageEntry(out, srcPage, panelWmm, panelHmm);
  }

  function placeEntry(page, entry, rect) {
    if (!entry) return;
    var pw = mmToPt(rect.w);
    var ph = mmToPt(rect.h);
    var x = mmToPt(rect.x) + (pw - entry.wPt) / 2;
    var y = mmToPt(rect.y) + (ph - entry.hPt) / 2;
    if (entry.type === 'image') page.drawImage(entry.embed, { x: x, y: y, width: entry.wPt, height: entry.hPt });
    else page.drawPage(entry.embed, { x: x, y: y, width: entry.wPt, height: entry.hPt });
  }

  async function buildVectorPdf(kind) {
    var geo = C.geometry(state.cfg);
    var rects = contentRects();
    var content = rects.left;
    var out = await PL.PDFDocument.create();
    var W = mmToPt(geo.sheet.w);
    var H = mmToPt(geo.sheet.h);
    var cache = {};
    var sheets;
    if (kind === 'jacket') {
      sheets = jacketSides();
      var tokens = [];
      sheets.forEach(function (s) {
        [s.left, s.right].forEach(function (tk) {
          if (tk && tokens.indexOf(tk) < 0) tokens.push(tk);
        });
      });
      for (var ti = 0; ti < tokens.length; ti++) {
        showBusy(t('print.busy') + ' ' + (ti + 1) + '/' + tokens.length);
        await yieldUI();
        cache[tokens[ti]] = await coverVectorEntry(tokens[ti], out, content.w, content.h);
      }
    } else {
      sheets = C.jobsForVolume(currentVolume(), state.cfg)[kind];
      var srcDoc = await mainLibDoc();
      var needed = [];
      sheets.forEach(function (s) {
        [s.left, s.right].forEach(function (p) {
          if (p != null && needed.indexOf(p) < 0) needed.push(p);
        });
      });
      needed.sort(function (a, b) { return a - b; });
      for (var i = 0; i < needed.length; i++) {
        if (i % 6 === 0) { showBusy(t('print.busy') + ' ' + (i + 1) + '/' + needed.length); await yieldUI(); }
        var srcPage = await srcDoc.getPage(needed[i] - 1);
        var rot = srcPage.getRotation ? (srcPage.getRotation().angle % 360) : 0;
        if (rot !== 0) throw { code: 'VECTOR_ROTATION' };
        cache[needed[i]] = await pageEntry(out, srcPage, content.w, content.h);
      }
    }
    sheets.forEach(function (s) {
      var page = out.addPage([W, H]);
      placeEntry(page, cache[s.left], rects.left);
      placeEntry(page, cache[s.right], rects.right);
    });
    var bytes = await out.save();
    var url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    state.vectorUrls.push(url);
    return { url: url, pages: sheets.length, size: bytes.length, bytes: bytes };
  }

  function showPdfLinks(url) {
    var box = $('pdfLinks');
    if (!box) return;
    box.classList.remove('hidden');
    box.innerHTML = '<a class="pdflink" target="_blank" rel="noopener" href="' + url + '">' + esc(t('print.pdfOpen')) + '</a>' +
      '<a class="pdflink" download="booklet.pdf" href="' + url + '">' + esc(t('print.pdfDownload')) + '</a>';
  }

  function setPrintMode(mode) {
    if (mode !== 'vector' && mode !== 'raster') return;
    state.cfg.printMode = mode;
    save(LS_CFG, state.cfg);
    renderSteps();
  }

  function recordPrinted(kind, sheets, vol) {
    var d = state.done[vol] || (state.done[vol] = {});
    d[kind] = true;
    state.stats[kind] = (state.stats[kind] || 0) + 1;
    if (kind !== 'jacket') state.stats.sheets += sheets;
    saveStats();
    renderSteps();
    renderStats();
  }

  /* Print a generated PDF straight from the page: hidden iframe + browser print API, no new tab. */
  function printBlobUrl(url, onError) {
    var frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('tabindex', '-1');
    frame.title = 'booklet-print';
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;border:0;opacity:0;pointer-events:none';
    var fired = false;
    var cleanupTimer = null;
    var retryTimer = null;
    function cleanup() {
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (cleanupTimer) { clearTimeout(cleanupTimer); cleanupTimer = null; }
      setTimeout(function () { try { frame.remove(); } catch (e) {} }, 2000);
    }
    function trigger() {
      if (fired) return;
      fired = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      try {
        var w = frame.contentWindow;
        if (!w || typeof w.print !== 'function') throw new Error('PRINT_UNAVAILABLE');
        try { w.addEventListener('afterprint', cleanup); } catch (e) {}
        w.focus();
        w.print();
        cleanupTimer = setTimeout(cleanup, 8000);
      } catch (e) {
        cleanup();
        if (onError) onError(e);
      }
    }
    /* Give the PDF viewer a moment after its load event before printing. */
    frame.addEventListener('load', function () { setTimeout(trigger, 250); });
    document.body.appendChild(frame);
    retryTimer = setTimeout(trigger, 6000);
    frame.src = url;
  }

  async function doPrintVector(kind) {
    if (state.busy || !state.pdf || !state.plan) return;
    state.busy = true;
    renderSteps();
    var fallback = false;
    try {
      var res = await buildVectorPdf(kind);
      showPdfLinks(res.url);
      printBlobUrl(res.url, function () { showFileError(t('print.pdfBlocked')); });
      recordPrinted(kind, res.pages, state.vol);
    } catch (e) {
      if (e && (e.code === 'VECTOR_ROTATION' || e.code === 'VECTOR_LOAD' || e.code === 'VECTOR_UNAVAILABLE' || e.code === 'VECTOR_CROPBOX')) {
        showFileError(t('print.pdfFallback'));
        fallback = true;
      } else {
        showFileError(t('err.generic', (e && e.message) || e));
      }
    }
    state.busy = false;
    hideBusy();
    renderSteps();
    if (fallback) return doPrintRaster(kind);
  }

  function afterPrint() {
    if (!state.printing) return;
    state.printing = false;
    document.body.classList.remove('printing');
    var ctx = state.printCtx;
    state.printCtx = null;
    if (ctx) {
      (ctx.urls || []).forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
      $('printRoot').innerHTML = '';
      recordPrinted(ctx.kind, ctx.sheets, ctx.vol);
    }
    state.busy = false;
    hideBusy();
  }

  async function doPrintRaster(kind) {
    if (state.busy || !state.pdf || !state.plan) return;
    state.busy = true;
    renderSteps();
    try {
      var job = await buildJob(kind);
      await buildPrintDom(job);
      state.printCtx = { kind: kind, urls: job.urls, sheets: job.sheets.length, vol: state.vol };
      state.printing = true;
      document.body.classList.add('printing');
      await yieldUI();
      hideBusy();
      window.print();
    } catch (e) {
      state.busy = false;
      hideBusy();
      document.body.classList.remove('printing');
      $('printRoot').innerHTML = '';
      showFileError(t('err.generic', (e && e.message) || e));
      renderSteps();
    }
  }

  /* ---------------- events / boot ---------------- */

  async function doPrint(kind) {
    if (state.cfg && state.cfg.printMode === 'raster') return doPrintRaster(kind);
    return doPrintVector(kind);
  }

  function bindEvents() {
    $('fileInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) loadPdfFile(f);
      e.target.value = '';
    });
    var drop = $('drop');
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation(); drop.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault(); e.stopPropagation(); drop.classList.remove('over');
      });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadPdfFile(f);
    });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    $('fileInput').addEventListener('click', function (e) { e.stopPropagation(); });

    [['front', 'coverFrontInput'], ['back', 'coverBackInput']].forEach(function (pair) {
      $(pair[1]).addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        if (f) loadCoverSide(pair[0], f);
        e.target.value = '';
      });
    });
    $('coverFrontClear').addEventListener('click', function () { clearCoverSide('front'); });
    $('coverBackClear').addEventListener('click', function () { clearCoverSide('back'); });
    $('coverModeBar').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.covmode') : null;
      if (!btn) return;
      setCoverMode(btn.getAttribute('data-cover'));
    });

    $('rangeAll').addEventListener('click', function () {
      if (!state.pageCount) return;
      $('rangeFrom').value = 1;
      $('rangeTo').value = state.pageCount;
      onCfgChange();
    });
    ['rangeFrom', 'rangeTo'].forEach(function (id) {
      $(id).addEventListener('change', onCfgChange);
    });
    ['paperSel', 'dpiSel', 'mirrorChk', 'reverseChk', 'splitChk', 'maxSheets'].forEach(function (id) {
      $(id).addEventListener('change', onCfgChange);
    });
    $('gutterRange').addEventListener('input', function () {
      $('gutterNum').value = this.value;
      onGutterChange();
    });
    $('gutterNum').addEventListener('change', function () {
      $('gutterRange').value = this.value;
      onGutterChange();
    });

    ['mTop', 'mRight', 'mBottom', 'mLeft'].forEach(function (id) {
      $(id).addEventListener('change', onGutterChange);
    });
    $('safeChk').addEventListener('change', function () {
      var on = this.checked;
      ['mTop', 'mRight', 'mBottom', 'mLeft'].forEach(function (id) { $(id).disabled = !on; });
      if (on) {
        $('mTop').value = String(state.marginLast.t);
        $('mRight').value = String(state.marginLast.r);
        $('mBottom').value = String(state.marginLast.b);
        $('mLeft').value = String(state.marginLast.l);
      }
      onGutterChange();
    });

    $('langSel').addEventListener('change', function () { setLang(this.value); });

    $('modeBar').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.modebtn') : null;
      if (!btn) return;
      setPrintMode(btn.getAttribute('data-mode'));
    });

    $('volChips').addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.chipbtn') : null;
      if (!btn) return;
      state.vol = parseInt(btn.getAttribute('data-vol'), 10) || 0;
      renderVolChips();
      renderPreviews();
      renderSteps();
      maybeThumbs();
    });

    $('btnFront').addEventListener('click', function () { doPrint('front'); });
    $('btnBack').addEventListener('click', function () { doPrint('back'); });
    $('btnJacket').addEventListener('click', function () { doPrint('jacket'); });

    $('statReset').addEventListener('click', function () {
      state.stats = { front: 0, back: 0, jacket: 0, sheets: 0 };
      saveStats();
      renderStats();
    });

    window.addEventListener('afterprint', afterPrint);
  }

  function expose() {
    window.booklet = {
      version: '1.1.0',
      loadBase64: async function (b64, name) {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        await loadBytes(bytes, name || 'test.pdf', bytes.length);
      },
      loadCoverBase64: async function (b64, name, side) {
        var which = side === 'back' ? 'back' : 'front';
        var slot = state.covers[which];
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var keep = new Uint8Array(bytes);
        try {
          var doc = await openPdf(bytes);
          var thumb = (await renderThumb(doc, 1)).url;
          revokeCover(slot);
          slot.kind = 'pdf';
          slot.name = name || 'cover.pdf';
          slot.pdf = { doc: doc, bytes: keep };
          slot.thumb = thumb;
          updateCoverUi(which);
          renderPreviews(true);
          renderSteps();
        } catch (e) {
          slot.err = t('cover.err');
          updateCoverUi(which);
          throw e;
        }
      },
      setConfig: function (patch) {
        state.cfg = C.sanitizeCfg(Object.assign({}, state.cfg, patch), state.pageCount);
        recalc();
      },
      getState: function () {
        return {
          pageCount: state.pageCount,
          cfg: state.cfg,
          plan: state.plan,
          vol: state.vol,
          done: state.done,
          stats: state.stats,
          covers: {
            front: { kind: state.covers.front.kind, name: state.covers.front.name },
            back: { kind: state.covers.back.kind, name: state.covers.back.name }
          },
          hasCover: hasAnyCover(),
          thumbCount: Object.keys(state.thumbs).length,
          thumbError: state.thumbError,
          lang: lang
        };
      },
      getJobs: function (kind) {
        if (kind === 'jacket') return jacketSides();
        return C.jobsForVolume(currentVolume(), state.cfg)[kind];
      },
      buildPrintDom: async function (kind) {
        var job = await buildJob(kind);
        await buildPrintDom(job);
        return { sheets: job.sheets.length, pageStyle: $('pageStyle').textContent };
      },
      buildVectorPdf: async function (kind) {
        var r = await buildVectorPdf(kind);
        return { pages: r.pages, size: r.size, base64: bytesToBase64(r.bytes), url: r.url };
      },
      analyzePdf: async function (b64) {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var doc = await openPdf(bytes);
        var page = await doc.getPage(1);
        var vp = page.getViewport({ scale: 1 });
        var tc = await page.getTextContent();
        var text = tc.items.map(function (it) { return it.str || ''; }).join(' ');
        var out = { pages: doc.numPages, wpt: vp.width, hpt: vp.height, text: text };
        try { doc.destroy(); } catch (e) {}
        return out;
      },
      setPrintMode: setPrintMode,
      cleanupPrint: function () {
        if (state.printCtx) {
          state.printCtx.urls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
          state.printCtx = null;
        }
        $('printRoot').innerHTML = '';
        document.body.classList.remove('printing');
        state.printing = false;
        state.busy = false;
        hideBusy();
        renderSteps();
      },
      countPdfPages: async function (b64) {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var doc = await openPdf(bytes);
        var page = await doc.getPage(1);
        var vp = page.getViewport({ scale: 1 });
        var out = { pages: doc.numPages, wpt: vp.width, hpt: vp.height };
        try { doc.destroy(); } catch (e) {}
        return out;
      },
      setLang: setLang
    };
  }

  function init() {
    lang = detectLang();
    state.stats = loadStats();
    state.cfg = C.sanitizeCfg(load(LS_CFG) || {}, 0);
    initPdfjs();
    bindEvents();
    syncInputs(state.cfg);
    applyI18n();
    updateCoverUi('front');
    updateCoverUi('back');
    updateCoverModeUi();
    renderPlanBar();
    renderPreviews();
    renderSteps();
    renderStats();
    expose();
  }

  init();
})();
