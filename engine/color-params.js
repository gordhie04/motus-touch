/* Maps Motus-Touch control values (photo.settings + photo.drafts) to engine inputs.
   Also marks which catalog controls are connected ("live") so the panel stops labelling them as previews. */
'use strict';

const MotusParams = (() => {

const HUES = ['Red','Orange','Yellow','Green','Aqua','Blue','Purple','Magenta'];
const SEL_CHANNELS = [...HUES,'Whites','Neutrals','Blacks'];
const index = new Map();          // "module/Section/Group/Label" -> control
const byId = new Map();
const internal = 'engine:';       // draft keys the engine keeps for itself (LUT ids, stats, curve points)

function register() {
  for (const m of FEATURE_MODULES) for (const s of m.sections) for (const g of s.groups) for (const c of g.controls) {
    index.set(`${m.id}/${s.title}/${g.title}/${c.label}`, c); byId.set(c.id, c);
  }
  const live = (path, extra = {}) => { const c = index.get(path); if (!c) { console.warn('Motus engine: missing control', path); return; } c.live = true; Object.assign(c, extra); };
  const C = 'color';
  live(`${C}/Basic/White balance/White balance`);
  for (const l of ['Texture','Clarity','Dehaze']) live(`${C}/Basic/Presence/${l}`);
  for (const l of ['Color profile','Import LUT profile']) live(`${C}/Profile & filters/Profile/${l}`);
  for (const l of ['Filter collection','Filter intensity','Import filter']) live(`${C}/Profile & filters/Filters/${l}`);
  const lv = index.get(`${C}/Levels/Channel/Levels channel`).id; live(`${C}/Levels/Channel/Levels channel`, { channelSwitch: true });
  for (const l of ['Input black','Input gamma','Input white','Output black','Output white']) live(`${C}/Levels/Channel/${l}`, { channelSelect: lv });
  for (const l of ['Sample black point','Sample white point']) live(`${C}/Levels/Channel/${l}`);
  const cv = index.get(`${C}/Curves/Curve editor/Curve channel`).id; live(`${C}/Curves/Curve editor/Curve channel`, { channelSwitch: true });
  live(`${C}/Curves/Curve editor/Curve mode`);
  for (const l of ['Highlights','Lights','Darks','Shadows']) live(`${C}/Curves/Curve editor/${l}`, { channelSelect: cv });
  for (const l of ['Add curve point','Reset curve']) live(`${C}/Curves/Curve editor/${l}`);
  for (const h of HUES) for (const n of ['hue','saturation','luminance']) live(`${C}/HSL / black & white/${h}/${h} ${n}`);
  for (const t of ['Shadows','Midtones','Highlights','Global']) for (const n of ['hue','saturation','luminance']) live(`${C}/Color grading/${t}/${t} ${n}`);
  for (const l of ['Blending','Balance']) live(`${C}/Color grading/Mix/${l}`);
  const sc = index.get(`${C}/Selective color/Channel/Color channel`).id; live(`${C}/Selective color/Channel/Color channel`, { channelSwitch: true });
  for (const l of ['Cyan','Magenta','Yellow','Black']) live(`${C}/Selective color/Channel/${l}`, { channelSelect: sc });
  live(`${C}/Selective color/Channel/Method`);
  for (const l of ['Amount','Radius','Detail','Masking']) live(`${C}/Detail/Sharpening/${l}`);
  for (const l of ['Luminance','Luminance detail','Luminance contrast','Color noise','Color detail','Color smoothness']) live(`${C}/Detail/Noise reduction/${l}`);
  for (const l of ['Amount','Size','Roughness']) live(`${C}/Grain/Film texture/${l}`);
  for (const l of ['Remove chromatic aberration','Distortion','Vignetting','Defringe purple','Defringe green']) live(`${C}/Lens corrections/Optics/${l}`);
  for (const l of ['Auto transform','Level','Vertical']) live(`${C}/Transform correction/Automatic/${l}`);
  for (const l of ['Vertical','Horizontal','Rotate','Aspect','Scale','X offset','Y offset']) live(`${C}/Transform correction/Manual/${l}`);
  live(`${C}/Transform correction/Edges/Constrain crop`);
  for (const l of ['Shadows tint','Red primary hue','Red primary saturation','Green primary hue','Green primary saturation','Blue primary hue','Blue primary saturation']) live(`${C}/Color calibration/Primaries/${l}`);
  const A = 'ai-color';
  for (const l of ['AI white balance','AI exposure','Apply auto color']) live(`${A}/Auto color correction/Balance/${l}`);
  for (const l of ['Match region','Choose reference image','Match strength','Match selected photos']) live(`${A}/Color consistency/Reference matching/${l}`);
  for (const l of ['Look','Look intensity','Apply look']) live(`${A}/AI color looks/Style/${l}`);
  for (const l of ['Import reference','Color match amount','Match color']) live(`${A}/AI color match/Reference/${l}`);
}

const control = path => index.get(path);
// value of a control for a photo; channel controls read the value stored for their selected channel
function value(photo, path, opts = {}) {
  const c = index.get(path); if (!c) return 0;
  if (opts.exclude?.has(c.id)) return c.value;
  let key = c.id;
  if (c.channelSelect) key += '@' + (opts.channel ?? channelOf(photo, c.channelSelect));
  const v = photo.drafts[key];
  return v === undefined || (v && typeof v === 'object' && v.queued) ? c.value : v;
}
function channelOf(photo, selectId) { return photo.drafts[selectId] ?? byId.get(selectId).value; }

/* ---------- curves & levels -> one 1024-entry RGB lookup ---------- */
function monotoneCurve(points) {
  const p = [...points].sort((a, b) => a[0] - b[0]);
  const n = p.length; if (n < 2) return x => x;
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = p[i + 1][0] - p[i][0] || 1e-6; dy[i] = (p[i + 1][1] - p[i][1]) / dx[i]; }
  m[0] = dy[0]; m[n - 1] = dy[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = dy[i - 1] * dy[i] <= 0 ? 0 : (dy[i - 1] + dy[i]) / 2;
  for (let i = 0; i < n - 1; i++) { if (dy[i] === 0) { m[i] = m[i + 1] = 0; continue; } const a = m[i] / dy[i], b = m[i + 1] / dy[i], s = a * a + b * b; if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * dy[i]; m[i + 1] = t * b * dy[i]; } }
  return x => {
    if (x <= p[0][0]) return p[0][1]; if (x >= p[n - 1][0]) return p[n - 1][1];
    let i = 0; while (x > p[i + 1][0]) i++;
    const h = dx[i], t = (x - p[i][0]) / h, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * p[i][1] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * p[i + 1][1] + (t3 - t2) * h * m[i + 1];
  };
}
function parametric(r) { // r = {shadows,darks,lights,highlights} in -100..100
  const centers = [.125, .375, .625, .875], amts = [r.shadows, r.darks, r.lights, r.highlights];
  if (amts.every(a => !a)) return x => x;
  const tbl = new Float32Array(257); let prev = 0;
  for (let i = 0; i <= 256; i++) {
    const x = i / 256; let d = 0;
    for (let k = 0; k < 4; k++) d += amts[k] / 100 * .22 * Math.exp(-(((x - centers[k]) / .16) ** 2));
    let y = Math.min(1, Math.max(0, x + d * Math.sin(Math.PI * x)));
    if (y < prev) y = prev; tbl[i] = prev = y;
  }
  return x => { const f = Math.min(1, Math.max(0, x)) * 256, i = Math.floor(f), t = f - i; return i >= 256 ? tbl[256] : tbl[i] * (1 - t) + tbl[i + 1] * t; };
}
function levelsFn(l) {
  if (l.inBlack === 0 && l.inWhite === 255 && l.gamma === 1 && l.outBlack === 0 && l.outWhite === 255) return x => x;
  return x => { let v = Math.min(1, Math.max(0, (x * 255 - l.inBlack) / Math.max(1, l.inWhite - l.inBlack))); v = v ** (1 / Math.max(.1, l.gamma)); return (l.outBlack + v * (l.outWhite - l.outBlack)) / 255; };
}
function curveTable(P) {
  const out = new Float32Array(1024 * 4), ch = ['Red','Green','Blue'];
  const L = Object.fromEntries(['RGB', ...ch].map(c => [c, levelsFn(P.levels[c])]));
  const pts = c => P.curves[c].points?.length ? monotoneCurve(P.curves[c].points) : (x => x);
  const C = Object.fromEntries(['RGB', ...ch].map(c => { const a = parametric(P.curves[c]), b = pts(c); return [c, x => b(a(x))]; }));
  for (let i = 0; i < 1024; i++) {
    const x = i / 1023;
    for (let k = 0; k < 3; k++) out[i * 4 + k] = C[ch[k]](C.RGB(L[ch[k]](L.RGB(x))));
    out[i * 4 + 3] = 1;
  }
  return out;
}

/* ---------- geometry ---------- */
const mul = (a, b) => { const r = new Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]; return r; };
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return [1,0,0,0,1,0,0,0,1];
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(v => v / det);
}
function homography(t, aspect) { // row-major forward map (source -> output) in height-normalized centered coords
  const rot = t.rotate / 100 * 10 * Math.PI / 180, s = 1 + t.scale / 100 * .5, asp = 2 ** (t.aspect / 100 * .5);
  const T = [1, 0, t.x / 100 * .5 * aspect, 0, 1, t.y / 100 * .5, 0, 0, 1];
  const S = [s * asp, 0, 0, 0, s / asp, 0, 0, 0, 1];
  const R = [Math.cos(rot), -Math.sin(rot), 0, Math.sin(rot), Math.cos(rot), 0, 0, 0, 1];
  const Pm = [1, 0, 0, 0, 1, 0, t.horizontal / 100 * .8 / aspect, t.vertical / 100 * .8, 1];
  return mul(T, mul(S, mul(R, Pm)));
}
function geometry(P, aspect) {
  const t = P.transform; let H = homography(t, aspect), inv = inv3(H);
  const distK = P.lens.distortion / 100 * .2;
  if (t.constrain) { // zoom in until no empty corners remain
    const ok = z => { for (let k = 0; k <= 40; k++) { const u = k / 40; for (const [x, y] of [[u - .5, -.5], [u - .5, .5], [-.5, u - .5], [.5, u - .5]]) {
      const px = x * aspect / z, py = y / z, w = inv[6] * px + inv[7] * py + inv[8]; let qx = (inv[0] * px + inv[1] * py + inv[2]) / w, qy = (inv[3] * px + inv[4] * py + inv[5]) / w;
      const f = 1 + distK * (qx * qx + qy * qy); qx *= f; qy *= f;
      if (Math.abs(qx) > aspect / 2 + 1e-4 || Math.abs(qy) > .5 + 1e-4) return false; } } return true; };
    let lo = 1, hi = 4; if (!ok(lo)) { for (let n = 0; n < 24; n++) { const m = (lo + hi) / 2; ok(m) ? hi = m : lo = m; } H = mul([hi, 0, 0, 0, hi, 0, 0, 0, 1], H); inv = inv3(H); }
  }
  // GLSL mat3 is column-major
  return { invH: new Float32Array([inv[0], inv[3], inv[6], inv[1], inv[4], inv[7], inv[2], inv[5], inv[8]]), distK };
}

/* ---------- calibration ---------- */
function rgb2hsl([r, g, b]) { const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn; let h = 0, s = 0;
  if (d > 1e-6) { s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; } return [h, s, l]; }
function hsl2rgb([h, s, l]) { if (s < 1e-6) return [l, l, l]; const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, f = t => { t = ((t % 1) + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }; return [f(h / 360 + 1 / 3), f(h / 360), f(h / 360 - 1 / 3)]; }
function calibration(c) {
  const cols = [[1, 0, 0, c.redHue, c.redSat], [0, 1, 0, c.greenHue, c.greenSat], [0, 0, 1, c.blueHue, c.blueSat]].map(([r, g, b, hue, sat]) => {
    const [h, s, l] = rgb2hsl([r, g, b]); let p = hsl2rgb([(h + hue / 100 * 20 + 360) % 360, s, l]);
    const y = .2126 * p[0] + .7152 * p[1] + .0722 * p[2]; const k = 1 + sat / 100 * .5; return p.map(v => y + (v - y) * k);
  });
  const rowSum = [0, 1, 2].map(i => cols[0][i] + cols[1][i] + cols[2][i]);
  return new Float32Array([0, 1, 2].flatMap(j => [0, 1, 2].map(i => cols[j][i] / rowSum[i])));
}

/* ---------- built-in looks as 3D LUTs ---------- */
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const LOOKS = {
  Natural: ([r, g, b]) => { const y = .2126 * r + .7152 * g + .0722 * b, s = 1.08; let o = [r, g, b].map(v => y + (v - y) * s); return o.map(v => v + .06 * Math.sin(Math.PI * v) * (v - .5)); },
  Portrait: ([r, g, b]) => { let o = [r * 1.03 + .01, g * 1.005 + .008, b * .97 + .012]; const y = .2126 * o[0] + .7152 * o[1] + .0722 * o[2];
    const [h, s, l] = rgb2hsl(o.map(v => Math.min(1, Math.max(0, v)))); const green = smooth(70, 100, h) * (1 - smooth(160, 190, h)); o = o.map(v => y + (v - y) * (1 - .35 * green));
    return o.map(v => .02 + v * .97 + .04 * Math.sin(Math.PI * v) * (v - .5)); },
  Film: ([r, g, b]) => { const y = .2126 * r + .7152 * g + .0722 * b; let o = [r, g, b].map(v => y + (v - y) * .85);
    const sh = 1 - smooth(0, .5, y), hi = smooth(.5, 1, y); o = [o[0] - .03 * sh + .04 * hi, o[1] + .01 * sh + .015 * hi, o[2] + .04 * sh - .03 * hi];
    return o.map(v => .055 + Math.min(1, Math.max(0, v)) * .88 + .05 * Math.sin(Math.PI * v) * (v - .5)); },
  'Black & white': ([r, g, b]) => { let y = .32 * r + .58 * g + .10 * b; y = y + .12 * Math.sin(Math.PI * y) * (y - .5) * 2; return [y, y, y]; }
};
const lutCache = new Map();
function builtinLut(name) {
  if (lutCache.has(name)) return lutCache.get(name);
  const fn = LOOKS[name]; if (!fn) return null; const n = 33, data = new Float32Array(n * n * n * 3);
  let i = 0; for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) { const o = fn([r / (n - 1), g / (n - 1), b / (n - 1)]); data[i++] = o[0]; data[i++] = o[1]; data[i++] = o[2]; }
  const lut = { size: n, data, key: 'builtin:' + name }; lutCache.set(name, lut); return lut;
}
function parseCube(text) {
  let size = 0, min = [0, 0, 0], max = [1, 1, 1]; const vals = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'LUT_3D_SIZE') size = +parts[1];
    else if (parts[0] === 'DOMAIN_MIN') min = parts.slice(1, 4).map(Number);
    else if (parts[0] === 'DOMAIN_MAX') max = parts.slice(1, 4).map(Number);
    else if (parts[0] === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported. Use a 3D .cube file.');
    else if (/^[-+.\d]/.test(parts[0]) && parts.length >= 3) vals.push(+parts[0], +parts[1], +parts[2]);
  }
  if (size < 2 || size > 128 || vals.length !== size ** 3 * 3 || vals.some(v => !Number.isFinite(v))) throw new Error('This .cube file could not be read.');
  const data = new Float32Array(vals.length); for (let i = 0; i < vals.length; i++) { const k = i % 3; data[i] = (vals[i] - min[k]) / ((max[k] - min[k]) || 1); }
  return { size, data };
}

/* ---------- everything for one render ---------- */
function build(photo, opts = {}) {
  const v = (path, o = {}) => { const x = value(photo, path, { ...opts, ...o }); return typeof x === 'number' ? x : Number.isFinite(+x) && typeof x !== 'boolean' && x !== '' ? +x : x; };
  const C = 'color', s = { ...photo.settings, ...(opts.settings || {}) };
  const P = { basic: s };
  P.presence = { texture: v(`${C}/Basic/Presence/Texture`), clarity: v(`${C}/Basic/Presence/Clarity`), dehaze: v(`${C}/Basic/Presence/Dehaze`) };
  P.profile = v(`${C}/Profile & filters/Profile/Color profile`);
  P.filter = { name: v(`${C}/Profile & filters/Filters/Filter collection`), amount: v(`${C}/Profile & filters/Filters/Filter intensity`) };
  P.levels = {}; P.curves = {};
  for (const ch of ['RGB','Red','Green','Blue']) {
    const g = l => v(`${C}/Levels/Channel/${l}`, { channel: ch });
    P.levels[ch] = { inBlack: g('Input black'), gamma: g('Input gamma'), inWhite: g('Input white'), outBlack: g('Output black'), outWhite: g('Output white') };
    const q = l => v(`${C}/Curves/Curve editor/${l}`, { channel: ch });
    P.curves[ch] = { shadows: q('Shadows'), darks: q('Darks'), lights: q('Lights'), highlights: q('Highlights'), points: opts.exclude?.has(control(`${C}/Curves/Curve editor/Curve channel`).id) ? null : photo.drafts[internal + 'curve@' + ch] || null };
  }
  P.hsl = HUES.map(h => ['hue','saturation','luminance'].map(n => v(`${C}/HSL / black & white/${h}/${h} ${n}`)));
  P.grading = Object.fromEntries(['Shadows','Midtones','Highlights','Global'].map(t => [t, ['hue','saturation','luminance'].map(n => v(`${C}/Color grading/${t}/${t} ${n}`))]));
  P.gradeMix = { blending: v(`${C}/Color grading/Mix/Blending`), balance: v(`${C}/Color grading/Mix/Balance`) };
  P.selective = SEL_CHANNELS.map(ch => ['Cyan','Magenta','Yellow','Black'].map(l => v(`${C}/Selective color/Channel/${l}`, { channel: ch })));
  P.selRelative = v(`${C}/Selective color/Channel/Method`) === 'Relative';
  const d = l => v(`${C}/Detail/Sharpening/${l}`), n = l => v(`${C}/Detail/Noise reduction/${l}`), gr = l => v(`${C}/Grain/Film texture/${l}`);
  P.sharpen = { amount: d('Amount'), radius: d('Radius'), detail: d('Detail'), masking: d('Masking') };
  P.noise = { lum: n('Luminance'), lumDetail: n('Luminance detail'), lumContrast: n('Luminance contrast'), color: n('Color noise'), colorDetail: n('Color detail'), colorSmooth: n('Color smoothness') };
  P.grain = { amount: gr('Amount'), size: gr('Size'), roughness: gr('Roughness') };
  const o = l => v(`${C}/Lens corrections/Optics/${l}`);
  P.lens = { ca: !!o('Remove chromatic aberration'), distortion: o('Distortion'), vignetting: o('Vignetting'), defPurple: o('Defringe purple'), defGreen: o('Defringe green') };
  const tm = l => v(`${C}/Transform correction/Manual/${l}`);
  P.transform = { vertical: tm('Vertical'), horizontal: tm('Horizontal'), rotate: tm('Rotate'), aspect: tm('Aspect'), scale: tm('Scale'), x: tm('X offset'), y: tm('Y offset'), constrain: !!v(`${C}/Transform correction/Edges/Constrain crop`) };
  const cb = l => v(`${C}/Color calibration/Primaries/${l}`);
  P.calib = { shadowsTint: cb('Shadows tint'), redHue: cb('Red primary hue'), redSat: cb('Red primary saturation'), greenHue: cb('Green primary hue'), greenSat: cb('Green primary saturation'), blueHue: cb('Blue primary hue'), blueSat: cb('Blue primary saturation') };
  const A = 'ai-color';
  P.look = { name: v(`${A}/AI color looks/Style/Look`), amount: v(`${A}/AI color looks/Style/Look intensity`) };
  P.refConsistency = { stats: photo.drafts[internal + 'ref.consistency'] || null, amount: v(`${A}/Color consistency/Reference matching/Match strength`) };
  P.refMatch = { stats: photo.drafts[internal + 'ref.match'] || null, amount: v(`${A}/AI color match/Reference/Color match amount`) };
  P.ca = photo.drafts[internal + 'ca'] || null;
  P.lutIds = { profile: photo.drafts[internal + 'lut.profile'] || null, filter: photo.drafts[internal + 'lut.filter'] || null };
  if (opts.exclude) for (const k of ['ref.consistency','ref.match']) if ([...opts.exclude].some(id => id.startsWith('ai-color.' + (k === 'ref.match' ? 'ai-color-match' : 'color-consistency')))) P[k === 'ref.match' ? 'refMatch' : 'refConsistency'].amount = 0;
  return P;
}

// is anything beyond the basic sliders in use? (status text + "original preserved")
function hasLiveEdits(photo) {
  for (const [k, val] of Object.entries(photo.drafts)) {
    if (k.startsWith(internal)) { if (k.startsWith(internal + 'curve@') && val?.length) return true; continue; }
    const c = byId.get(k.split('@')[0]); if (!c?.live || c.type === 'action' || c.channelSwitch) continue;
    if (c.label === 'Curve mode' || c.label === 'Method' || c.label === 'Match region' || c.label === 'White balance') continue;
    if (val !== c.value) return true;
  }
  return false;
}

/* env: {w,h,fullW,fullH,stats:{lab,air}, luts:{profile,filter}}  -> uniforms */
function toUniforms(P, env) {
  const scale = env.w / env.fullW, longEdge = Math.max(env.fullW, env.fullH), aspect = env.w / env.h;
  const b = P.basic, geo = geometry(P, aspect);
  const caR = P.lens.ca && P.ca ? P.ca.r : 0, caB = P.lens.ca && P.ca ? P.ca.b : 0;
  const nz = P.noise;
  const lutFor = (name, custom) => name === 'Custom' ? custom : name === 'Black & white' || LOOKS[name] ? builtinLut(name) : null;
  const filterLut = P.filter.amount > 0 ? lutFor(P.filter.name, env.luts.filter) : null;
  const lookLut = P.look.amount > 0 ? lutFor(P.look.name, env.luts.filter) : null;
  const profileLut = P.profile === 'Custom LUT' ? env.luts.profile : null;
  const bw = P.profile === 'Black & white';
  const g = k => { const [h, s, l] = P.grading[k]; return [h, s / 100, l / 100]; };
  const ref = (r, statKey) => r.stats && r.amount > 0 && env.stats.lab ? { amt: r.amount / 100, rm: r.stats.mean, rs: r.stats.std, sm: env.stats.lab.mean, ss: env.stats.lab.std } : { amt: 0, rm: [0,0,0], rs: [1,1,1], sm: [0,0,0], ss: [1,1,1] };
  const r1 = ref(P.refConsistency), r2 = ref(P.refMatch);
  return {
    luts: { profile: profileLut, filter: filterLut, look: lookLut },
    curves: curveTable(P),
    fullSize: [env.fullW, env.fullH],
    sigmas: { texture: Math.max(1, .0012 * longEdge) * scale + .6, clarity: .012 * longEdge * scale, dehaze: .02 * longEdge * scale, color: (2 + nz.colorSmooth / 100 * 10) * Math.max(scale, .35) },
    geom: { invH: geo.invH, aspect, distK: geo.distK, caR, caB },
    nr: { lumAmt: nz.lum / 100, lumRadius: Math.max(1, (1 + nz.lum / 100 * 3) * scale), rangeSigma: .15 - nz.lumDetail / 100 * .12, lumContrast: nz.lumContrast / 100,
          colAmt: nz.color / 100, colDetail: nz.colorDetail / 100, defPurple: P.lens.defPurple / 100, defGreen: P.lens.defGreen / 100 },
    color: {
      exposure: b.exposure, contrast: b.contrast, brightness: b.brightness, highlights: b.highlights, shadows: b.shadows, whites: b.whites, blacks: b.blacks,
      temperature: b.temperature, tint: b.tint, vibrance: b.vibrance, saturation: b.saturation,
      texAmt: P.presence.texture / 100, clarAmt: P.presence.clarity / 100, dehazeAmt: P.presence.dehaze / 100, airLight: env.stats.air || [1, 1, 1],
      bw: bw ? 1 : 0, bwMix: new Float32Array(P.hsl.map(x => x[2] / 100)),
      hsl: new Float32Array(bw ? 24 : P.hsl.flatMap(([h, s, l]) => [h / 100, s / 100, l / 100])),
      gradeS: g('Shadows'), gradeM: g('Midtones'), gradeH: g('Highlights'), gradeG: g('Global'),
      gradeBlend: P.gradeMix.blending / 100, gradeBal: P.gradeMix.balance / 100,
      sel: new Float32Array(P.selective.flatMap(x => x.map(y => y / 100))), selRelative: P.selRelative ? 1 : 0,
      calib: calibration(P.calib), shadowTint: P.calib.shadowsTint / 100,
      ref1Amt: r1.amt, ref1Mean: r1.rm, ref1Std: r1.rs, src1Mean: r1.sm, src1Std: r1.ss,
      ref2Amt: r2.amt, ref2Mean: r2.rm, ref2Std: r2.rs, src2Mean: r2.sm, src2Std: r2.ss,
      profileAmt: profileLut ? 1 : 0, filterAmt: filterLut ? P.filter.amount / 100 : 0, lookAmt: lookLut ? P.look.amount / 100 : 0,
      vignette: P.lens.vignetting / 100, aspect
    },
    finish: { shAmt: P.sharpen.amount / 100, shRadius: Math.max(.7, (.5 + P.sharpen.radius / 100 * 2.5) * scale), shDetail: P.sharpen.detail / 100, shMask: P.sharpen.masking / 100,
              grainAmt: P.grain.amount / 100, grainSize: 1 + P.grain.size / 100 * 3, grainRough: P.grain.roughness / 100, seed: env.seed || .37 }
  };
}

return { register, control, value, build, toUniforms, hasLiveEdits, parseCube, builtinLut, homography, inv3, byId, index, internal, HUES, SEL_CHANNELS, monotoneCurve };
})();
