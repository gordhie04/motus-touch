/* Freckle and dark-spot lifting, trained on an Evoto before/after pair.
   1. candidates: small spots darker than the skin around them (multi-scale, sizes relative to the face width)
   2. a logistic model scores each candidate the way Evoto chose (brownish, deep for the local texture, not pores)
   3. chosen spots are lifted toward the surrounding skin; fine texture stays because only the low band moves.
   Training: tests/train/fit_spots.py. Held-out half-face F1 0.47-0.66 vs Evoto's own selection. */
'use strict';

const MotusSpots = (() => {
// standardized logistic regression; feature order matches fit_spots.py
const M = { mu: [3.58138, 2.67622, 0.0072, 1.52425, 0.65387, 58.13791, 0.66339, 0.52779, 2.13698, 1.8742],
  sd: [1.46907, 0.52847, 0.00487, 0.62599, 0.18741, 16.90204, 0.76326, 1.16614, 1.11614, 0.72632],
  w: [-0.5411, 0.8289, 0.3571, -0.1192, -0.0709, -0.6138, 0.2719, 0.7648, 0.0761, 1.0768], b: -1.2565 };

function gauss(src, w, h, sigma) {          // exact separable gaussian, for the small radii
  const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * r + 1); let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp(-i * i / (2 * sigma * sigma)); for (let i = 0; i < k.length; i++) k[i] /= s;
  const t = new Float32Array(w * h), o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { const row = y * w; for (let x = 0; x < w; x++) { let a = 0; for (let i = -r; i <= r; i++) a += src[row + Math.min(w - 1, Math.max(0, x + i))] * k[i + r]; t[row + x] = a; } }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let a = 0; for (let i = -r; i <= r; i++) a += t[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + r]; o[y * w + x] = a; }
  return o;
}
const lin = c => c <= .04045 ? c / 12.92 : Math.pow((c + .055) / 1.055, 2.4);
function toLab(R, G, B, n) {
  const L = new Float32Array(n), A = new Float32Array(n), Bb = new Float32Array(n), f = t => t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  for (let i = 0; i < n; i++) { const r = lin(R[i]), g = lin(G[i]), b = lin(B[i]);
    const X = f((.4124 * r + .3576 * g + .1805 * b) / .95047), Y = f(.2126 * r + .7152 * g + .0722 * b), Z = f((.0193 * r + .1192 * g + .9505 * b) / 1.08883);
    L[i] = 116 * Y - 16; A[i] = 500 * (X - Y); Bb[i] = 200 * (Y - Z); }
  return { L, A, B: Bb };
}

/* Analyse once per face region. allow = where spots may be (skin away from eyes, brows, lips). blur = the engine's large-radius blur. */
function analyse(R0, G0, B0, allow, w, h, FW, blur) {
  const n = w * h, { L, A, B } = toLab(R0, G0, B0, n);
  const fs = Math.max(.8, FW * .0013), fine = gauss(L, w, h, fs), sur = blur(L, w, h, FW * .015), D = new Float32Array(n);
  for (let i = 0; i < n; i++) D[i] = sur[i] - fine[i];
  const hp = new Float32Array(n), lo = blur(L, w, h, FW * .01); for (let i = 0; i < n; i++) hp[i] = (L[i] - lo[i]) ** 2;
  const tv = blur(hp, w, h, FW * .02), As = blur(A, w, h, FW * .015), Bs = blur(B, w, h, FW * .015);
  const comp = new Int32Array(n).fill(-1), spots = [], stack = [], maxA = (FW * .04) ** 2, seen = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (seen[i] || !allow[i] || D[i] <= 2) continue;
    const px = []; let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1; stack.push(i); seen[i] = 1;
    while (stack.length) { const j = stack.pop(), x = j % w, y = (j / w) | 0; px.push(j);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (const k of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) if (k >= 0 && !seen[k] && allow[k] && D[k] > 2) { seen[k] = 1; stack.push(k); } }
    const a = px.length; if (a < 4 || a > maxA) continue;
    let dmax = 0, dsum = 0, Ls = 0, da = 0, db = 0, tx = 0;
    for (const j of px) { dmax = Math.max(dmax, D[j]); dsum += D[j]; Ls += fine[j]; da += A[j] - As[j]; db += B[j] - Bs[j]; tx += Math.sqrt(tv[j]); }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1, tex = tx / a;
    const f = [dmax, dsum / a, Math.sqrt(a) / FW, Math.max(bw, bh) / Math.max(1, Math.min(bw, bh)), a / (bw * bh), Ls / a, da / a, db / a, tex, dmax / Math.max(.5, tex)];
    let z = M.b; for (let k = 0; k < 10; k++) z += M.w[k] * (f[k] - M.mu[k]) / M.sd[k];
    const id = spots.length; for (const j of px) comp[j] = id;
    spots.push({ p: 1 / (1 + Math.exp(-z)), mole: dmax > 8 && Math.sqrt(a) / FW > .022, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
  }
  // per-channel lift toward the surrounding skin (low band only; texture finer than `fs` is untouched)
  const lift = [R0, G0, B0].map(c => { const s = blur(c, w, h, FW * .015), fc = gauss(c, w, h, fs), o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = s[i] - fc[i]; return o; });
  return { comp, spots, lift, fs };
}

/* strength 0..1 (Freckles slider), mole = remove large dark marks too. touched = pixels another healer already fixed. */
function apply(R, G, B, S, strength, moles, w, h, touched, skip) {
  if (!S.spots.length || strength <= 0) return 0;
  const thr = .75 - .45 * Math.min(1, strength), k = .35 + .55 * Math.min(1, strength), n = w * h;
  const on = S.spots.map(sp => (sp.mole ? moles : 1) && sp.p > thr && !(skip && skip(sp.cx, sp.cy)) ? 1 : 0);
  // skip spots the AI healer already repainted
  if (touched) for (let i = 0; i < n; i++) { const c = S.comp[i]; if (c >= 0 && touched[i]) on[c] = 0; }
  const m = new Float32Array(n); let cnt = 0;
  for (let i = 0; i < n; i++) { const c = S.comp[i]; if (c >= 0 && on[c]) { m[i] = 1; cnt++; } }
  if (!cnt) return 0;
  const mm = gauss(m, w, h, Math.max(1, S.fs * 1.2));           // feathered, slightly grown edge
  for (let i = 0; i < n; i++) { const a = Math.min(1, mm[i] * 1.6) * k; if (a < .004) continue;
    if (.2126 * S.lift[0][i] + .7152 * S.lift[1][i] + .0722 * S.lift[2][i] <= 0) continue;   // only ever lift, never darken an edge
    R[i] += S.lift[0][i] * a; G[i] += S.lift[1][i] * a; B[i] += S.lift[2][i] * a; }
  return cnt;
}

return { analyse, apply };
})();
