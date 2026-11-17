/* Portrait retouching on the CPU, per face, before the color engine.
   Blemishes come from three layers (ABPN spot healing in abpn.js, the freckle model in spots.js, the Motus Touch model in pro.js) and skin evening from ABPN's blend layer;
   everything else works on the face's own region using the parsed masks (skin, eyes, lips, teeth, brows, hair) and the 5 YuNet landmarks for zones (forehead, under-eyes, smile lines ...).
   Speed: a stage is only recomputed when one of its sliders changes, masks and zones are worked out once per face, and small features run on their own small rectangle.
   Same code for the preview and the full-resolution export: sizes are relative to the face width. */
'use strict';

const MotusRetouch = (() => {
const FL = MotusFaces.L;

/* ---------- small image toolkit (Float32 planes) ---------- */
function boxH(s, d, w, h, r) { const k = 1 / (2 * r + 1), last = w - 1;
  for (let y = 0; y < h; y++) { const o = y * w; let acc = s[o] * (r + 1); for (let i = 1; i <= r; i++) acc += s[o + (i < last ? i : last)];
    for (let x = 0; x < w; x++) { d[o + x] = acc * k; const a = x + r + 1, b = x - r; acc += s[o + (a < last ? a : last)] - s[o + (b > 0 ? b : 0)]; } } }
// vertical pass, walked row by row (one running sum per column) so memory is read in order
function boxV(s, d, w, h, r) { const k = 1 / (2 * r + 1), last = h - 1, acc = new Float64Array(w);
  for (let x = 0; x < w; x++) acc[x] = s[x] * (r + 1);
  for (let i = 1; i <= r; i++) { const o = (i < last ? i : last) * w; for (let x = 0; x < w; x++) acc[x] += s[o + x]; }
  for (let y = 0; y < h; y++) { const o = y * w, a = (y + r + 1 < last ? y + r + 1 : last) * w, b = (y - r > 0 ? y - r : 0) * w;
    for (let x = 0; x < w; x++) { d[o + x] = acc[x] * k; acc[x] += s[a + x] - s[b + x]; } } }
function boxBlur(src, w, h, sigma) {   // 3 box passes ~ gaussian
  const r = Math.max(1, Math.round(sigma)), a = new Float32Array(src), b = new Float32Array(src.length);
  for (let p = 0; p < 3; p++) { boxH(a, b, w, h, r); boxV(b, a, w, h, r); }
  return a;
}
// large radii: blur a downscaled copy and scale back up (smooth result, a fraction of the work)
function blurFactor(sigma, w, h) { const f = Math.floor(sigma / 3); return f < 2 || w < f * 8 || h < f * 8 ? 0 : f; }
function blur(src, w, h, sigma, f = blurFactor(sigma, w, h)) {
  if (!f) return boxBlur(src, w, h, sigma);
  const dw = Math.ceil(w / f), dh = Math.ceil(h / f), small = new Float32Array(dw * dh), fr = Math.fround;
  for (let y = 0; y < h; y++) { const sy = ((y / f) | 0) * dw, o = y * w;
    for (let bx = 0, x = 0; bx < dw; bx++) { const end = Math.min(w, x + f); let a = small[sy + bx]; for (; x < end; x++) a = fr(a + src[o + x]); small[sy + bx] = a; } }
  for (let by = 0; by < dh; by++) { const ch = Math.min(f, h - by * f); for (let bx = 0; bx < dw; bx++) small[by * dw + bx] /= Math.min(f, w - bx * f) * ch; }
  const b = boxBlur(small, dw, dh, sigma / f), out = new Float32Array(w * h);
  // bilinear back up: the column positions and weights are the same for every row
  const X0 = new Int32Array(w), X1 = new Int32Array(w), TX = new Float64Array(w);
  for (let x = 0; x < w; x++) { let fx = (x + .5) / f - .5; if (fx < 0) fx = 0; const x0 = Math.min(dw - 1, fx | 0); X0[x] = x0; X1[x] = Math.min(dw - 1, x0 + 1); TX[x] = fx - x0; }
  for (let y = 0; y < h; y++) { let fy = (y + .5) / f - .5; if (fy < 0) fy = 0; const y0 = Math.min(dh - 1, fy | 0), y1 = Math.min(dh - 1, y0 + 1), ty = fy - y0, r0 = y0 * dw, r1 = y1 * dw, o = y * w;
    for (let x = 0; x < w; x++) { const x0 = X0[x], x1 = X1[x], tx = TX[x];
      out[o + x] = (b[r0 + x0] * (1 - tx) + b[r0 + x1] * tx) * (1 - ty) + (b[r1 + x0] * (1 - tx) + b[r1 + x1] * tx) * ty; } }
  return out;
}
// blur of `src` inside mask `m` only. `den` = blur(m, sigma) when the caller already has it
function mblur(src, m, w, h, sigma, den, f) { const n = src.length, sm = new Float32Array(n); for (let i = 0; i < n; i++) sm[i] = src[i] * m[i];
  const a = blur(sm, w, h, sigma, f), b = den || blur(m, w, h, sigma, f); for (let i = 0; i < n; i++) a[i] = b[i] > 1e-4 ? a[i] / b[i] : src[i]; return a; }
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const luma = (r, g, b) => .2126 * r + .7152 * g + .0722 * b;
function hsl2rgb(h, s, l) { if (s <= 0) return [l, l, l]; const q = l < .5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q, f = t => { t = ((t % 1) + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }; return [f(h / 360 + 1 / 3), f(h / 360), f(h / 360 - 1 / 3)]; }

function labelMask(lbl, n, labels) { const hit = new Uint8Array(256), m = new Float32Array(n); for (const l of labels) hit[l] = 1; for (let i = 0; i < n; i++) if (hit[lbl[i]]) m[i] = 1; return m; }

/* ---------- zones from the 5 landmarks ---------- */
function zoneMaker(kps, rx, ry) {
  const re = [kps[0][0] - rx, kps[0][1] - ry], le = [kps[1][0] - rx, kps[1][1] - ry], nose = [kps[2][0] - rx, kps[2][1] - ry], rm = [kps[3][0] - rx, kps[3][1] - ry], lm = [kps[4][0] - rx, kps[4][1] - ry];
  const E = [(re[0] + le[0]) / 2, (re[1] + le[1]) / 2], d = Math.hypot(le[0] - re[0], le[1] - re[1]) || 1;
  const ux = (le[0] - re[0]) / d, uy = (le[1] - re[1]) / d, vx = -uy, vy = ux;   // u along eyes (image left->right), v down
  const toFace = (x, y) => { const dx = x - E[0], dy = y - E[1]; return [(dx * ux + dy * uy) / d, (dx * vx + dy * vy) / d]; };
  const pf = p => toFace(p[0], p[1]);
  const pts = { re: pf(re), le: pf(le), nose: pf(nose), rm: pf(rm), lm: pf(lm) };
  // soft ellipse in face units
  const ell = (cu, cv, ru, rv) => {
    const f = (x, y) => { const dx = x - E[0], dy = y - E[1], u = (dx * ux + dy * uy) / d, v = (dx * vx + dy * vy) / d, q = ((u - cu) / ru) ** 2 + ((v - cv) / rv) ** 2; return q >= 1 ? 0 : (1 - q) ** 1.5; };
    const px = E[0] + d * (cu * ux + cv * vx), py = E[1] + d * (cu * uy + cv * vy), rad = d * Math.max(ru, rv) + 2;   // outside this box the ellipse is 0
    f.box = [Math.floor(px - rad), Math.floor(py - rad), Math.ceil(px + rad), Math.ceil(py + rad)];
    return f;
  };
  // like ell, but full strength over most of the ellipse and a soft rim: for zones that should be treated evenly
  const area = (cu, cv, ru, rv) => { const e = ell(cu, cv, ru, rv), f = (x, y) => { const dx = x - E[0], dy = y - E[1], u = (dx * ux + dy * uy) / d, v = (dx * vx + dy * vy) / d, q = ((u - cu) / ru) ** 2 + ((v - cv) / rv) ** 2; return q >= 1 ? 0 : Math.min(1, (1 - q) / .4); }; f.box = e.box; return f; };
  return { d, toFace, pts, ell, area };
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
// keep = remember this face's working data between calls (the preview); off for very large exports to save memory
function applyFace(out, face, V, W, H, keep) {
  const ck = W + 'x' + H; face._ctx = face._ctx || {}; let C = face._ctx[ck];
  if (!C) { C = region(out, face, W, H); if (!C) return; if (keep) face._ctx[ck] = C; }
  const { w, h, n, rx0, ry0, lbl, skin, FW, Z } = C, px = out.data;
  const R = C.R0.slice(), G = C.G0.slice(), B = C.B0.slice(), R0 = C.R0, G0 = C.G0, B0 = C.B0;
  const is = (...ls) => labelMask(lbl, n, ls);
  const soft = (m, s) => { const b = blur(m, w, h, Math.max(1, FW * s)); for (let i = 0; i < n; i++) b[i] *= m[i] > 0 ? 1 : .0; return b; };
  const erode = (m, s) => { const b = blur(m, w, h, Math.max(1, FW * s)); const o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = b[i] > .97 ? 1 : 0; return o; };
  // strongest of several ellipses (times `k`), inside `mask`; each ellipse only visits its own box
  const zone = (ells, mask, k = 1, z = new Float32Array(n)) => { for (const f of ells) { const [bx0, by0, bx1, by1] = f.box;
    for (let y = Math.max(0, by0); y <= Math.min(h - 1, by1); y++) for (let x = Math.max(0, bx0); x <= Math.min(w - 1, bx1); x++) { const i = y * w + x; if (mask && !mask[i]) continue; const v = f(x, y) * k; if (v > z[i]) z[i] = v; } } return z; };
  // results that depend only on the face itself (masks, zones) are worked out once per face and reused on every slider move
  const once = (key, make) => C.fixed[key] || (C.fixed[key] = make());
  // blur of a mask, remembered per radius (the last few), so several colour channels share it
  const den = (name, m, sigma) => { const k = name + '@' + sigma; let b = C.den.get(k); if (!b) { b = blur(m, w, h, sigma); if (C.den.size >= 6) C.den.delete(C.den.keys().next().value); C.den.set(k, b); } return b; };
  const skinBlur = (c, sigma) => mblur(c, skin, w, h, sigma, den('skin', skin, sigma));
  /* Small features (lips, brows, teeth, eyes) only touch a small part of the face region. `part` runs their work on just that
     rectangle, padded by as far as a blur can carry a value and lined up with the blur's own grid, so the result is the same
     as working on the whole region. fn gets a view { R, G, B, w, h, n, is, soft, blur, mblur }. */
  const part = (labels, sigmas, fn) => {
    let x0 = w, y0 = h, x1 = -1, y1 = -1; for (const l of labels) { const b = l * 4; x0 = Math.min(x0, C.box[b]); y0 = Math.min(y0, C.box[b + 1]); x1 = Math.max(x1, C.box[b + 2]); y1 = Math.max(y1, C.box[b + 3]); }
    if (x1 < 0) return;
    let pad = 0, grid = 1; const fs = sigmas.map(sg => blurFactor(sg, w, h));
    sigmas.forEach((sg, k) => { const f = fs[k], r = Math.max(1, Math.round(f ? sg / f : sg)); pad = Math.max(pad, (3 * r + 2) * (f || 1)); if (f && grid % f) grid *= f; });
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x0 -= x0 % grid; y0 -= y0 % grid;
    x1 = Math.min(w, Math.ceil((x1 + 1 + pad) / grid) * grid); y1 = Math.min(h, Math.ceil((y1 + 1 + pad) / grid) * grid);
    const cw = x1 - x0, ch = y1 - y0, cn = cw * ch, fOf = sg => fs[sigmas.indexOf(sg)];
    const cut = a => { const o = new a.constructor(cn); for (let y = 0; y < ch; y++) o.set(a.subarray((y0 + y) * w + x0, (y0 + y) * w + x1), y * cw); return o; };
    const v = { R: cut(R), G: cut(G), B: cut(B), w: cw, h: ch, n: cn }, l = cut(lbl);
    v.is = (...ls) => labelMask(l, cn, ls);
    v.blur = (m, sg) => blur(m, cw, ch, sg, fOf(sg));
    v.mblur = (c, m, sg, d) => mblur(c, m, cw, ch, sg, d, fOf(sg));
    v.soft = (m, sg) => { const b = v.blur(m, sg); for (let i = 0; i < cn; i++) b[i] *= m[i] > 0 ? 1 : .0; return b; };
    fn(v);
    for (let y = 0; y < ch; y++) { const o = (y0 + y) * w + x0; R.set(v.R.subarray(y * cw, y * cw + cw), o); G.set(v.G.subarray(y * cw, y * cw + cw), o); B.set(v.B.subarray(y * cw, y * cw + cw), o); }
  };
  const P = (path, def = 0) => { const v = V(path); return v === undefined ? def : v; };
  const amt = path => (+P(path) || 0) / 100;
  const zp = Z.pts, skinAll = () => once('skinAll', () => soft(is(FL.skin, FL.nose, FL.neck, FL.lear, FL.rear), .01));   // soft mask of all bare skin
  const keyOf = paths => paths.map(p => P(p)).join('|');
  const aiKey = (MotusABPN.at(face, W, H) ? 'ai' : '-') + (MotusPro.enabled && MotusPro.at(face, W, H) ? 'pro' : ''), K1 = aiKey + keyOf(STAGE1), K2 = K1 + '#' + keyOf(STAGE2);
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
      const kd = blur(keep, w, h, FW * .02), fr = mblur(R, keep, w, h, FW * .02, kd), fg = mblur(G, keep, w, h, FW * .02, kd), fb = mblur(B, keep, w, h, FW * .02, kd), hs = blur(hot, w, h, FW * .004);
      for (let i = 0; i < n; i++) { const a = clamp01(hs[i] * 1.6) * glare; if (a > 0) { R[i] += (fr[i] - R[i]) * a; G[i] += (fg[i] - G[i]) * a; B[i] += (fb[i] - B[i]) * a; } }
    }
  }

  /* ----- blemishes: ABPN healed spots, chosen per spot by kind (acne, freckle, mole) and confidence ----- */
  const ai = MotusABPN.at(face, W, H);
  const fa = amt('Blemish removal/Face refinement/Freckles & acne'), frW = (+P('Blemish removal/Face refinement/Freckles', 100)) / 100, acW = (+P('Blemish removal/Face refinement/Acne', 100)) / 100;
  const acne = fa * acW, freck = fa * frW, mole = P('Blemish removal/Face refinement/Face mole removal') ? 1 : 0;
  const beard = !!P('Blemish removal/Face refinement/Beard protection'), noseV = Z.pts.nose[1] + .1, beardSkip = beard ? (x, y) => Z.toFace(x, y)[1] > noseV : null;
  // Three layers, strongest first. `done` is how much of each pixel an earlier layer has taken over (0..1); a later layer only does the rest.
  // It has to be a share, not yes/no: a spot the first layer has only just started on (1%) must not be dropped by the others, or it pops back in as the slider rises.
  const done = new Float32Array(n), keepMole = new Uint8Array(n);
  if (ai && ai.spots.length && (acne > 0 || freck > 0 || mole > 0)) {
    // 1. acne and bumps: ABPN repaints each one from the skin around it; a weaker slider keeps only the surest spots
    const amount = ai.spots.map(sp => Math.min(1, sp.kind === 'mole' ? mole : sp.kind === 'acne' ? acne : freck)), share = ai.spots.map((sp, c) => amount[c] > 0 ? clamp01((sp.peak - (.85 - .5 * amount[c])) / .1) : 0);
    const beard = beardSkip ? (C.beard || (C.beard = (() => { const m = new Uint8Array(n); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (beardSkip(x, y)) m[y * w + x] = 1; return m; })())) : null;
    healSpots(R, G, B, ai, share, amount, C, w, h, rx0, ry0, beard, done, mole > 0 ? null : keepMole);
  }
  if (freck > 0 || mole > 0) {
    // 2. freckles and small dark marks: the spot model (spots.js)
    if (!C.spots) {
      const features = is(FL.lbrow, FL.rbrow, FL.leye, FL.reye, FL.glasses, FL.mouth, FL.ulip, FL.llip, FL.hair);
      const near = blur(features, w, h, FW * .02), core = erode(is(FL.skin, FL.nose), .012), allow = new Uint8Array(n);
      for (let i = 0; i < n; i++) allow[i] = core[i] && near[i] < .15 ? 1 : 0;
      C.spots = MotusSpots.analyse(C.R0, C.G0, C.B0, allow, w, h, FW, blur);
    }
    MotusSpots.apply(R, G, B, C.spots, Math.max(freck, mole ? .6 : 0), mole > 0, w, h, done, beardSkip, mole > 0 ? null : keepMole);
  }
  const pro = MotusPro.enabled && MotusPro.at(face, W, H);
  if (pro && fa > 0) {
    // 3. everything else (redness, uneven tone, under-eyes): the Motus Touch model, for whatever the first two layers left, and kept off protected moles
    const base = skinAll();
    const stop = new Float32Array(n); for (let i = 0; i < n; i++) stop[i] = keepMole[i] ? 1 : done[i];
    const near = blur(stop, w, h, Math.max(1, FW * .004)), allow = new Float32Array(n);
    for (let i = 0; i < n; i++) allow[i] = base[i] * (1 - Math.min(1, near[i] * 2));
    MotusPro.apply(R, G, B, pro, Math.min(1, fa) * Math.max(acW, frW), allow, w, h, rx0, ry0, C);
  }

  /* ----- wrinkles: remove dark mid-frequency lines inside each zone ----- */
  const wr = [];
  const add = (path, ...ells) => { const a = amt(WR + path); if (a > 0) wr.push([a, ells]); };
  const mouthU = (zp.rm[0] + zp.lm[0]) / 2, mouthV = (zp.rm[1] + zp.lm[1]) / 2;
  add('Forehead wrinkles', Z.area(0, -1.0, 1.35, .72));
  add('Eleven lines', Z.area(0, -.32, .34, .4));
  add('Eye wrinkles', Z.area(zp.re[0] - .4, zp.re[1] + .1, .4, .5), Z.area(zp.le[0] + .4, zp.le[1] + .1, .4, .5), Z.area(zp.re[0], zp.re[1] + .36, .42, .24), Z.area(zp.le[0], zp.le[1] + .36, .42, .24));
  add('Nasal wrinkles', Z.area(0, .12, .34, .34));
  add('Smile line · left', Z.area((zp.nose[0] + zp.rm[0]) / 2 - .1, (zp.nose[1] + zp.rm[1]) / 2 + .05, .27, .55));
  add('Smile line · right', Z.area((zp.nose[0] + zp.lm[0]) / 2 + .1, (zp.nose[1] + zp.lm[1]) / 2 + .05, .27, .55));
  add('Cheek wrinkles', Z.area(-.8, .62, .45, .62), Z.area(.8, .62, .45, .62));
  add('Marionette lines', Z.area(zp.rm[0] - .04, zp.rm[1] + .36, .24, .42), Z.area(zp.lm[0] + .04, zp.lm[1] + .36, .24, .42));
  add('Perioral wrinkles', Z.area(mouthU, mouthV, .78, .55));
  if (wr.length) {
    // Skin is split into four layers by size: pores, fine lines, creases, and the smooth base underneath. Wrinkles live in the two middle
    // layers, so those are faded out inside each zone while the pores stay, which keeps the skin looking like skin instead of plastic.
    const strength = new Float32Array(n); for (const [k, ells] of wr) zone(ells, skin, k, strength);
    const st = blur(strength, w, h, FW * .02), s1 = Math.max(1, FW * .0028), s2 = FW * .014, s3 = FW * .05;
    for (const c of [R, G, B]) { const a = skinBlur(c, s1), b = skinBlur(c, s2), d = skinBlur(c, s3);
      for (let i = 0; i < n; i++) { if (st[i] <= 0 || !skin[i]) continue; const k = Math.min(1, st[i]);
        const coarse = b[i] - d[i], mid = a[i] - b[i];   // the dark side of each layer is the crease itself; the light side is kept more, so the face keeps its shape
        c[i] = d[i] + coarse * (1 - (coarse < 0 ? .6 : .25) * k) + mid * (1 - (mid < 0 ? .95 : .6) * k) + (c[i] - a[i]) * (1 - .25 * k); } }
  }

  if (keep) { C.k1 = K1; C.s1 = save(); } }
    /* ----- skin: frequency separation, then tone work on the low layer ----- */
  const even = amt('Skin retouching/Facial skin/Even with dodge & burn'), aiE = MotusABPN.at(face, W, H);
  if (even > 0 && aiE) blendLayer(R, G, B, aiE, even, skinAll(), w, h, rx0, ry0);
  // the frequency-separation work below is costly: skip it when none of its controls are in use
  const IDLE = { 'Blemish removal/Face refinement/Lower eyelids protection': 1, 'Skin retouching/Facial skin/Even with dodge & burn': 1 };
  const s2on = STAGE2.some(p => { if (IDLE[p]) return false; const v = P(p); return v && v !== 'Original' && v !== 'Custom' && +v !== 0; });
  if (s2on) {
  // split into a smooth layer and a texture layer; the split only changes when stage 1 or the even-skin amount does, so it is kept between slider moves
  const sigF = Math.max(1, FW * .006), lowKey = K1 + '#' + even;
  if (!C.low || C.low.key !== lowKey) C.low = { key: lowKey, r: skinBlur(R, sigF), g: skinBlur(G, sigF), b: skinBlur(B, sigF) };
  const lowR = C.low.r.slice(), lowG = C.low.g.slice(), lowB = C.low.b.slice();
  const hiR = new Float32Array(n), hiG = new Float32Array(n), hiB = new Float32Array(n);
  for (let i = 0; i < n; i++) { hiR[i] = R[i] - lowR[i]; hiG[i] = G[i] - lowG[i]; hiB[i] = B[i] - lowB[i]; }
  const skinSoft = once('skinSoft', () => soft(erode(skin, .012), .01));
  const lowAdj = (fn) => { for (let i = 0; i < n; i++) if (skinSoft[i] > 0) fn(i, skinSoft[i]); };

  // even skin (dodge & burn) / textured smoothing / low-frequency smoothing: pull blotches toward a broader base
  const tsm = amt('Skin retouching/Facial skin/Textured smoothing'), flo = amt('Skin retouching/Facial skin/Frequency separation · low');
  const evenAmt = Math.min(1, tsm * .7 + flo * .6);
  if (evenAmt > 0) {
    const s2 = FW * (.03 + .02 * flo);
    const bR = skinBlur(lowR, s2), bG = skinBlur(lowG, s2), bB = skinBlur(lowB, s2);
    lowAdj((i, m) => { const k = evenAmt * m; lowR[i] += (bR[i] - lowR[i]) * k; lowG[i] += (bG[i] - lowG[i]) * k; lowB[i] += (bB[i] - lowB[i]) * k; });
  }

  // dark circles & eye bags: under-eye zones, kept away from the lash line by "lower eyelids protection"
  const dc = amt('Blemish removal/Face refinement/Dark circles'), bags = amt('Blemish removal/Face refinement/Eye bags');
  if (dc > 0 || bags > 0) {
    const prot = (+P('Blemish removal/Face refinement/Lower eyelids protection', 100)) / 100;
    const nearEye = once('nearEye', () => blur(is(FL.leye, FL.reye), w, h, FW * .025));
    const us = once('underEye', () => blur(zone([Z.ell(zp.re[0], zp.re[1] + .3, .3, .17), Z.ell(zp.le[0], zp.le[1] + .3, .3, .17)], skin), w, h, FW * .02));
    const ref = once('belowEye', () => zone([Z.ell(zp.re[0], zp.re[1] + .62, .26, .14), Z.ell(zp.le[0], zp.le[1] + .62, .26, .14)], skin)), rd = den('belowEye', ref, FW * .08);
    const cR = mblur(lowR, ref, w, h, FW * .08, rd), cG = mblur(lowG, ref, w, h, FW * .08, rd), cB = mblur(lowB, ref, w, h, FW * .08, rd);
    const bR = skinBlur(lowR, FW * .035), bG = skinBlur(lowG, FW * .035), bB = skinBlur(lowB, FW * .035);
    for (let i = 0; i < n; i++) { const z = us[i] * skin[i] * (1 - prot * clamp01(nearEye[i] * 3)); if (z <= 0) continue;
      if (dc > 0) { const k = dc * z * .9, yr = luma(cR[i], cG[i], cB[i]), yl = luma(lowR[i], lowG[i], lowB[i]); if (yr > yl) { lowR[i] += (cR[i] - lowR[i]) * k; lowG[i] += (cG[i] - lowG[i]) * k; lowB[i] += (cB[i] - lowB[i]) * k; } }
      if (bags > 0) { const k = bags * z; lowR[i] += (bR[i] - lowR[i]) * k; lowG[i] += (bG[i] - lowG[i]) * k; lowB[i] += (bB[i] - lowB[i]) * k; } }
  }

  // complexion & tone
  const unify = amt('Skin retouching/Skin tone/Unify face complexion');
  const temp = (+P('Skin retouching/Skin tone/Skin temperature')) / 100, tint = (+P('Skin retouching/Skin tone/Skin tint')) / 100;
  const radiance = amt('Skin retouching/Skin tone/Skin radiance'), rosy = (+P('Skin retouching/Skin tone/Rosy complexion')) / 100;
  const toneSel = P('Skin retouching/Skin tone/Skin tone', 'Original'), toneAmt = amt('Skin retouching/Skin tone/Skin tone intensity');
  // undertone presets: hue shift (deg) and chroma scale; lightness is never changed
  const TONES = { 'Tone 1': [-10, .95], 'Tone 2': [-5, 1.08], 'Tone 3': [3, 1.02], 'Tone 4': [8, 1.12], 'Tone 5': [14, .92], 'Tone 6': [6, 1.22], 'Tone 7': [-3, 1.15], 'Tone 8': [10, .82] };
  const tone = toneAmt > 0 ? TONES[toneSel] : null;
  if (unify > 0 || temp || tint || radiance > 0 || rosy || tone) {
    const big = FW * .1, mR = skinBlur(lowR, big), mG = skinBlur(lowG, big), mB = skinBlur(lowB, big);
    const ch = rosy ? once('cheeks', () => blur(zone([Z.ell(-.62, .62, .28, .22), Z.ell(.62, .62, .28, .22)], skin), w, h, FW * .04)) : null;
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
    const hs = once('highlight', () => blur(zone([Z.ell(0, .25, .08, .32), Z.ell(0, -.78, .28, .2), Z.ell(-.62, .28, .22, .12), Z.ell(.62, .28, .22, .12)], skin), w, h, FW * .05));
    const cs = once('contour', () => blur(zone([Z.ell(-.84, .82, .2, .32), Z.ell(.84, .82, .2, .32), Z.ell(-.16, .3, .06, .28), Z.ell(.16, .3, .06, .28)], skin), w, h, FW * .05));
    lowAdj((i, m) => { const d = (hl * hs[i] * .07 - ct * cs[i] * .08) * m; lowR[i] += d; lowG[i] += d * .97; lowB[i] += d * .94; });
  }

  // high-frequency (texture) layer
  const soften = amt('Skin retouching/Facial skin/Skin softening'), fhi = amt('Skin retouching/Facial skin/Frequency separation · high');
  const texture = (+P('Skin retouching/Skin texture/Texture')) / 100;
  const hiScale = Math.max(0, 1 - soften * .7 - fhi * .6 + texture * .8);
  if (hiScale !== 1) lowAdj((i, m) => { const k = 1 + (hiScale - 1) * m; hiR[i] *= k; hiG[i] *= k; hiB[i] *= k; });
  const clar = (+P('Skin retouching/Skin texture/Clarity')) / 100;
  if (clar) { const Y = new Float32Array(n); for (let i = 0; i < n; i++) Y[i] = luma(lowR[i], lowG[i], lowB[i]); const bY = skinBlur(Y, FW * .03);
    lowAdj((i, m) => { const hp = Y[i] - bY[i], d = clar * 1.5 * hp / (1 + Math.abs(hp) * 10) * m; lowR[i] += d; lowG[i] += d; lowB[i] += d; }); }

  // shine & finish: pull hot, pale highlights toward local skin (matte) or lift them (dewy / gloss)
  const shine = amt('Blemish removal/Face refinement/Reduce face shine');
  const finish = P('Skin retouching/Skin texture/Texture finish', 'Custom'), gloss = (+P('Skin retouching/Skin texture/Glossiness')) / 100;
  let shineK = shine + (finish === 'Matte' ? .6 : finish === 'Satin' ? .3 : 0), glow = (finish === 'Dewy' ? .5 : 0) + Math.max(0, gloss);
  if (gloss < 0) shineK += -gloss;
  if (shineK > 0 || glow > 0) {
    const bR = skinBlur(lowR, FW * .08), bG = skinBlur(lowG, FW * .08), bB = skinBlur(lowB, FW * .08);
    lowAdj((i, m) => { const y = luma(lowR[i], lowG[i], lowB[i]), yb = luma(bR[i], bG[i], bB[i]), over = clamp01((y - yb - .03) / .15);
      if (shineK > 0 && over > 0) { const k = Math.min(1, shineK) * over * m * .85; lowR[i] += (bR[i] + .03 - lowR[i]) * k; lowG[i] += (bG[i] + .03 - lowG[i]) * k; lowB[i] += (bB[i] + .03 - lowB[i]) * k; }
      if (glow > 0) { const d = glow * .12 * clamp01((y - yb + .02) / .12) * m; lowR[i] += d; lowG[i] += d; lowB[i] += d; } });
  }
  for (let i = 0; i < n; i++) if (skinSoft[i] > 0 || skin[i]) { R[i] = lowR[i] + hiR[i]; G[i] = lowG[i] + hiG[i]; B[i] = lowB[i] + hiB[i]; }


  }
  if (keep) { C.k2 = K2; C.s2 = save(); } }
    /* ----- lips ----- */
  const lipW = amt('Blemish removal/Face refinement/Lip wrinkles & flakes');
  const lipAmt = (+P('Makeup/Existing lip makeup/Lip makeup amount')) / 100, lipSat = (+P('Makeup/Existing lip makeup/Lip makeup saturation')) / 100;
  const lipLum = (+P('Makeup/Existing lip makeup/Lip makeup luminance')) / 100, lipDim = (+P('Makeup/Existing lip makeup/Lip makeup dimensionality')) / 100;
  const lipstick = amt('Makeup/Individual components/Lipstick amount');
  if (lipW > 0 || lipAmt || lipSat || lipLum || lipDim || lipstick > 0) {
    const sg = FW * .006;
    part([FL.ulip, FL.llip], [Math.max(1, sg), sg], ({ R, G, B, n, is, soft, blur, mblur }) => {
    const lips = is(FL.ulip, FL.llip), ls = soft(lips, Math.max(1, sg));
    const ld = lipW > 0 || lipDim ? blur(lips, sg) : null, bR = ld && mblur(R, lips, sg, ld), bG = ld && mblur(G, lips, sg, ld), bB = ld && mblur(B, lips, sg, ld);
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
    });
  }

  /* ----- blush ----- */
  const blush = amt('Makeup/Individual components/Blush amount');
  if (blush > 0) { const cz = once('blush', () => blur(zone([Z.ell(-.6, .55, .26, .2), Z.ell(.6, .55, .26, .2)], skin), w, h, FW * .05));
    for (let i = 0; i < n; i++) { const k = blush * cz[i] * skin[i]; if (k > 0) { R[i] += k * .07; G[i] -= k * .03; B[i] -= k * .005; } } }

  /* ----- brows ----- */
  const brow = (+P('Makeup/Definition/Eyebrow makeup')) / 100 + amt('Makeup/Individual components/Eyebrows amount');
  if (brow) { const sg = Math.max(1, FW * .006); part([FL.lbrow, FL.rbrow], [sg], ({ R, G, B, n, is, soft }) => { const bm = soft(is(FL.lbrow, FL.rbrow), sg);
    for (let i = 0; i < n; i++) { const m = bm[i]; if (m <= 0) continue; const y = luma(R[i], G[i], B[i]), k = brow * m, f = 1 - k * .35 * (1 - y);
      R[i] *= f; G[i] *= f; B[i] *= f; const yy = luma(R[i], G[i], B[i]), s = 1 + k * .25; R[i] = yy + (R[i] - yy) * s; G[i] = yy + (G[i] - yy) * s; B[i] = yy + (B[i] - yy) * s; } }); }

  /* ----- teeth ----- */
  const tw = amt('Teeth/Refine/Teeth whitening'), tb = amt('Teeth/Refine/Teeth brightness'), td_ = amt('Teeth/Refine/Teeth desaturation'), tf = amt('Teeth/Refine/Teeth flaws removal');
  if (tw > 0 || tf > 0) part([FL.mouth], [FW * .003, FW * .006], ({ R, G, B, n, is, blur, mblur }) => {
    const mouth = is(FL.mouth); let sy = 0, c = 0; for (let i = 0; i < n; i++) if (mouth[i]) { sy += luma(R[i], G[i], B[i]); c++; }
    if (c > 30) {
      const mean = sy / c, teeth = new Float32Array(n);
      for (let i = 0; i < n; i++) if (mouth[i]) { const y = luma(R[i], G[i], B[i]), mx = Math.max(R[i], G[i], B[i]), mn = Math.min(R[i], G[i], B[i]); teeth[i] = clamp01((y - mean * .9) / (mean * .5 + .02)) * clamp01(1.4 - (mx - mn) * 3); }
      const ts = blur(teeth, FW * .003);
      const td = tf > 0 ? blur(teeth, FW * .006) : null, fR = td && mblur(R, teeth, FW * .006, td), fG = td && mblur(G, teeth, FW * .006, td), fB = td && mblur(B, teeth, FW * .006, td);
      for (let i = 0; i < n; i++) { const m = ts[i] * mouth[i]; if (m <= 0) continue; let r = R[i], g = G[i], b = B[i];
        if (tf > 0) { const k = tf * .6; r += (fR[i] - r) * k; g += (fG[i] - g) * k; b += (fB[i] - b) * k; }
        const y = luma(r, g, b), des = tw * .55 + td_ * .45, br = tw * .07 + tb * .08;
        r = y + (r - y) * (1 - des); g = y + (g - y) * (1 - des); b = y + (b - y) * (1 - des * .7) + tw * .015;
        r += br; g += br; b += br;
        R[i] += (r - R[i]) * m; G[i] += (g - G[i]) * m; B[i] += (b - B[i]) * m; }
    }
  });

  /* ----- eyes: sclera / iris split inside each parsed eye ----- */
  const eb = amt('Eyes/Brightness/Eye brightness');
  const ibW = (+P('Eyes/Brightness/Iris brightness', 80)) / 100, wbW = (+P('Eyes/Brightness/Eye whites brightness', 80)) / 100, erW = (+P('Eyes/Brightness/Eye reflection', 40)) / 100, flW = (+P('Eyes/Brightness/Iris flare')) / 100;
  const veins = amt('Eyes/Brightness/Red vein removal'), cleanse = amt('Eyes/Brightness/Eye white cleanse'), redEye = !!P('Eyes/Brightness/Red eye removal');
  const irisSel = P('Eyes/Eye color/Iris color', 'Original'), irisAmt = amt('Eyes/Eye color/Iris color amount');
  const IRIS = { Brown: [28, .55], Hazel: [45, .45], Green: [110, .45], Blue: [210, .55], Gray: [210, .08], Amber: [38, .75] };
  if (eb > 0 || veins > 0 || cleanse > 0 || redEye || (irisAmt > 0 && IRIS[irisSel])) {
    const s3 = Math.max(1, FW * .003), s4 = Math.max(1, FW * .004);
    for (const eyeLabel of [FL.leye, FL.reye]) part([eyeLabel], [s3, s4], ({ R, G, B, n, is, soft, blur }) => {
      const em = is(eyeLabel); let c = 0, ys = []; for (let i = 0; i < n; i++) if (em[i]) { c++; ys.push(luma(R[i], G[i], B[i])); }
      if (c < 12) return;
      ys.sort((a, b) => a - b); const t = ys[Math.floor(ys.length * .45)], hi = ys[Math.floor(ys.length * .9)];
      const iris = new Float32Array(n), scl = new Float32Array(n);
      for (let i = 0; i < n; i++) if (em[i]) { const y = luma(R[i], G[i], B[i]); iris[i] = clamp01((t + .04 - y) / .08); scl[i] = 1 - iris[i]; }
      const is_ = blur(iris, s3), ss = blur(scl, s3);
      const ebS = soft(em, s4);
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
    });
  }

  /* ----- hair ----- */
  const hairSel = P('Hair/Hair color/Hair color', 'Original'), hairAmt = amt('Hair/Hair color/Hair color amount');
  const hTemp = (+P('Hair/Hair color/Hair color temperature')) / 100, hSat = amt('Hair/Hair color/Hair color saturation');
  const smooth = amt('Hair/Cleanup/Smooth hair'), frizz = (+P('Hair/Cleanup/Tame frizzy hair', 100)) / 100, hShine = amt('Hair/Cleanup/Hair shine'), gray = amt('Hair/Cleanup/White hair blackening');
  const HAIR = { Black: [25, .1, .1], Brown: [24, .36, .26], Blonde: [40, .42, .55] };   // hue, saturation, target mean lightness
  if ((hairAmt > 0 && hairSel !== 'Original') || hTemp || hSat > 0 || smooth > 0 || hShine > 0 || gray > 0) {
    const hm = once('hair', () => is(FL.hair)); let c = 0, sy = 0; for (let i = 0; i < n; i++) if (hm[i]) { c++; sy += luma(R[i], G[i], B[i]); }
    if (c > 50) {
      // soft edge on both sides of the hair line, but only lightly onto skin (bangs over a forehead)
      const meanY = sy / c, hs = once('hairSoft', () => { const b = blur(hm, w, h, Math.max(1, FW * .006)); for (let i = 0; i < n; i++) if (!hm[i] && skin[i]) b[i] *= .35; return b; });
      const sig = FW * .006 * (.5 + frizz), hd = smooth > 0 ? den('hair', hm, sig) : null, sR = hd && mblur(R, hm, w, h, sig, hd), sG = hd && mblur(G, hm, w, h, sig, hd), sB = hd && mblur(B, hm, w, h, sig, hd);
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
  const box = new Int32Array(32 * 4); for (let l = 0; l < 32; l++) { box[l * 4] = w; box[l * 4 + 1] = h; box[l * 4 + 2] = box[l * 4 + 3] = -1; }   // bounding box of every label
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = ((ry0 + y) * W + rx0 + x) * 4; R[i] = px[j] / 255; G[i] = px[j + 1] / 255; B[i] = px[j + 2] / 255;
    const u = Math.floor((rx0 + x - sx0) / size * S), v = Math.floor((ry0 + y - sy0) / size * S);
    const l = lbl[i] = u >= 0 && v >= 0 && u < S && v < S ? lab[v * S + u] : 0, b = l * 4;
    if (x < box[b]) box[b] = x; if (y < box[b + 1]) box[b + 1] = y; if (x > box[b + 2]) box[b + 2] = x; if (y > box[b + 3]) box[b + 3] = y;
  }
  const skin = labelMask(lbl, n, [FL.skin, FL.nose]), fx0 = box[FL.skin * 4], fx1 = Math.max(fx0, box[FL.skin * 4 + 2]);
  const FW = Math.max(20, fx1 - fx0);                              // face width in pixels: all radii scale with it
  const Z = zoneMaker(face.kps.map(([x, y]) => [x * W, y * H]), rx0, ry0);
  return { w, h, n, rx0, ry0, lbl, box, skin, FW, Z, R0: R, G0: G, B0: B, fixed: {}, den: new Map() };
}

// add the healed change of the chosen spots (bilinear in the AI crop, which may be at another scale)
// the ABPN result mapped onto this face region once (nearest spot id + bilinear change); slider moves only re-weight it
function healMap(ai, w, h, rx0, ry0) {
  const { x0, y0, s, pw, ph, delta, comp } = ai, N = pw * ph, n = w * h, cid = new Int32Array(n).fill(-1), d = new Float32Array(3 * n);
  for (let y = 0; y < h; y++) { const fy = (ry0 + y + .5 - y0) * s - .5; if (fy < -1 || fy > ph) continue;
    for (let x = 0; x < w; x++) { const fx = (rx0 + x + .5 - x0) * s - .5; if (fx < -1 || fx > pw) continue;
      const i = y * w + x, c = comp[Math.round(Math.max(0, Math.min(ph - 1, fy))) * pw + Math.round(Math.max(0, Math.min(pw - 1, fx)))];
      const ax = Math.max(0, Math.min(pw - 1, Math.floor(fx))), ay = Math.max(0, Math.min(ph - 1, Math.floor(fy))), bx = Math.min(pw - 1, ax + 1), by = Math.min(ph - 1, ay + 1);
      const tx = Math.max(0, Math.min(1, fx - ax)), ty = Math.max(0, Math.min(1, fy - ay)), w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
      let any = c >= 0;
      for (let k = 0; k < 3; k++) { const o = k * N, v = delta[o + ay * pw + ax] * w00 + delta[o + ay * pw + bx] * w10 + delta[o + by * pw + ax] * w01 + delta[o + by * pw + bx] * w11; d[k * n + i] = v; if (v) any = true; }
      if (any) cid[i] = c >= 0 ? c : [ay * pw + ax, ay * pw + bx, by * pw + ax, by * pw + bx].map(j => comp[j]).find(v => v >= 0) ?? -1; } }
  return { cid, d, src: ai.delta };
}
// share[c] = how much of spot c this layer takes on (0..1), amount[c] = the slider strength for its kind
function healSpots(R, G, B, ai, share, amount, C, w, h, rx0, ry0, beard, done, moles) {
  const M = C.heal && C.heal.src === ai.delta && C.heal.w === w ? C.heal : (C.heal = Object.assign(healMap(ai, w, h, rx0, ry0), { w }));
  const { cid, d } = M, n = w * h;
  for (let i = 0; i < n; i++) { const c = cid[i]; if (c < 0) continue; const s = share[c], g = s * amount[c];
    if (!g) { if (moles && ai.spots[c].kind === 'mole') moles[i] = 1; continue; }
    if (beard && beard[i]) continue;
    R[i] += d[i] * g; G[i] += d[n + i] * g; B[i] += d[2 * n + i] * g; done[i] = s; }
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
function apply(img, analysis, getV) {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  analysis.faces.forEach((f, k) => applyFace(out, f, p => getV(p, k), img.width, img.height, img.width * img.height <= 1.3e7));
  return out;
}

return { apply };
})();
