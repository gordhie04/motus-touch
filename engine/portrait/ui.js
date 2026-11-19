/* Portrait module glue: connected controls, per-person targets, face boxes, and the retouch step
   that runs before the color engine (preview and export). Uses app.js globals at call time. */
'use strict';

const MotusPortraitUI = (() => {
const P = MotusParams;
const LIVE = {
  'Master & targets/Portrait settings': ['Detect faces', 'Add individual target'],
  'Blemish removal/Face refinement': ['Freckles & acne', 'Freckles', 'Acne', 'Face mole removal', 'Reduce face shine', 'Dark circles', 'Eye bags', 'Lower eyelids protection', 'Remove glasses glare', 'Lip wrinkles & flakes', 'Beard protection'],
  'Blemish removal/Facial wrinkles': ['Forehead wrinkles', 'Eleven lines', 'Eye wrinkles', 'Nasal wrinkles', 'Smile line · left', 'Smile line · right', 'Cheek wrinkles', 'Marionette lines', 'Perioral wrinkles'],
  'Skin retouching/Facial skin': ['Even with dodge & burn', 'Textured smoothing', 'Frequency separation · high', 'Frequency separation · low', 'Skin softening'],
  'Skin retouching/Skin texture': ['Texture finish', 'Glossiness', 'Texture', 'Clarity'],
  'Skin retouching/Skin tone': ['Unify face complexion', 'Skin tone', 'Skin tone intensity', 'Skin temperature', 'Skin tint', 'Skin radiance', 'Rosy complexion'],
  'Teeth/Refine': ['Teeth flaws removal', 'Teeth whitening', 'Teeth brightness', 'Teeth desaturation'],
  'Eyes/Brightness': ['Eye brightness', 'Iris brightness', 'Eye whites brightness', 'Eye reflection', 'Iris flare', 'Remove glasses glare', 'Red vein removal', 'Eye white cleanse', 'Red eye removal'],
  'Eyes/Eye color': ['Iris color', 'Iris color amount'],
  'Makeup/Definition': ['Highlight', 'Contour', 'Eyebrow makeup'],
  'Makeup/Existing lip makeup': ['Lip makeup amount', 'Lip makeup saturation', 'Lip makeup luminance', 'Lip makeup dimensionality'],
  'Makeup/Individual components': ['Eyebrows amount', 'Blush amount', 'Lipstick amount'],
  'Hair/Cleanup': ['Smooth hair', 'Tame frizzy hair', 'Hair shine', 'White hair blackening'],
  'Hair/Hair color': ['Hair color', 'Custom hair color', 'Hair color amount', 'Hair color temperature', 'Hair color saturation']
};
for (const [grp, labels] of Object.entries(LIVE)) for (const l of labels) {
  const c = P.control(`portrait/${grp}/${l}`); if (!c) { console.warn('missing portrait control', grp, l); continue; }
  c.live = true; c.liveSince = 2;
}
// sliders that sit under a parent slider start at these values, in the panel (app.js renderBundle) and in the engine alike
const CHILD_DEFAULTS = { 'Freckles': 100, 'Acne': 100, 'Iris brightness': 80, 'Eye whites brightness': 80, 'Eye reflection': 40, 'Tame frizzy hair': 100 };

const outCache = new Map();   // image -> { key, out }: one entry for the full preview, one for the drag copy
const persons = photo => (MotusFaces.get(photo)?.faces || []).map((_, i) => `Person ${i + 1}`);

function portraitDrafts(photo) {
  const out = {};
  for (const [k, v] of Object.entries(photo.drafts)) { const c = P.byId.get(k.split('@')[0]); if (c?.live && c.id.startsWith('portrait.') && c.type !== 'action') out[k] = v; }
  return out;
}
function getter(photo) {
  const ex = groupPreview?.liveIds ? new Set(groupPreview.liveIds) : null;
  return (path, k) => {
    const c = P.control('portrait/' + path); if (!c) return undefined;
    const def = CHILD_DEFAULTS[c.label] ?? c.value;
    if (ex?.has(c.id)) return def;
    const own = photo.drafts[`${c.id}@Person ${k + 1}`], all = photo.drafts[`${c.id}@All people`];
    return own !== undefined && !own?.queued ? own : all !== undefined && !all?.queued ? all : def;
  };
}
function hasEdits(photo) {
  const g = getter(photo), faces = Math.max(1, MotusFaces.get(photo)?.faces.length || 1);
  for (const k of Object.keys(portraitDrafts(photo))) {
    const c = P.byId.get(k.split('@')[0]); if (c.label === 'Lower eyelids protection' || CHILD_DEFAULTS[c.label] !== undefined || c.label === 'Beard protection') continue;   // these only shape another slider
    for (let f = 0; f < faces; f++) { const v = g(labelPath(c), f); if (v !== (CHILD_DEFAULTS[c.label] ?? c.value) && v !== 'Original' && v !== 'Custom') return true; }
  }
  return false;
}
// Which networks this photo's sliders need. Blemish sliders use both: ABPN heals single spots and the Motus Touch model does the rest;
// "Even with dodge & burn" uses ABPN's blend layer only.
const BLEMISH = ['Blemish removal/Face refinement/Freckles & acne', 'Blemish removal/Face refinement/Face mole removal'], EVEN = ['Skin retouching/Facial skin/Even with dodge & burn'];
function uses(photo, paths) {
  const g = getter(photo), faces = Math.max(1, MotusFaces.get(photo)?.faces.length || 1);
  for (let f = 0; f < faces; f++) for (const p of paths) if (g(p, f)) return true;
  return false;
}
const needsPro = photo => MotusPro.enabled && uses(photo, BLEMISH);
const needsABPN = photo => uses(photo, [...BLEMISH, ...EVEN]);
const needsAI = photo => needsPro(photo) || needsABPN(photo);
const pathCache = new Map();
function labelPath(c) {
  if (pathCache.has(c.id)) return pathCache.get(c.id);
  for (const [k, ctl] of P.index) if (ctl === c) { const p = k.split('/').slice(1).join('/'); pathCache.set(c.id, p); return p; }
}

function ensureAnalysis(photo) {
  if (!previewData || MotusFaces.get(photo) || MotusFaces.busy(photo)) return;
  setNotice('Finding faces…');
  MotusFaces.analyze(photo, previewData, a => {
    if (active === photo) { setNotice(); if (moduleId === 'portrait') { const sc = $('#tool-scroll').scrollTop; buildPanel(); $('#tool-scroll').scrollTop = sc; } scheduleRender(); drawFaces(); warm(photo); }
  }).catch(e => setNotice('Face detection failed: ' + e.message));
}
function setNotice(text) {
  if (moduleId !== 'portrait') return;
  const p = document.querySelector('#planned-notice p'); if (!p || !active) return;
  if (text) { p.textContent = text; return; }
  const a = MotusFaces.get(active), n = a?.faces.length;
  p.textContent = (a ? (n ? `${n} ${n === 1 ? 'person' : 'people'} found. ` : 'No faces found. ') : '') + 'Blemishes, skin, wrinkles, eyes, teeth, lips, brows, blush and hair color work. Reshape, body and generated features are still previews.';
}

// Retouched copy of `img` for this photo (cached while nothing relevant changes)
function process(photo, img) {
  if (!hasEdits(photo)) return img;
  const a = MotusFaces.get(photo);
  if (!a) { ensureAnalysis(photo); return img; }
  if (!a.faces.length) return img;
  const full = active === photo && previewData ? previewData : img;          // the AI always runs on the full preview
  if (needsABPN(photo) && !MotusABPN.ready(photo, full, a) && !MotusABPN.busy(photo, full)) {
    setNotice('Retouching skin… (first time loads the AI models)');
    MotusABPN.prepare(photo, full, a, 1536).then(() => { if (active === photo) { setNotice(); scheduleRender(); } })
      .catch(e => { console.error('ABPN failed', e); setNotice(); notify('Skin AI could not run: ' + e.message); });
  }
  if (needsPro(photo) && !MotusPro.ready(photo, full, a)) {
    if (MotusPro.busy(photo, full)) setNotice('Retouching skin…');   // already running in the background (see warm)
    else { setNotice('Retouching skin… (first time loads the AI model)');
      MotusPro.prepare(photo, full, a).then(() => { if (active === photo) { setNotice(); scheduleRender(); } }).catch(e => { console.error('Motus Touch failed', e); setNotice(); }); }
  }
  const key = (MotusABPN.ready(photo, img, a) ? 'ai|' : '') + (MotusPro.enabled && MotusPro.ready(photo, img, a) ? 'pro|' : '') + photo.id + '|' + img.width + 'x' + img.height + '|' + JSON.stringify(portraitDrafts(photo)) + '|' + (groupPreview?.liveIds?.join(',') || '');
  const hit = outCache.get(img); if (hit && hit.key === key) return hit.out;
  let out;
  try { out = MotusRetouch.apply(img, a, getter(photo)); }
  catch (e) { console.error('Portrait retouch failed', e); if (!process.warned) { process.warned = true; notify('Portrait retouching hit an error and was skipped for this photo.'); } return img; }
  if (outCache.size > 2) outCache.clear(); outCache.set(img, { key, out });
  return out;
}
// export: make sure faces were analysed (from the preview), then retouch the full-resolution pixels
async function processFull(photo, img) {
  if (!hasEdits(photo)) return img;
  const a = MotusFaces.get(photo) || await MotusFaces.analyze(photo, previewData);
  if (!a.faces.length) return img;
  const big = img.width !== previewData.width || img.height !== previewData.height;
  if (needsABPN(photo)) await MotusABPN.prepare(photo, img, a, 2048);
  if (needsPro(photo)) await MotusPro.prepare(photo, img, a);
  try { return MotusRetouch.apply(img, a, getter(photo)); } finally { if (big) { MotusABPN.drop(a, img); MotusPro.drop(a, img); } }
}

/* ---------- targets ---------- */
// person chips only make sense with 2+ people; with one person (or none) edits simply apply to the photo
function targets() {
  const a = active && MotusFaces.get(active), ps = a ? persons(active) : [];
  if (ps.length < 2) { if (active && active.target && active.target !== 'All people') active.target = 'All people'; return []; }
  return ['All people', ...ps];
}
function drawFaces() {
  const frame = document.getElementById('image-frame'); if (!frame) return;
  frame.querySelectorAll('.face-box').forEach(b => b.remove());
  const a = active && MotusFaces.get(active);
  if (!a || moduleId !== 'portrait' || screen !== 'editor' || a.faces.length === 0) return;
  a.faces.forEach((f, i) => {
    const t = `Person ${i + 1}`, b = document.createElement('button'); b.type = 'button';
    b.className = 'face-box' + (active.target === t ? ' selected' : ''); b.dataset.person = t;
    Object.assign(b.style, { left: f.x * 100 + '%', top: f.y * 100 + '%', width: f.w * 100 + '%', height: f.h * 100 + '%' });
    const name = LibraryExtras.personLabel(t); b.innerHTML = '<span></span>'; b.firstChild.textContent = name === t ? String(i + 1) : name;
    b.title = `Edit ${name} only · double-click the label to rename`; b.setAttribute('aria-label', `Edit ${name} only`);
    b.firstChild.addEventListener('dblclick', e => { e.stopPropagation(); LibraryExtras.rename(t, b.firstChild); });
    b.addEventListener('click', e => { e.stopPropagation(); active.target = active.target === t ? 'All people' : t; commit(); buildPanel(); });
    frame.append(b);
  });
}
// run both skin networks in the background as soon as faces are known, so the first slider move is instant
function warm(photo) {
  const a = MotusFaces.get(photo);
  if (!a || !a.faces.length || !previewData || active !== photo || moduleId !== 'portrait') return;
  const done = () => { if (active === photo && needsAI(photo)) { setNotice(); scheduleRender(); } };
  // one after the other: the Motus Touch model first, then ABPN spot healing
  const pro = MotusPro.enabled && !MotusPro.ready(photo, previewData, a) && !MotusPro.busy(photo, previewData) ? MotusPro.prepare(photo, previewData, a).then(done) : Promise.resolve();
  pro.catch(e => console.error('Motus Touch failed', e)).then(() => {
    if (active === photo && !MotusABPN.ready(photo, previewData, a) && !MotusABPN.busy(photo, previewData)) return MotusABPN.prepare(photo, previewData, a, 1536).then(done);
  }).catch(e => console.error('ABPN failed', e));
}
function personCount() {
  const box = document.getElementById('target-chips'); if (!box || !active || moduleId !== 'portrait') return;
  const a = MotusFaces.get(active), n = a ? a.faces.length : 0;
  if (n === 1) { const t = document.createElement('span'); t.className = 'person-count'; t.textContent = '1 person identified'; box.replaceChildren(t); }
}
function afterPanel() {
  personCount();
  if (moduleId === 'portrait' && active) { ensureAnalysis(active); setNotice(MotusFaces.busy(active) ? 'Finding faces…' : null); warm(active); }
  drawFaces();
  LibraryExtras.decorateChips();
  LibraryExtras.faceToggle(moduleId === 'portrait' && screen === 'editor' && !!(active && MotusFaces.get(active)?.faces.length));
}

function onValue(c, value) {
  // choosing a color with its amount still at 0 would look like nothing happened
  const pairs = { 'Hair color': 'Hair/Hair color/Hair color amount', 'Iris color': 'Eyes/Eye color/Iris color amount', 'Skin tone': 'Skin retouching/Skin tone/Skin tone intensity' };
  if (pairs[c.label] && value !== 'Original' && (value !== 'Custom' || c.label === 'Hair color')) {
    const amtC = P.control('portrait/' + pairs[c.label]), key = draftKey({ ...amtC, owner: 'portrait' });
    if (!active.drafts[key]) { active.drafts[key] = 70; setTimeout(() => { const sc = $('#tool-scroll').scrollTop; buildPanel(); $('#tool-scroll').scrollTop = sc; }); }
  }
}
function onAction(c) {
  if (c.label === 'Detect faces') {
    MotusFaces.forget(active); outCache.clear(); setNotice('Finding faces…');
    MotusFaces.analyze(active, previewData, a => { notify(a.faces.length ? `${a.faces.length} ${a.faces.length === 1 ? 'person' : 'people'} found.` : 'No faces found.'); buildPanel(); scheduleRender(); }).catch(e => notify('Face detection failed: ' + e.message));
    return true;
  }
  if (c.label === 'Add individual target') {
    const a = MotusFaces.get(active); if (!a?.faces.length) { notify('No faces found yet. Try Detect faces.'); return true; }
    active.target = 'Person 1'; commit(); buildPanel(); notify('Editing Person 1 only. Click a face box on the photo to switch people.'); return true;
  }
  return false;
}

// previews of every hair colour on the selected person's own hair (the largest face when editing everyone)
const thumbCache = new Map();
function hairThumbs(photo, options) {
  const a = MotusFaces.get(photo); if (!a?.faces.length || !previewData || active !== photo) return null;
  let k = persons(photo).indexOf(photo.target);
  if (k < 0) k = a.faces.reduce((best, f, i) => f.w * f.h > a.faces[best].w * a.faces[best].h ? i : best, 0);
  const key = photo.id + '|' + k; if (thumbCache.has(key)) return thumbCache.get(key);
  const p = new Promise(res => setTimeout(() => {
    try { const s = Math.min(1, 520 / Math.max(previewData.width, previewData.height)), W = Math.round(previewData.width * s), H = Math.round(previewData.height * s);
      const src = document.createElement('canvas'); src.width = previewData.width; src.height = previewData.height; src.getContext('2d').putImageData(previewData, 0, 0);
      const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0, W, H);
      res(MotusRetouch.hairThumbs(x.getImageData(0, 0, W, H), a, k, options)); }
    catch (e) { console.error('Hair colour previews failed', e); thumbCache.delete(key); res(null); } }, 40));
  thumbCache.set(key, p); return p;
}

return { process, processFull, targets, afterPanel, onValue, onAction, hasEdits, hairThumbs, childDefaults: CHILD_DEFAULTS };
})();
