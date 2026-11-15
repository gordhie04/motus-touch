/* Glue between the Motus-Touch panel and the color engine.
   Uses app.js globals at call time (active, photos, selected, previewData, db, commit, buildPanel, scheduleRender, notify ...). */
'use strict';

const MotusEngineUI = (() => {
const P = MotusParams, I = P.internal;
let engine = null, engineError = null, sourceKey = null, readTimer = null, picking = null;
const statsCache = new Map(), lutMem = new Map(), lutLoading = new Map();

P.register();

if (location.protocol === 'file:') document.addEventListener('DOMContentLoaded', () => {
  const b = document.createElement('div'); b.className = 'engine-file-warning';
  b.innerHTML = '<strong>Motus-Touch needs its local starter.</strong> Opened straight from Finder, the browser blocks photo editing. Close this tab and double-click <b>Start Motus-Touch.command</b> in the Motus-Touch folder (Windows: <b>Start Motus-Touch (Windows).bat</b>).';
  document.body.prepend(b);
});

// A canvas that once had a WebGL context can never give a 2D one, so on failure swap in a fresh canvas
function freshCanvas() {
  const old = document.getElementById('edited-image'), c = document.createElement('canvas');
  for (const a of old.attributes) c.setAttribute(a.name, a.value);
  old.replaceWith(c); return c;
}
function disable(e, where) {
  engineError = e; console.error(`Motus color engine (${where}):`, e);
  try { engine?.destroy(); } catch {}
  engine = null; sourceKey = null; freshCanvas();
  const msg = `GPU color engine is off (${(e && e.message || String(e)).split('\n')[0].slice(0, 140)}). Basic sliders still work.`;
  setTimeout(() => notify(msg), 50);
  const note = document.querySelector('#planned-notice p'); if (note) note.textContent = msg;
}
function getEngine() {
  if (engine || engineError) return engine;
  try {
    const canvas = document.getElementById('edited-image');
    engine = new MotusGL.Engine(canvas);
    canvas.addEventListener('webglcontextlost', ev => { ev.preventDefault(); engine = null; sourceKey = null; }, { once: true });
    canvas.addEventListener('webglcontextrestored', () => { engineError = null; scheduleRender(); }, { once: true });
  } catch (e) { disable(e, 'start'); }
  return engine;
}
const available = () => !!getEngine();

/* ---------- helpers ---------- */
const ctl = path => P.control(path);
function setDraft(path, value, photo = active) { const c = ctl(path); photo.drafts[draftKeyFor(c, photo)] = value; }
function draftKeyFor(c, photo = active) { return c.channelSelect ? `${c.id}@${photo.drafts[c.channelSelect] ?? P.byId.get(c.channelSelect).value}` : c.id; }
function rebuild() { const sc = document.getElementById('tool-scroll').scrollTop; buildPanel(); document.getElementById('tool-scroll').scrollTop = sc; }
function refresh() { commit(); rebuild(); scheduleRender(); }
function pickFile(accept) {
  return new Promise(resolve => { const input = document.createElement('input'); input.type = 'file'; input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] || null); input.oncancel = () => resolve(null); input.click(); });
}
function hash01(s) { let h = 2166136261; for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; }

function photoStats(photo, data) {
  const key = photo.id + ':' + data.width + 'x' + data.height;
  if (!statsCache.has(key)) statsCache.set(key, { lab: MotusAuto.labStats(data), air: MotusAuto.airLight(data) });
  return statsCache.get(key);
}

/* ---------- LUT storage: text lives in IndexedDB next to the workspace, keyed lut:<id> ---------- */
function idb(mode, fn) { return new Promise((res, rej) => { if (!db) return rej(new Error('no storage')); const tx = db.transaction('workspace', mode), r = fn(tx.objectStore('workspace')); tx.oncomplete = () => res(r?.result); tx.onerror = () => rej(tx.error); }); }
async function storeLut(text, name) {
  const lut = P.parseCube(text), id = 'lut-' + (crypto.randomUUID?.() || Date.now());
  lutMem.set(id, { ...lut, key: id, name });
  try { await idb('readwrite', s => s.put({ name, text }, 'lut:' + id)); } catch { notify('LUT applied for this session only (storage unavailable).'); }
  return id;
}
function lutFor(id) {
  if (!id) return null; if (lutMem.has(id)) return lutMem.get(id);
  if (!lutLoading.has(id)) lutLoading.set(id, idb('readonly', s => s.get('lut:' + id)).then(rec => {
    if (rec) { lutMem.set(id, { ...P.parseCube(rec.text), key: id, name: rec.name }); scheduleRender(); } }).catch(() => {}));
  return null;
}

/* ---------- render ---------- */
function exclusions() { return groupPreview?.liveIds ? new Set(groupPreview.liveIds) : null; }
function uniformsFor(photo, data, settings, w, h, fullW, fullH) {
  const params = P.build(photo, { settings, exclude: exclusions() });
  const stats = photoStats(photo, data);
  const luts = { profile: lutFor(params.lutIds.profile), filter: lutFor(params.lutIds.filter) };
  return P.toUniforms(params, { w, h, fullW, fullH, stats, luts, seed: hash01(photo.id) });
}
function render(photo, data, settings, fullW, fullH) {
  const e = getEngine(); if (!e) return false;
  try { return renderWith(e, photo, data, settings, fullW, fullH); }
  catch (err) { disable(err, 'render'); return false; }
}
function renderWith(e, photo, data, settings, fullW, fullH) {
  const src = MotusPortraitUI.process(photo, data);          // retouched copy, or the original when nothing to do
  if (src !== sourceKey) { e.setSource(src, src.width, src.height); sourceKey = src; }
  const U = uniformsFor(photo, data, settings, data.width, data.height, fullW, fullH);
  e.setCurves(U.curves); e.setLut('profile', U.luts.profile); e.setLut('filter', U.luts.filter); e.setLut('look', U.luts.look);
  e.render(U); e.present();
  clearTimeout(readTimer);
  if (data !== previewData || Interaction.busy) return true;      // while dragging, the histogram and the GPU error check wait for the final render
  const err = e.gl.getError(); if (err) throw new Error('WebGL error ' + err);   // asking the GPU for errors makes it finish all pending work first, so not on drag frames
  readTimer = setTimeout(() => { if (!engine) return; try { renderedData = engine.readPixels(); drawHistogram(renderedData); } catch (x) { disable(x, 'readback'); scheduleRender(); } }, 90);
  return true;
}
// full-resolution export: separate GPU context, 8-bit intermediates for very large photos
async function exportCanvas(photo, image, settings) {
  const W = image.naturalWidth, H = image.naturalHeight, canvas = document.createElement('canvas');
  const e = new MotusGL.Engine(canvas, { lowPrecision: W * H > 16e6 });
  try {
    if (MotusPortraitUI.hasEdits(photo)) {
      notify('Retouching at full resolution…');
      const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(image, 0, 0);
      const full = await MotusPortraitUI.processFull(photo, x.getImageData(0, 0, W, H)); c.width = c.height = 1;
      e.setSource(full, W, H);
    } else e.setSource(image, W, H);
    const U = uniformsFor(photo, previewData, settings, W, H, W, H);
    e.setCurves(U.curves); e.setLut('profile', U.luts.profile); e.setLut('filter', U.luts.filter); e.setLut('look', U.luts.look);
    e.render(U); await new Promise(r => setTimeout(r, 0));
    const px = e.readPixels();
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const ctx = out.getContext('2d'); const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
    tmp.getContext('2d').putImageData(px, 0, 0);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H); ctx.drawImage(tmp, 0, 0); tmp.width = tmp.height = 1;
    return out;
  } finally { e.destroy(); }
}

/* ---------- control hooks ---------- */
const WB = { 'As shot': [0, 0], Daylight: [8, 0], Cloudy: [20, 4], Shade: [32, 6], Tungsten: [-55, 6], Fluorescent: [-30, 25], Flash: [12, 2] };
function onValue(c, value) {
  if (c.id.startsWith('portrait.')) { MotusPortraitUI.onValue(c, value); return; }
  if (c.channelSwitch) { rebuild(); return; }
  if (c.label === 'White balance' && WB[value]) { [active.settings.temperature, active.settings.tint] = WB[value]; active.look = null; syncWorkingInputs(); }
  if (c.working && (c.key === 'temperature' || c.key === 'tint')) {
    const wb = ctl('color/Basic/White balance/White balance');
    if (active.drafts[wb.id] && active.drafts[wb.id] !== 'Custom') { active.drafts[wb.id] = 'Custom'; const el = document.getElementById('control-' + wb.id); if (el) el.value = 'Custom'; }
  }
  if (c.label === 'Remove chromatic aberration' && value && !active.drafts[I + 'ca'] && sourceImage) {
    const photo = active; notify('Measuring chromatic aberration…');
    MotusAuto.chromaticAberration(sourceImage).then(ca => { photo.drafts[I + 'ca'] = ca; if (active === photo) { commit(); scheduleRender(); } notify('Chromatic aberration corrected.'); });
  }
  if (c.label === 'Curve mode') rebuild();
}

async function onAction(c) {
  if (!active) return;
  if (c.id.startsWith('portrait.') && MotusPortraitUI.onAction(c)) return;
  const photo = active, L = c.label;
  try {
    if (L === 'Import LUT profile' || L === 'Import filter') {
      const file = await pickFile('.cube'); if (!file) return;
      const id = await storeLut(await file.text(), file.name);
      if (L === 'Import LUT profile') { photo.drafts[I + 'lut.profile'] = id; setDraft('color/Profile & filters/Profile/Color profile', 'Custom LUT', photo); }
      else { photo.drafts[I + 'lut.filter'] = id; setDraft('color/Profile & filters/Filters/Filter collection', 'Custom', photo);
        if (!P.value(photo, 'color/Profile & filters/Filters/Filter intensity')) setDraft('color/Profile & filters/Filters/Filter intensity', 100, photo); }
      refresh(); notify(`${file.name} applied.`); return;
    }
    if (L === 'Sample black point' || L === 'Sample white point') { startPicking(L.includes('black') ? 'black' : 'white'); return; }
    if (L === 'Add curve point') { CurveEditor.addMiddle(); return; }
    if (L === 'Reset curve') { const ch = curveChannel(); delete photo.drafts[I + 'curve@' + ch];
      for (const l of ['Highlights','Lights','Darks','Shadows']) delete photo.drafts[draftKeyFor(ctl('color/Curves/Curve editor/' + l))]; refresh(); return; }
    if (L === 'Level' || L === 'Auto transform' || L === 'Vertical') {
      if (!previewData) return; const cur = P.build(photo).transform;
      const res = L === 'Level' ? MotusAuto.level(previewData, cur) : MotusAuto.upright(previewData, cur, L === 'Auto transform');
      if (!res) { notify('Not enough straight lines to correct automatically.'); return; }
      setDraft('color/Transform correction/Manual/Rotate', Math.round(res.rotate * 4) / 4, photo);
      if (L !== 'Level') setDraft('color/Transform correction/Manual/Vertical', Math.round(res.vertical), photo);
      setDraft('color/Transform correction/Edges/Constrain crop', true, photo);
      // second pass: measure the corrected result and fine-tune the rotation
      if (getEngine()) { globalThis.render(); const zero = { ...cur, rotate: 0, vertical: 0, horizontal: 0, aspect: 0, scale: 0, x: 0, y: 0 };
        const fix = MotusAuto.level(engine.readPixels(), zero);
        if (fix && Math.abs(fix.rotate) < 15) setDraft('color/Transform correction/Manual/Rotate', Math.max(-100, Math.min(100, Math.round((res.rotate + fix.rotate) * 4) / 4)), photo); }
      refresh(); notify(L === 'Level' ? 'Horizon leveled.' : 'Perspective corrected.'); return;
    }
    if (L === 'Apply auto color') {
      let wbOn = !!P.value(photo, 'ai-color/Auto color correction/Balance/AI white balance'), exOn = !!P.value(photo, 'ai-color/Auto color correction/Balance/AI exposure');
      if (!wbOn && !exOn) wbOn = exOn = true;
      if (wbOn) { const wb = MotusAuto.autoWhiteBalance(previewData); photo.settings.temperature = wb.temperature; photo.settings.tint = wb.tint; }
      if (exOn) photo.settings.exposure = MotusAuto.autoExposure(previewData, photo.settings.temperature, photo.settings.tint);
      photo.look = null; syncWorkingInputs(); refresh(); notify('Auto color applied. Fine-tune it in Color adjustments.'); return;
    }
    if (L === 'Choose reference image' || L === 'Import reference') {
      const file = await pickFile('image/*'); if (!file) return;
      const stats = await MotusAuto.fileStats(file);
      if (L === 'Choose reference image') { photo.drafts[I + 'ref.consistency'] = stats;
        if (!P.value(photo, 'ai-color/Color consistency/Reference matching/Match strength')) setDraft('ai-color/Color consistency/Reference matching/Match strength', 80, photo);
        if (P.value(photo, 'ai-color/Color consistency/Reference matching/Match region') === 'Background color') notify('Background-only matching needs the masking engine (phase 4). Matching overall color for now.');
        else notify(`Matching ${file.name}.`); }
      else { photo.drafts[I + 'ref.match'] = stats;
        if (!P.value(photo, 'ai-color/AI color match/Reference/Color match amount')) setDraft('ai-color/AI color match/Reference/Color match amount', 100, photo); notify(`Matching ${file.name}.`); }
      refresh(); return;
    }
    if (L === 'Match color') { if (!photo.drafts[I + 'ref.match']) { notify('Import a reference first.'); return; }
      if (!P.value(photo, 'ai-color/AI color match/Reference/Color match amount')) setDraft('ai-color/AI color match/Reference/Color match amount', 100, photo); refresh(); return; }
    if (L === 'Match selected photos') {
      const stats = photo.drafts[I + 'ref.consistency']; if (!stats) { notify('Choose a reference image first.'); return; }
      const targets = photos.filter(p => selected.has(p.id) && p !== photo); if (!targets.length) { notify('Select photos in the Library first, then come back here.'); return; }
      const strength = P.value(photo, 'ai-color/Color consistency/Reference matching/Match strength') || 80;
      for (const p of targets) { p.drafts[I + 'ref.consistency'] = stats; setDraft('ai-color/Color consistency/Reference matching/Match strength', strength, p); }
      saveSoon(); notify(`Reference applied to ${targets.length} photo${targets.length > 1 ? 's' : ''}.`); return;
    }
    if (L === 'Apply look') { if (!P.value(photo, 'ai-color/AI color looks/Style/Look intensity')) setDraft('ai-color/AI color looks/Style/Look intensity', 100, photo);
      if (P.value(photo, 'ai-color/AI color looks/Style/Look') === 'Custom' && !photo.drafts[I + 'lut.filter']) notify('Custom uses the filter imported under Color › Profile & filters.');
      refresh(); return; }
  } catch (err) { console.error(err); notify(err.message || 'That did not work. Try again.'); }
}

/* ---------- eyedropper for levels ---------- */
function startPicking(kind) {
  picking = kind; document.getElementById('stage').classList.add('engine-picking');
  notify(`Click the image where it should be ${kind === 'black' ? 'pure black' : 'pure white'}.`);
}
function handlePick(e) {
  if (!picking || !active || !previewData) return;
  e.preventDefault(); e.stopPropagation();
  const r = document.getElementById('image-frame').getBoundingClientRect();
  const x = Math.floor((e.clientX - r.left) / r.width * previewData.width), y = Math.floor((e.clientY - r.top) / r.height * previewData.height);
  const kind = picking; picking = null; document.getElementById('stage').classList.remove('engine-picking');
  if (x < 0 || y < 0 || x >= previewData.width || y >= previewData.height) return;
  const i = (y * previewData.width + x) * 4, d = previewData.data, ch = P.value(active, 'color/Levels/Channel/Levels channel');
  const v = ch === 'Red' ? d[i] : ch === 'Green' ? d[i + 1] : ch === 'Blue' ? d[i + 2] : kind === 'black' ? Math.max(d[i], d[i + 1], d[i + 2]) : Math.min(d[i], d[i + 1], d[i + 2]);
  if (kind === 'black') setDraft('color/Levels/Channel/Input black', Math.min(v, 250)); else setDraft('color/Levels/Channel/Input white', Math.max(v, 5));
  refresh();
}

/* ---------- curve editor ---------- */
function curveChannel() { return P.value(active, 'color/Curves/Curve editor/Curve channel'); }
const CurveEditor = (() => {
  let canvas = null, drag = -1;
  const colors = { RGB: '#e8eefc', Red: '#eb6c8c', Green: '#51baa2', Blue: '#689eff' };
  const pts = () => active?.drafts[I + 'curve@' + curveChannel()] || [[0, 0], [1, 1]];
  const save = p => { active.drafts[I + 'curve@' + curveChannel()] = p.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]); };
  function draw() {
    if (!canvas || !active) return; const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H); ctx.strokeStyle = '#ffffff1a'; ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(i * W / 4, 0); ctx.lineTo(i * W / 4, H); ctx.moveTo(0, i * H / 4); ctx.lineTo(W, i * H / 4); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(0, H); ctx.lineTo(W, 0); ctx.strokeStyle = '#ffffff22'; ctx.stroke();
    const ch = curveChannel(), p = pts(), f = P.monotoneCurve(p);
    ctx.beginPath(); for (let x = 0; x <= W; x++) { const y = Math.min(1, Math.max(0, f(x / W))); x ? ctx.lineTo(x, H - y * H) : ctx.moveTo(x, H - y * H); }
    ctx.strokeStyle = colors[ch] || '#fff'; ctx.lineWidth = 2; ctx.stroke();
    for (const [x, y] of p) { ctx.beginPath(); ctx.arc(x * W, H - y * H, 5, 0, 7); ctx.fillStyle = '#0c1527'; ctx.fill(); ctx.strokeStyle = colors[ch]; ctx.lineWidth = 2; ctx.stroke(); }
  }
  function pos(e) { const r = canvas.getBoundingClientRect(); return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height))]; }
  function nearest(p, [x, y]) { let best = -1, d = .05; p.forEach(([px, py], i) => { const dd = Math.hypot(px - x, py - y); if (dd < d) { d = dd; best = i; } }); return best; }
  function mount(el) {
    canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 480; canvas.className = 'engine-curve';
    canvas.setAttribute('aria-label', 'Point curve. Click to add a point, drag to move, double-click to remove.');
    canvas.onpointerdown = e => { if (!active) return; const p = pts().map(q => [...q]), at = pos(e); drag = nearest(p, at);
      if (drag < 0) { p.push(at); p.sort((a, b) => a[0] - b[0]); drag = p.findIndex(q => q[0] === at[0] && q[1] === at[1]); save(p); scheduleRender(); }
      canvas.setPointerCapture(e.pointerId); draw(); };
    canvas.onpointermove = e => { if (drag < 0) return; const p = pts().map(q => [...q]), [x, y] = pos(e);
      const lo = drag > 0 ? p[drag - 1][0] + .01 : 0, hi = drag < p.length - 1 ? p[drag + 1][0] - .01 : 1;
      p[drag] = [drag === 0 && p.length > 1 ? Math.min(x, hi) : drag === p.length - 1 ? Math.max(x, lo) : Math.min(hi, Math.max(lo, x)), y]; save(p); draw(); scheduleRender(); };
    canvas.onpointerup = () => { if (drag >= 0) { drag = -1; commit(); } };
    canvas.ondblclick = e => { const p = pts().map(q => [...q]), i = nearest(p, pos(e)); if (i > 0 && i < p.length - 1) { p.splice(i, 1); save(p); draw(); commit(); scheduleRender(); } };
    el.append(canvas); draw();
  }
  function addMiddle() { const p = pts().map(q => [...q]), f = P.monotoneCurve(p); p.push([.5, f(.5)]); p.sort((a, b) => a[0] - b[0]); save(p); commit(); draw(); scheduleRender(); }
  return { mount, draw, addMiddle };
})();

function decorateGroup(moduleId, sectionTitle, groupTitle, el) {
  if (moduleId === 'color' && sectionTitle === 'Curves' && groupTitle === 'Curve editor' && active && P.value(active, 'color/Curves/Curve editor/Curve mode') === 'Point') {
    const box = document.createElement('div'); box.className = 'engine-curve-box'; CurveEditor.mount(box);
    el.insertBefore(box, el.children[1] || null);
  }
  if (moduleId === 'color' && sectionTitle === 'Profile & filters' && active) {
    const id = groupTitle === 'Profile' ? active.drafts[I + 'lut.profile'] : active.drafts[I + 'lut.filter'];
    const name = id && lutMem.get(id)?.name;
    if (name) { const tag = document.createElement('div'); tag.className = 'engine-note'; tag.textContent = 'Loaded: ' + name; el.append(tag); }
  }
}

/* Photos from before the engine may hold values set while controls were previews.
   Switch those off so the photo looks as it did, as a new history step: Undo turns them back on. */
const ENGINE_VERSION = 2;
function migrate(photo) {
  const from = photo.engineVersion || 0;
  if (from >= ENGINE_VERSION) return;
  photo.engineVersion = ENGINE_VERSION;
  const stale = Object.keys(photo.drafts).filter(k => { if (k.startsWith(I)) return false; const c = P.byId.get(k.split('@')[0]); return c?.live && c.type !== 'action' && (c.liveSince || 1) > from; });
  if (!stale.length) { saveSoon(); return; }
  for (const k of stale) delete photo.drafts[k];
  photo.history = photo.history.slice(0, photo.position + 1);
  photo.history.push({ settings: JSON.parse(JSON.stringify(photo.settings)), drafts: JSON.parse(JSON.stringify(photo.drafts)), look: photo.look, target: photo.target });
  photo.position = photo.history.length - 1;
  saveSoon();
  setTimeout(() => notify(`${stale.length} older preview setting${stale.length > 1 ? 's are' : ' is'} now real, so ${stale.length > 1 ? 'they were' : 'it was'} switched off to keep this photo unchanged. Press Undo to turn ${stale.length > 1 ? 'them' : 'it'} on.`), 400);
}
function resetSection(moduleId, sectionTitle, photo) {
  const drop = {
    'color/Curves': k => k.startsWith(I + 'curve@'), 'color/Lens corrections': k => k === I + 'ca',
    'color/Profile & filters': k => k.startsWith(I + 'lut.'),
    'ai-color/Color consistency': k => k === I + 'ref.consistency', 'ai-color/AI color match': k => k === I + 'ref.match'
  }[`${moduleId}/${sectionTitle}`];
  if (drop) for (const k of Object.keys(photo.drafts)) if (drop(k)) delete photo.drafts[k];
}
function previewKeysFor(controls) { return controls.filter(c => c.live).map(c => c.id); }
function liveDraftCount(photo) { return Object.keys(photo.drafts).filter(k => { if (k.startsWith(I)) return false; const c = P.byId.get(k.split('@')[0]); return !c?.live; }).length; }

document.addEventListener('pointerdown', e => { if (picking && e.target.closest('#image-frame')) handlePick(e); }, true);
document.addEventListener('keydown', e => { if (picking && e.key === 'Escape') { picking = null; document.getElementById('stage').classList.remove('engine-picking'); } });

return { available, render, exportCanvas, onValue, onAction, decorateGroup, resetSection, migrate, previewKeysFor, liveDraftCount, hasLiveEdits: P.hasLiveEdits, get error() { return engineError; } };
})();
