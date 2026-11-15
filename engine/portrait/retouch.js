/* Portrait retouching on the CPU, per face, before the color engine.
   Blemishes and skin evening come from the ABPN networks (abpn.js); everything else works on the face's own region using the parsed masks (skin, eyes, lips, teeth, brows, hair)
   and the 5 YuNet landmarks for zones (forehead, under-eyes, smile lines ...).
   Same code for the preview and the full-resolution export: sizes are relative to the face width. */
'use strict';

const MotusRetouch = (() => {
const FL = MotusFaces.L;

/* ---------- small image toolkit (Float32 planes) ---------- */
function boxH(s, d, w, h, r) { const k = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) { const o = y * w; let acc = s[o] * (r + 1); for (let i = 1; i <= r; i++) acc += s[o + Math.min(i, w - 1)];
    for (let x = 0; x < w; x++) { d[o + x] = acc * k; acc += s[o + Math.min(x + r + 1, w - 1)] - s[o + Math.max(x - r, 0)]; } } }
function boxV(s, d, w, h, r) { const k = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) { let acc = s[x] * (r + 1); for (let i = 1; i <= r; i++) acc += s[Math.min(i, h - 1) * w + x];
    for (let y = 0; y < h; y++) { d[y * w + x] = acc * k; acc += s[Math.min(y + r + 1, h - 1) * w + x] - s[Math.max(y - r, 0) * w + x]; } } }
function boxBlur(src, w, h, sigma) {   // 3 box passes ~ gaussian
  const r = Math.max(1, Math.round(sigma)); let a = Float32Array.from(src), b = new Float32Array(src.length);
  for (let p = 0; p < 3; p++) { boxH(a, b, w, h, r); boxV(b, a, w, h, r); }
  return a;
}
// large radii: blur a downscaled copy and scale back up (smooth result, a fraction of the work)
function blur(src, w, h, sigma) {
  const f = Math.floor(sigma / 3);
  if (f < 2 || w < f * 8 || h < f * 8) return boxBlur(src, w, h, sigma);
  const dw = Math.ceil(w / f), dh = Math.ceil(h / f), small = new Float32Array(dw * dh), cnt = new Float32Array(dw * dh);
  for (let y = 0; y < h; y++) { const sy = ((y / f) | 0) * dw; for (let x = 0; x < w; x++) { const k = sy + ((x / f) | 0); small[k] += src[y * w + x]; cnt[k]++; } }
  for (let k = 0; k < small.length; k++) small[k] /= cnt[k];
  const b = boxBlur(small, dw, dh, sigma / f), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { let fy = (y + .5) / f - .5; if (fy < 0) fy = 0; const y0 = Math.min(dh - 1, fy | 0), y1 = Math.min(dh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) { let fx = (x + .5) / f - .5; if (fx < 0) fx = 0; const x0 = Math.min(dw - 1, fx | 0), x1 = Math.min(dw - 1, x0 + 1), tx = fx - x0;
      out[y * w + x] = (b[y0 * dw + x0] * (1 - tx) + b[y0 * dw + x1] * tx) * (1 - ty) + (b[y1 * dw + x0] * (1 - tx) + b[y1 * dw + x1] * tx) * ty; } }
  return out;
}
function mblur(src, m, w, h, sigma) { const n = src.length, sm = new Float32Array(n); for (let i = 0; i < n; i++) sm[i] = src[i] * m[i];
  const a = blur(sm, w, h, sigma), b = blur(m, w, h, sigma); for (let i = 0; i < n; i++) a[i] = b[i] > 1e-4 ? a[i] / b[i] : src[i]; return a; }
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const luma = (r, g, b) => .2126 * r + .7152 * g + .0722 * b;
function hsl2rgb(h, s, l) { if (s <= 0) return [l, l, l]; const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, f = t => { t = ((t % 1) + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }; return [f(h / 360 + 1 / 3), f(h / 360), f(h / 360 - 1 / 3)]; }

/* ---------- zones from the 5 landmarks ---------- */
function zoneMaker(kps, rx, ry) {
  const re = [kps[0][0] - rx, kps[0][1] - ry], le = [kps[1][0] - rx, kps[1][1] - ry], nose = [kps[2][0] - rx, kps[2][1] - ry], rm = [kps[3][0] - rx, kps[3][1] - ry], lm = [kps[4][0] - rx, kps[4][1] - ry];
  const E = [(re[0] + le[0]) / 2, (re[1] + le[1]) / 2], d = Math.hypot(le[0] - re[0], le[1] - re[1]) || 1;
  const ux = (le[0] - re[0]) / d, uy = (le[1] - re[1]) / d, vx = -uy, vy = ux;   // u along eyes (image left->right), v down
  const toFace = (x, y) => { const dx = x - E[0], dy = y - E[1]; return [(dx * ux + dy * uy) / d, (dx * vx + dy * vy) / d]; };
  const pf = p => toFace(p[0], p[1]);
  const pts = { re: pf(re), le: pf(le), nose: pf(nose), rm: pf(rm), lm: pf(lm) };
  // soft ellipse in face units
  const ell = (cu, cv, ru, rv) => (x, y) => { const [u, v] = toFace(x, y), q = ((u - cu) / ru) ** 2 + ((v - cv) / rv) ** 2; return q >= 1 ? 0 : (1 - q) ** 1.5; };
  return { d, toFace, pts, ell };
}

/* ---------- stage inputs (a stage is recomputed only when one of these changes) ---------- */
const FR = 'Blemish removal/Face refinement/', WR = 'Blemish removal/Facial wrinkles/';
const STAGE1 = [FR + 'Remove glasses glare', 'Eyes/Brightness/Remove glasses glare', FR + 'Freckles & acne', FR + 'Freckles', FR + 'Acne', FR + 'Face mole removal', FR + 'Beard protection',
  ...['Forehead wrinkles', 'Eleven lines', 'Eye wrinkles', 'Nasal wrinkles', 'Smile line · left', 'Smile line · right', 'Cheek wrinkles', 'Marionette lines', 'Perioral wrinkles'].map(x => WR + x)];
const STAGE2 = [...['Even with dodge & burn', 'Textured smoothing', 'Frequency separation · high', 'Frequency separation · low', 'Skin softening'].map(x => 'Skin retouching/Facial skin/' + x),
  FR + 'Dark circles', FR + 'Eye bags', FR + 'Lower eyelids protection', FR + 'Reduce face shine',
  ...['Unify face complexion', 'Skin tone', 'Skin tone intensity', 'Skin temperature', 'Skin tint', 'Skin radiance', 'Rosy complexion'].map(x => 'Skin retouching/Skin tone/' + x),
  ...['Texture finish', 'Glossiness', 'Texture', 'Clarity'].map(x => 'Skin retouching/Skin texture/' + x), 'Makeup/Definition/Highlight', 'Makeup/Definition/Contour'];

/* ---------- main per-face retouch ---------- */
function applyFace(out, face, V, master, W, H, keep) {
  const ck = W + 'x' + H; face._ctx = face._ctx || {}; let C = face._ctx[ck];
  if (!C) { C = region(out, face, W, H); if (!C) return; if (keep) face._ctx[ck] = C; }
  const { w, h, n, rx0, ry0, lbl, skin, skinOnly, FW, Z } = C, px = out.data;
  const R = Float32Array.from(C.R0), G = Float32Array.from(C.G0), B = Float32Array.from(C.B0), R0 = C.R0, G0 = C.G0, B0 = C.B0;
  const is = (...ls) => { const m = new Float32Array(n); for (let i = 0; i < n; i++) if (ls.includes(lbl[i])) m[i] = 1; return m; };
  const soft = (m, s) => { const b = blur(m, w, h, Math.max(1, FW * s)); for (let i = 0; i < n; i++) b[i] *= m[i] > 0 ? 1 : .0; return b; };
  const erode = (m, s) => { const b = blur(m, w, h, Math.max(1, FW * s)); const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = b[i] > .97 ? 1 : 0; return o; };
  const zone = (f, mask) => { const z = new Float32Array(n); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (!mask || mask[i]) z[i] = f(x, y); } return z; };
  const P = (path, def = 0) => { const v = V(path); return v === undefined ? def : v; };
  const amt = path => (+P(path) || 0) / 100 * master;
  const zp = Z.pts;
  const keyOf = paths => master + '|' + paths.map(p => P(p)).join('|');
  const aiKey = face.ai && face.ai[W + 'x' + H] ? 'ai' : '-', K1 = aiKey + keyOf(STAGE1), K2 = K1 + '#' + keyOf(STAGE2);
  const restore = st => { R.set(st[0]); G.set(st[1]); B.set(st[2]); };
  const save = () => [R.slice(), G.slice(), B.slice()];
  if (C.k2 === K2) restore(C.s2); else {
  if (C.k1 === K1) restore(C.s1); else {
  
  /* ----- glasses glare ----- */
  const glare = Math.max(amt('Blemish removal/Face refinement/Remove glasses glare'), amt('Eyes/Brightness/Remove glasses glare'));
  if (glare > 0) {
    const gm = is(FL.glasses), eyeBand = Z.ell(0, 0, 1.5, .7); let any = 0;   // glasses only count near the eyes
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (gm[i] && eyeBand(x, y) <= 0) gm[i] = 0; any += gm[i]; }
    if (any > 20) {
      const Y = new Float32Array(n); for (let i = 0; i < n; i++) Y[i] = luma(R[i], G[i], B[i]);
      const base = mblur(Y, gm, w, h, FW * .03), hot = new Float32Array(n);
      for (let i = 0; i < n; i++) if (gm[i]) { const mx = Math.max(R[i], G[i], B[i]), mn = Math.min(R[i], G[i], B[i]); hot[i] = clamp01((Y[i] - base[i] - .06) / .15) * clamp01(1 - (mx - mn) * 4); }
      const keep = new Float32Array(n); for (let i = 0; i < n; i++) keep[i] = gm[i] * (hot[i] < .1 ? 1 : 0);
      const fr = mblur(R, keep, w, h, FW * .02), fg = mblur(G, keep, w, h, FW * .02), fb = mblur(B, keep, w, h, FW * .02), hs = blur(hot, w, h, FW * .004);
      for (let i = 0; i < n; i++) { const a = clamp01(hs[i] * 1.6) * glare; if (a > 0) { R[i] += (fr[i] - R[i]) * a; G[i] += (fg[i] - G[i]) * a; B[i] += (fb[i] - B[i]) * a; } }
    }
  }

  /* ----- blemishes: ABPN healed spots, chosen per spot by kind (acne, freckle, mole) and confidence ----- */
  const ai = face.ai && face.ai[W + 'x' + H];
  const fa = amt('Blemish removal/Face refinement/Freckles & acne'), frW = (+P('Blemish removal/Face refinement/Freckles', 100)) / 100, acW = (+P('Blemish removal/Face refinement/Acne', 100)) / 100;
  const acne = fa * acW, freck = fa * frW, mole = P('Blemish removal/Face refinement/Face mole removal') ? master : 0;
  const beard = !!P('Blemish removal/Face refinement/Beard protection'), noseV = Z.pts.nose[1] + .1, beardSkip = beard ? (x, y) => Z.toFace(x, y)[1] > noseV : null;
  let touched = null;
  if (ai && ai.spots.length && (acne > 0 || freck > 0 || mole > 0)) {
    // acne and bumps: ABPN repaints them; a weaker slider keeps only the spots the network is surest about
    const gate = ai.spots.map(sp => { const w = sp.kind === 'mole' ? mole : sp.kind === 'acne' ? acne : freck; return w > 0 ? clamp01((sp.peak - (.85 - .5 * Math.min(1, w))) / .1) : 0; });
    touched = new Uint8Array(n); healSpots(R, G, B, ai, gate, w, h, rx0, ry0, beardSkip, touched);
  }
  if (freck > 0 || mole > 0) {
    // freckles and small dark marks: the Evoto-trained spot model (needs no AI download)
    if (!C.spots) {
      const features = is(FL.lbrow, FL.rbrow, FL.leye, FL.reye, FL.glasses, FL.mouth, FL.ulip, FL.llip, FL.hair);
      const near = blur(features, w, h, FW * .02), core = erode(is(FL.skin, FL.nose), .012), allow = new Uint8Array(n);
      for (let i = 0; i < n; i++) allow[i] = core[i] && near[i] < .15 ? 1 : 0;
      C.spots = MotusSpots.analyse(C.R0, C.G0, C.B0, allow, w, h, FW, blur);
    }
    MotusSpots.apply(R, G, B, C.spots, Math.max(freck, mole ? .6 : 0), mole > 0, w, h, touched, beardSkip);
  }

  /* ----- wrinkles: remove dark mid-frequency lines inside each zone ----- */
  const wr = [];
  const add = (path, f) => { const a = amt('Blemish removal/Facial wrinkles/' + path); if (a > 0) wr.push([a, f]); };
  add('Forehead wrinkles', Z.ell(0, -1.0, .95, .38));
  add('Eleven lines', Z.ell(0, -.42, .2, .26));
  add('Eye wrinkles', (x, y) => Math.max(Z.ell(zp.re[0] - .36, zp.re[1] + .05, .22, .25)(x, y), Z.ell(zp.le[0] + .36, zp.le[1] + .05, .22, .25)(x, y)));
  add('Nasal wrinkles', Z.ell(0, -.05, .25, .2));
  add('Smile line · left', Z.ell((zp.nose[0] + zp.rm[0]) / 2 - .08, (zp.nose[1] + zp.rm[1]) / 2 + .05, .16, .36));
  add('Smile line · right', Z.ell((zp.nose[0] + zp.lm[0]) / 2 + .08, (zp.nose[1] + zp.lm[1]) / 2 + .05, .16, .36));
  add('Cheek wrinkles', (x, y) => Math.max(Z.ell(-.72, .55, .26, .3)(x, y), Z.ell(.72, .55, .26, .3)(x, y)));
  add('Marionette lines', (x, y) => Math.max(Z.ell(zp.rm[0] - .02, zp.rm[1] + .32, .13, .26)(x, y), Z.ell(zp.lm[0] + .02, zp.lm[1] + .32, .13, .26)(x, y)));
  add('Perioral wrinkles', Z.ell((zp.rm[0] + zp.lm[0]) / 2, (zp.rm[1] + zp.lm[1]) / 2, .62, .42));
  if (wr.length) {
    const Y = new Float32Array(n); for (let i = 0; i < n; i++) Y[i] = luma(R[i], G[i], B[i]);
    const a = mblur(Y, skin, w, h, FW * .004), b = mblur(Y, skin, w, h, FW * .022);
    const strength = new Float32Array(n);
    for (const [k, f] of wr) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (skin[i]) strength[i] = Math.max(strength[i], f(x, y) * k); }
    const st = blur(strength, w, h, FW * .01);
    for (let i = 0; i < n; i++) if (st[i] > 0 && skin[i]) { const band = a[i] - b[i]; if (band < 0) { const lift = -band * st[i] * 1.1; R[i] += lift; G[i] += lift; B[i] += lift; } }
  }


  if (keep) { C.k1 = K1; C.s1 = save(); } }
    /* ----- skin: frequency separation, then tone work on the low layer ----- */
  const even = amt('Skin retouching/Facial skin/Even with dodge & burn'), aiE = face.ai && face.ai[W + 'x' + H];
  if (even > 0 && aiE) blendLayer(R, G, B, aiE, even, soft(is(FL.skin, FL.nose, FL.neck, FL.lear, FL.rear), .01), w, h, rx0, ry0);
  // the frequency-separation work below is costly: skip it when none of its controls are in use
  const IDLE = { 'Blemish removal/Face refinement/Lower eyelids protection': 1, 'Skin retouching/Facial skin/Even with dodge & burn': 1 };
  const s2on = STAGE2.some(p => { if (IDLE[p]) return false; const v = P(p); return v && v !== 'Original' && v !== 'Custom' && +v !== 0; });
  if (s2on) {
  const sigF = Math.max(1, FW * .006);
  const denF = blur(skin, w, h, sigF), lowOf = c => { const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = c[i] * skin[i]; const b = blur(o, w, h, sigF); for (let i = 0; i < n; i++) b[i] = denF[i] > 1e-4 ? b[i] / denF[i] : c[i]; return b; };
  const lowR = lowOf(R), lowG = lowOf(G), lowB = lowOf(B);
  const hiR = new Float32Array(n), hiG = new Float32Array(n), hiB = new Float32Array(n);
  for (let i = 0; i < n; i++) { hiR[i] = R[i] - lowR[i]; hiG[i] = G[i] - lowG[i]; hiB[i] = B[i] - lowB[i]; }
  const skinSoft = soft(erode(skin, .012), .01);
  const lowAdj = (fn) => { for (let i = 0; i < n; i++) if (skinSoft[i] > 0) fn(i, skinSoft[i]); };

  // even skin (dodge & burn) / textured smoothing / low-frequency smoothing: pull blotches toward a broader base
  const tsm = amt('Skin retouching/Facial skin/Textured smoothing'), flo = amt('Skin retouching/Facial skin/Frequency separation · low');
  const evenAmt = Math.min(1, tsm * .7 + flo * .6);
  if (evenAmt > 0) {
    const s2 = FW * (.03 + .02 * flo);
    const bR = mblur(lowR, skin, w, h, s2), bG = mblur(lowG, skin, w, h, s2), bB = mblur(lowB, skin, w, h, s2);
    lowAdj((i, m) => { const k = evenAmt * m; lowR[i] += (bR[i] - lowR[i]) * k; lowG[i] += (bG[i] - lowG[i]) * k; lowB[i] += (bB[i] - lowB[i]) * k; });
  }

  // dark circles & eye bags: under-eye zones, kept away from the lash line by "lower eyelids protection"
  const dc = amt('Blemish removal/Face refinement/Dark circles'), bags = amt('Blemish removal/Face refinement/Eye bags');
  if (dc > 0 || bags > 0) {
    const prot = (+P('Blemish removal/Face refinement/Lower eyelids protection', 100)) / 100;
    const eyes = is(FL.leye, FL.reye), nearEye = blur(eyes, w, h, FW * .025);
    const under = zone((x, y) => Math.max(Z.ell(zp.re[0], zp.re[1] + .3, .3, .17)(x, y), Z.ell(zp.le[0], zp.le[1] + .3, .3, .17)(x, y)), skin);
    const ref = zone((x, y) => Math.max(Z.ell(zp.re[0], zp.re[1] + .62, .26, .14)(x, y), Z.ell(zp.le[0], zp.le[1] + .62, .26, .14)(x, y)), skin);
    const cR = mblur(lowR, ref, w, h, FW * .08), cG = mblur(lowG, ref, w, h, FW * .08), cB = mblur(lowB, ref, w, h, FW * .08);
    const bR = mblur(lowR, skin, w, h, FW * .035), bG = mblur(lowG, skin, w, h, FW * .035), bB = mblur(lowB, skin, w, h, FW * .035);
    const us = blur(under, w, h, FW * .02);
    for (let i = 0; i < n; i++) { const z = us[i] * skin[i] * (1 - prot * clamp01(nearEye[i] * 3)); if (z <= 0) continue;
      if (dc > 0) { const k = dc * z * .9, yr = luma(cR[i], cG[i], cB[i]), yl = luma(lowR[i], lowG[i], lowB[i]); if (yr > yl) { lowR[i] += (cR[i] - lowR[i]) * k; lowG[i] += (cG[i] - lowG[i]) * k; lowB[i] += (cB[i] - lowB[i]) * k; } }
      if (bags > 0) { const k = bags * z; lowR[i] += (bR[i] - lowR[i]) * k; lowG[i] += (bG[i] - lowG[i]) * k; lowB[i] += (bB[i] - lowB[i]) * k; } }
  }

  // complexion & tone
  const unify = amt('Skin retouching/Skin tone/Unify face complexion');
  const temp = (+P('Skin retouching/Skin tone/Skin temperature')) / 100 * master, tint = (+P('Skin retouching/Skin tone/Skin tint')) / 100 * master;
  const radiance = amt('Skin retouching/Skin tone/Skin radiance'), rosy = (+P('Skin retouching/Skin tone/Rosy complexion')) / 100 * master;
  const toneSel = P('Skin retouching/Skin tone/Skin tone', 'Original'), toneAmt = amt('Skin retouching/Skin tone/Skin tone intensity');
  // undertone presets: hue shift (deg) and chroma scale; lightness is never changed
  const TONES = { 'Tone 1': [-10, .95], 'Tone 2': [-5, 1.08], 'Tone 3': [3, 1.02], 'Tone 4': [8, 1.12], 'Tone 5': [14, .92], 'Tone 6': [6, 1.22], 'Tone 7': [-3, 1.15], 'Tone 8': [10, .82] };
  const tone = toneAmt > 0 ? TONES[toneSel] : null;
  if (unify > 0 || temp || tint || radiance > 0 || rosy || tone) {
    const big = FW * .1, mR = mblur(lowR, skin, w, h, big), mG = mblur(lowG, skin, w, h, big), mB = mblur(lowB, skin, w, h, big);
    const cheeks = rosy ? zone((x, y) => Math.max(Z.ell(-.62, .62, .28, .22)(x, y), Z.ell(.62, .62, .28, .22)(x, y)), skin) : null;
    const ch = cheeks ? blur(cheeks, w, h, FW * .04) : null;
    lowAdj((i, m) => {
      let r = lowR[i], g = lowG[i], b = lowB[i]; const y = luma(r, g, b);
      if (unify > 0) { const my = luma(mR[i], mG[i], mB[i]), k = unify * .8; r += ((mR[i] - my + y) - r) * k; g += ((mG[i] - my + y) - g) * k; b += ((mB[i] - my + y) - b) * k; }
      if (temp) { r += temp * .05; b -= temp * .05; }
      if (tint) { g -= tint * .04; r += tint * .015; b += tint * .015; }
      if (tone) { const yy = luma(r, g, b), cr = r - yy, cb = b - yy, ang = tone[0] * toneAmt * Math.PI / 180, sc = 1 + (tone[1] - 1) * toneAmt;
        const ca = Math.cos(ang), sa = Math.sin(ang), nr = (cr * ca - cb * sa) * sc, nb = (cr * sa + cb * ca) * sc; r = yy + nr; b = yy + nb; g = (yy - .2126 * r - .0722 * b) / .7152; }
      if (radiance > 0) { const lift = radiance * .08 * Math.sin(Math.PI * clamp01(y)); r += lift; g += lift; b += lift; }
      if (ch && ch[i] > 0) { const k = rosy * ch[i]; r += k * .06; g -= k * .025; b -= k * .01; }
      lowR[i] += (r - lowR[i]) * m; lowG[i] += (g - lowG[i]) * m; lowB[i] += (b - lowB[i]) * m;
    });
  }

  // makeup definition: highlight & contour zones (dodge & burn)
  const hl = amt('Makeup/Definition/Highlight'), ct = amt('Makeup/Definition/Contour');
  if (hl > 0 || ct > 0) {
    const hz = zone((x, y) => Math.max(Z.ell(0, .25, .08, .32)(x, y), Z.ell(0, -.78, .28, .2)(x, y), Z.ell(-.62, .28, .22, .12)(x, y), Z.ell(.62, .28, .22, .12)(x, y)), skin);
    const cz = zone((x, y) => Math.max(Z.ell(-.84, .82, .2, .32)(x, y), Z.ell(.84, .82, .2, .32)(x, y), Z.ell(-.16, .3, .06, .28)(x, y), Z.ell(.16, .3, .06, .28)(x, y)), skin);
    const hs = blur(hz, w, h, FW * .05), cs = blur(cz, w, h, FW * .05);
    lowAdj((i, m) => { const d = (hl * hs[i] * .07 - ct * cs[i] * .08) * m; lowR[i] += d; lowG[i] += d * .97; lowB[i] += d * .94; });
  }

  // high-frequency (texture) layer
  const soften = amt('Skin retouching/Facial skin/Skin softening'), fhi = amt('Skin retouching/Facial skin/Frequency separation · high');
  const texture = (+P('Skin retouching/Skin texture/Texture')) / 100 * master;
  const hiScale = Math.max(0, 1 - soften * .7 - fhi * .6 + texture * .8);
  if (hiScale !== 1) lowAdj((i, m) => { const k = 1 + (hiScale - 1) * m; hiR[i] *= k; hiG[i] *= k; hiB[i] *= k; });
  const clar = (+P('Skin retouching/Skin texture/Clarity')) / 100 * master;
  if (clar) { const Y = new Float32Array(n); for (let i = 0; i < n; i++) Y[i] = luma(lowR[i], lowG[i], lowB[i]); const bY = mblur(Y, skin, w, h, FW * .03);
    lowAdj((i, m) => { const hp = Y[i] - bY[i], d = clar * 1.5 * hp / (1 + Math.abs(hp) * 10) * m; lowR[i] += d; lowG[i] += d; lowB[i] += d; }); }

  // shine & finish: pull hot, pale highlights toward local skin (matte) or lift them (dewy / gloss)
  const shine = amt('Blemish removal/Face refinement/Reduce face shine');
  const finish = P('Skin retouching/Skin texture/Texture finish', 'Custom'), gloss = (+P('Skin retouching/Skin texture/Glossiness')) / 100 * master;
  let shineK = shine + (finish === 'Matte' ? .6 * master : finish === 'Satin' ? .3 * master : 0), glow = (finish === 'Dewy' ? .5 * master : 0) + Math.max(0, gloss);
  if (gloss < 0) shineK += -gloss;
  if (shineK > 0 || glow > 0) {
    const bR = mblur(lowR, skin, w, h, FW * .08), bG = mblur(lowG, skin, w, h, FW * .08), bB = mblur(lowB, skin, w, h, FW * .08);
    lowAdj((i, m) => { const y = luma(lowR[i], lowG[i], lowB[i]), yb = luma(bR[i], bG[i], bB[i]), over = clamp01((y - yb - .03) / .15);
      if (shineK > 0 && over > 0) { const k = Math.min(1, shineK) * over * m * .85; lowR[i] += (bR[i] + .03 - lowR[i]) * k; lowG[i] += (bG[i] + .03 - lowG[i]) * k; lowB[i] += (bB[i] + .03 - lowB[i]) * k; }
      if (glow > 0) { const d = glow * .12 * clamp01((y - yb + .02) / .12) * m; lowR[i] += d; lowG[i] += d; lowB[i] += d; } });
  }
  for (let i = 0; i < n; i++) if (skinSoft[i] > 0 || skin[i]) { R[i] = lowR[i] + hiR[i]; G[i] = lowG[i] + hiG[i]; B[i] = lowB[i] + hiB[i]; }


  }
  if (keep) { C.k2 = K2; C.s2 = save(); } }
    /* ----- lips ----- */
  const lips = is(FL.ulip, FL.llip);
  const lipW = amt('Blemish removal/Face refinement/Lip wrinkles & flakes');
  const lipAmt = (+P('Makeup/Existing lip makeup/Lip makeup amount')) / 100 * master, lipSat = (+P('Makeup/Existing lip makeup/Lip makeup saturation')) / 100 * master;
  const lipLum = (+P('Makeup/Existing lip makeup/Lip makeup luminance')) / 100 * master, lipDim = (+P('Makeup/Existing lip makeup/Lip makeup dimensionality')) / 100 * master;
  const lipstick = amt('Makeup/Individual components/Lipstick amount');
  if (lipW > 0 || lipAmt || lipSat || lipLum || lipDim || lipstick > 0) {
    const ls = soft(lips, .006);
    const bR = lipW > 0 || lipDim ? mblur(R, lips, w, h, FW * .006) : null, bG = bR && mblur(G, lips, w, h, FW * .006), bB = bR && mblur(B, lips, w, h, FW * .006);
    const LIP = [.6, .25, .3], LIPY = luma(.6, .25, .3);   // deep rose; only its color is used, the lips keep their own light and shade
    for (let i = 0; i < n; i++) { const m = ls[i]; if (m <= 0) continue; let r = R[i], g = G[i], b = B[i];
      if (lipW > 0) { const k = lipW * .8; r += (bR[i] - r) * k; g += (bG[i] - g) * k; b += (bB[i] - b) * k; }
      if (lipDim) { r += (r - bR[i]) * lipDim; g += (g - bG[i]) * lipDim; b += (b - bB[i]) * lipDim; }
      const y = luma(r, g, b), sat = 1 + lipSat * .8 + lipAmt * .5;
      r = y + (r - y) * sat; g = y + (g - y) * sat; b = y + (b - y) * sat;
      if (lipAmt < 0) { r += (y - r) * -lipAmt * .5; g += (y - g) * -lipAmt * .5; b += (y - b) * -lipAmt * .5; }
      if (lipLum) { const d = lipLum * .12; r += d; g += d; b += d; }
      if (lipstick > 0) { const k = lipstick * .6, yy = luma(r, g, b); r += (yy + LIP[0] - LIPY - r) * k; g += (yy + LIP[1] - LIPY - g) * k; b += (yy + LIP[2] - LIPY - b) * k; }
      R[i] += (r - R[i]) * m; G[i] += (g - G[i]) * m; B[i] += (b - B[i]) * m; }
  }

  /* ----- blush ----- */
  const blush = amt('Makeup/Individual components/Blush amount');
  if (blush > 0) { const cz = blur(zone((x, y) => Math.max(Z.ell(-.6, .55, .26, .2)(x, y), Z.ell(.6, .55, .26, .2)(x, y)), skin), w, h, FW * .05);
    for (let i = 0; i < n; i++) { const k = blush * cz[i] * skin[i]; if (k > 0) { R[i] += k * .07; G[i] -= k * .03; B[i] -= k * .005; } } }

  /* ----- brows ----- */
  const brow = (+P('Makeup/Definition/Eyebrow makeup')) / 100 * master + amt('Makeup/Individual components/Eyebrows amount');
  if (brow) { const bm = soft(is(FL.lbrow, FL.rbrow), .006);
    for (let i = 0; i < n; i++) { const m = bm[i]; if (m <= 0) continue; const y = luma(R[i], G[i], B[i]), k = brow * m, f = 1 - k * .35 * (1 - y);
      R[i] *= f; G[i] *= f; B[i] *= f; const yy = luma(R[i], G[i], B[i]), s = 1 + k * .25; R[i] = yy + (R[i] - yy) * s; G[i] = yy + (G[i] - yy) * s; B[i] = yy + (B[i] - yy) * s; } }

  /* ----- teeth ----- */
  const tw = amt('Teeth/Refine/Teeth whitening'), tb = amt('Teeth/Refine/Teeth brightness'), td = amt('Teeth/Refine/Teeth desaturation'), tf = amt('Teeth/Refine/Teeth flaws removal');
  if (tw > 0 || tf > 0) {
    const mouth = is(FL.mouth); let sy = 0, c = 0; for (let i = 0; i < n; i++) if (mouth[i]) { sy += luma(R[i], G[i], B[i]); c++; }
    if (c > 30) {
      const mean = sy / c, teeth = new Float32Array(n);
      for (let i = 0; i < n; i++) if (mouth[i]) { const y = luma(R[i], G[i], B[i]), mx = Math.max(R[i], G[i], B[i]), mn = Math.min(R[i], G[i], B[i]); teeth[i] = clamp01((y - mean * .9) / (mean * .5 + .02)) * clamp01(1.4 - (mx - mn) * 3); }
      const ts = blur(teeth, w, h, FW * .003);
      const fR = tf > 0 ? mblur(R, teeth, w, h, FW * .006) : null, fG = fR && mblur(G, teeth, w, h, FW * .006), fB = fR && mblur(B, teeth, w, h, FW * .006);
      for (let i = 0; i < n; i++) { const m = ts[i] * mouth[i]; if (m <= 0) continue; let r = R[i], g = G[i], b = B[i];
        if (tf > 0) { const k = tf * .6; r += (fR[i] - r) * k; g += (fG[i] - g) * k; b += (fB[i] - b) * k; }
        const y = luma(r, g, b), des = tw * .55 + td * .45, br = tw * .07 + tb * .08;
        r = y + (r - y) * (1 - des); g = y + (g - y) * (1 - des); b = y + (b - y) * (1 - des * .7) + tw * .015;
        r += br; g += br; b += br;
        R[i] += (r - R[i]) * m; G[i] += (g - G[i]) * m; B[i] += (b - B[i]) * m; }
    }
  }

  /* ----- eyes: sclera / iris split inside each parsed eye ----- */
  const eb = amt('Eyes/Brightness/Eye brightness');
  const ibW = (+P('Eyes/Brightness/Iris brightness', 80)) / 100, wbW = (+P('Eyes/Brightness/Eye whites brightness', 80)) / 100, erW = (+P('Eyes/Brightness/Eye reflection', 40)) / 100, flW = (+P('Eyes/Brightness/Iris flare')) / 100;
  const veins = amt('Eyes/Brightness/Red vein removal'), cleanse = amt('Eyes/Brightness/Eye white cleanse'), redEye = !!P('Eyes/Brightness/Red eye removal');
  const irisSel = P('Eyes/Eye color/Iris color', 'Original'), irisAmt = amt('Eyes/Eye color/Iris color amount');
  const IRIS = { Brown: [28, .55], Hazel: [45, .45], Green: [110, .45], Blue: [210, .55], Gray: [210, .08], Amber: [38, .75] };
  if (eb > 0 || veins > 0 || cleanse > 0 || redEye || (irisAmt > 0 && IRIS[irisSel])) {
    for (const eyeLabel of [FL.leye, FL.reye]) {
      const em = is(eyeLabel); let c = 0, ys = []; for (let i = 0; i < n; i++) if (em[i]) { c++; ys.push(luma(R[i], G[i], B[i])); }
      if (c < 12) continue;
      ys.sort((a, b) => a - b); const t = ys[Math.floor(ys.length * .45)], hi = ys[Math.floor(ys.length * .9)];
      const iris = new Float32Array(n), scl = new Float32Array(n);
      for (let i = 0; i < n; i++) if (em[i]) { const y = luma(R[i], G[i], B[i]); iris[i] = clamp01((t + .04 - y) / .08); scl[i] = 1 - iris[i]; }
      const is_ = blur(iris, w, h, Math.max(1, FW * .003)), ss = blur(scl, w, h, Math.max(1, FW * .003));
      const ebS = soft(em, .004);
      for (let i = 0; i < n; i++) { const m = ebS[i]; if (m <= 0) continue; let r = R[i], g = G[i], b = B[i]; const y = luma(r, g, b), ir = is_[i] * m, sc = ss[i] * m;
        if (eb > 0) { const up = eb * (ir * ibW * .12 + sc * wbW * .1); r += up; g += up; b += up;
          if (erW > 0 && y > hi) { const d = eb * erW * .1 * ir; r += d; g += d; b += d; }
          if (flW > 0) { const d = eb * flW * .15 * ir * (y - t); r += d; g += d; b += d; } }
        if ((veins > 0 || cleanse > 0) && sc > 0) { const yy = luma(r, g, b), redness = clamp01((r - (g + b) / 2) * 6), k = (veins * redness + cleanse * .6) * sc;
          r += (yy + .02 - r) * k; g += (yy + .02 - g) * k; b += (yy + .03 - b) * k; if (cleanse > 0) { const d = cleanse * .05 * sc; r += d; g += d; b += d; } }
        if (redEye && ir > 0) { const redness = clamp01((r - Math.max(g, b)) * 4); if (redness > 0) { const k = redness * ir; r += (Math.min(g, b) * .9 - r) * k; } }
        if (irisAmt > 0 && IRIS[irisSel] && ir > 0) { const yy = luma(r, g, b), pupil = clamp01((yy - ys[Math.floor(ys.length * .08)]) / .05);
          const [hh, sat] = IRIS[irisSel], [cr, cg, cb] = hsl2rgb(hh, sat, clamp01(yy * 1.15)), k = irisAmt * ir * pupil;
          r += (cr - r) * k; g += (cg - g) * k; b += (cb - b) * k; }
        R[i] = r; G[i] = g; B[i] = b; }
    }
  }

  /* ----- hair ----- */
  const hairSel = P('Hair/Hair color/Hair color', 'Original'), hairAmt = amt('Hair/Hair color/Hair color amount');
  const hTemp = (+P('Hair/Hair color/Hair color temperature')) / 100 * master, hSat = amt('Hair/Hair color/Hair color saturation');
  const smooth = amt('Hair/Cleanup/Smooth hair'), frizz = (+P('Hair/Cleanup/Tame frizzy hair', 100)) / 100, hShine = amt('Hair/Cleanup/Hair shine'), gray = amt('Hair/Cleanup/White hair blackening');
  const HAIR = { Black: [25, .1, .1], Brown: [24, .36, .26], Blonde: [40, .42, .55] };   // hue, saturation, target mean lightness
  if ((hairAmt > 0 && hairSel !== 'Original') || hTemp || hSat > 0 || smooth > 0 || hShine > 0 || gray > 0) {
    const hm = is(FL.hair); let c = 0, sy = 0; for (let i = 0; i < n; i++) if (hm[i]) { c++; sy += luma(R[i], G[i], B[i]); }
    if (c > 50) {
      // soft edge on both sides of the hair line, but only lightly onto skin (bangs over a forehead)
      const meanY = sy / c, hs = blur(hm, w, h, Math.max(1, FW * .006)); for (let i = 0; i < n; i++) if (!hm[i] && skin[i]) hs[i] *= .35;
      const sR = smooth > 0 ? mblur(R, hm, w, h, FW * .006 * (.5 + frizz)) : null, sG = sR && mblur(G, hm, w, h, FW * .006 * (.5 + frizz)), sB = sR && mblur(B, hm, w, h, FW * .006 * (.5 + frizz));
      const target = HAIR[hairSel];
      for (let i = 0; i < n; i++) { const m = hs[i]; if (m <= 0) continue; let r = R[i], g = G[i], b = B[i];
        if (smooth > 0) { const k = smooth * .7; r += (sR[i] - r) * k; g += (sG[i] - g) * k; b += (sB[i] - b) * k; }
        if (gray > 0) { const y = luma(r, g, b), mx = Math.max(r, g, b), mn = Math.min(r, g, b), k = gray * clamp01((y - meanY - .05) / .15) * clamp01(1 - (mx - mn) * 6);
          if (k > 0) { const f = 1 - k * .6; r = r * f + .02 * k; g *= f; b *= f; } }
        if (hairAmt > 0 && target) {
          // remap lightness with a curve (not a multiplier) so highlights never blow out, keep a little original color variation
          const y = clamp01(luma(r, g, b)), ex = Math.min(2.2, Math.max(.45, Math.log(target[2]) / Math.log(Math.min(.95, Math.max(.03, meanY))))), ly = Math.pow(y, ex);
          const [cr, cg, cb] = hsl2rgb(target[0], target[1] * (.6 + .8 * ly * (1 - ly)), ly), k = hairAmt;
          const or = ly + (r - y) * .25, og = ly + (g - y) * .25, ob = ly + (b - y) * .25;
          r += (cr * .8 + or * .2 - r) * k; g += (cg * .8 + og * .2 - g) * k; b += (cb * .8 + ob * .2 - b) * k; }
        if (hTemp) { r += hTemp * .05; b -= hTemp * .05; }
        if (hSat > 0) { const y = luma(r, g, b), s = 1 + hSat * .8; r = y + (r - y) * s; g = y + (g - y) * s; b = y + (b - y) * s; }
        if (hShine > 0) { const y = luma(r, g, b), d = hShine * .12 * clamp01((y - meanY) / .2); r += d; g += d; b += d; }
        R[i] += (r - R[i]) * m; G[i] += (g - G[i]) * m; B[i] += (b - B[i]) * m; }
    }
  }

  // write back only what changed
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (R[i] === R0[i] && G[i] === G0[i] && B[i] === B0[i]) continue;
    const j = ((ry0 + y) * W + rx0 + x) * 4; px[j] = clamp01(R[i]) * 255 + .5; px[j + 1] = clamp01(G[i]) * 255 + .5; px[j + 2] = clamp01(B[i]) * 255 + .5;
  }
}

function region(out, face, W, H) {
  const S = face.S, lab = face.labels, sx0 = face.crop.x * W, sy0 = face.crop.y * H, size = face.crop.size * W;
  // region = bounding box of non-background labels, padded
  let lx0 = S, ly0 = S, lx1 = -1, ly1 = -1;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const l = lab[y * S + x]; if (l && l !== FL.cloth) { if (x < lx0) lx0 = x; if (x > lx1) lx1 = x; if (y < ly0) ly0 = y; if (y > ly1) ly1 = y; } }
  if (lx1 < 0) return;
  const pad = .03 * S;
  const rx0 = Math.max(0, Math.floor(sx0 + (lx0 - pad) / S * size)), ry0 = Math.max(0, Math.floor(sy0 + (ly0 - pad) / S * size));
  const rx1 = Math.min(W, Math.ceil(sx0 + (lx1 + pad) / S * size)), ry1 = Math.min(H, Math.ceil(sy0 + (ly1 + pad) / S * size));
  const w = rx1 - rx0, h = ry1 - ry0; if (w < 8 || h < 8) return;
  const n = w * h, px = out.data;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), lbl = new Uint8Array(n);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = ((ry0 + y) * W + rx0 + x) * 4; R[i] = px[j] / 255; G[i] = px[j + 1] / 255; B[i] = px[j + 2] / 255;
    const u = Math.floor((rx0 + x - sx0) / size * S), v = Math.floor((ry0 + y - sy0) / size * S);
    lbl[i] = u >= 0 && v >= 0 && u < S && v < S ? lab[v * S + u] : 0;
  }
  const R0 = Float32Array.from(R), G0 = Float32Array.from(G), B0 = Float32Array.from(B);
  const is = (...ls) => { const m = new Float32Array(n); for (let i = 0; i < n; i++) if (ls.includes(lbl[i])) m[i] = 1; return m; };
  const skin = is(FL.skin, FL.nose), skinOnly = is(FL.skin);
  let fx0 = w, fx1 = 0; for (let i = 0; i < n; i++) if (skinOnly[i]) { const x = i % w; if (x < fx0) fx0 = x; if (x > fx1) fx1 = x; }
  const FW = Math.max(20, fx1 - fx0);                              // face width in pixels: all radii scale with it
  const soft = (m, s) => { const b = blur(m, w, h, Math.max(1, FW * s)); for (let i = 0; i < n; i++) b[i] *= m[i] > 0 ? 1 : .0; return b; };
  const erode = (m, s) => { const b = blur(m, w, h, Math.max(1, FW * s)); const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = b[i] > .97 ? 1 : 0; return o; };
  const Z = zoneMaker(face.kps.map(([x, y]) => [x * W, y * H]), rx0, ry0);
  return { w, h, n, rx0, ry0, lbl, skin, skinOnly, FW, Z, R0: R, G0: G, B0: B };
}

// add the healed change of the chosen spots (bilinear in the AI crop, which may be at another scale)
function healSpots(R, G, B, ai, gate, w, h, rx0, ry0, skip, touched) {
  const { x0, y0, s, pw, ph, delta, comp } = ai, n = pw * ph;
  for (let y = 0; y < h; y++) { const fy = (ry0 + y + .5 - y0) * s - .5; if (fy < -1 || fy > ph) continue;
    for (let x = 0; x < w; x++) { const fx = (rx0 + x + .5 - x0) * s - .5; if (fx < -1 || fx > pw) continue;
      const ax = Math.max(0, Math.min(pw - 1, Math.floor(fx))), ay = Math.max(0, Math.min(ph - 1, Math.floor(fy))), bx = Math.min(pw - 1, ax + 1), by = Math.min(ph - 1, ay + 1);
      const tx = Math.max(0, Math.min(1, fx - ax)), ty = Math.max(0, Math.min(1, fy - ay));
      let dr = 0, dg = 0, db = 0;
      for (const [j, wt] of [[ay * pw + ax, (1 - tx) * (1 - ty)], [ay * pw + bx, tx * (1 - ty)], [by * pw + ax, (1 - tx) * ty], [by * pw + bx, tx * ty]]) {
        const c = comp[j]; if (c < 0 || !gate[c] || wt === 0) continue; const k = gate[c] * wt; dr += delta[j] * k; dg += delta[n + j] * k; db += delta[2 * n + j] * k; }
      if (!dr && !dg && !db) continue;
      if (skip && skip(x, y)) continue;
      const i = y * w + x; R[i] += dr; G[i] += dg; B[i] += db; if (touched) touched[i] = 1; } }
}
// ABPN soft-light layer: out = (1-2m)c^2 + 2mc, m pulled toward 0.5 by (1-degree) and faded at the crop border
function blendLayer(R, G, B, ai, degree, mask, w, h, rx0, ry0) {
  const { x0, y0, s, pw, ph, mg } = ai, S = 512, N = S * S, ramp = 20 / 500;
  for (let y = 0; y < h; y++) { const py = (ry0 + y + .5 - y0) * s; if (py < 0 || py >= ph) continue;
    for (let x = 0; x < w; x++) { const i = y * w + x, a = mask[i]; if (a <= 0) continue; const px = (rx0 + x + .5 - x0) * s; if (px < 0 || px >= pw) continue;
      const edge = Math.min(1, Math.min(px, pw - px) / (pw * ramp), Math.min(py, ph - py) / (ph * ramp));
      const u = Math.max(0, px / pw * S - .5), v = Math.max(0, py / ph * S - .5), ux = Math.min(S - 1, u | 0), vy = Math.min(S - 1, v | 0), ux1 = Math.min(S - 1, ux + 1), vy1 = Math.min(S - 1, vy + 1), tx = u - ux, ty = v - vy;
      const k = degree * edge * a, ch = [R, G, B];
      for (let c = 0; c < 3; c++) { const o = c * N, m = (mg[o + vy * S + ux] * (1 - tx) + mg[o + vy * S + ux1] * tx) * (1 - ty) + (mg[o + vy1 * S + ux] * (1 - tx) + mg[o + vy1 * S + ux1] * tx) * ty;
        const mm = (m - .5) * k + .5, cv = clamp01(ch[c][i]); ch[c][i] = (1 - 2 * mm) * cv * cv + 2 * mm * cv; } } }
}

/* Apply to a copy of `img` for every face. getV(path, faceIndex) returns the control value for that face. */
function apply(img, analysis, getV, master) {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  analysis.faces.forEach((f, k) => { const m = (+getV('Master & targets/Portrait settings/Master slider', k)) / 100;
    if (m > 0) applyFace(out, f, p => getV(p, k), m * master, img.width, img.height, img.width * img.height <= 1.3e7); });
  return out;
}

return { apply, _test: { boxBlur } };
})();
