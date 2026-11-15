/* Image analysis for automatic tools. Pure JS on this computer, no models. */
'use strict';

const MotusAuto = (() => {

const srgbToLinear = v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
function rgbToLab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  let x = (.4124 * R + .3576 * G + .1805 * B) / .95047, y = .2126 * R + .7152 * G + .0722 * B, z = (.0193 * R + .1192 * G + .9505 * B) / 1.08883;
  const f = t => t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function step(img, target = 60000) { return Math.max(1, Math.floor(Math.sqrt(img.width * img.height / target))); }

function labStats(img) {
  const d = img.data, s = step(img), sum = [0, 0, 0], sq = [0, 0, 0]; let n = 0;
  for (let y = 0; y < img.height; y += s) for (let x = 0; x < img.width; x += s) {
    const i = (y * img.width + x) * 4; if (d[i + 3] < 128) continue;
    const lab = rgbToLab(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
    for (let k = 0; k < 3; k++) { sum[k] += lab[k]; sq[k] += lab[k] * lab[k]; } n++;
  }
  n = Math.max(1, n); const mean = sum.map(v => v / n);
  return { mean, std: sq.map((v, k) => Math.max(.5, Math.sqrt(Math.max(0, v / n - mean[k] ** 2)))) };
}

function airLight(img) { // brightest 0.2% of the dark channel
  const d = img.data, s = step(img), px = [];
  for (let y = 0; y < img.height; y += s) for (let x = 0; x < img.width; x += s) { const i = (y * img.width + x) * 4; px.push([Math.min(d[i], d[i + 1], d[i + 2]), d[i], d[i + 1], d[i + 2]]); }
  px.sort((a, b) => b[0] - a[0]); const top = px.slice(0, Math.max(1, Math.round(px.length * .002)));
  return [1, 2, 3].map(k => top.reduce((a, p) => a + p[k], 0) / top.length / 255);
}

// multipliers used by the basic panel: r*(1+w+.35t), g*(1-t), b*(1-w+.35t); w=temp*.0018, t=tint*.0012
function autoWhiteBalance(img) {
  const d = img.data, s = step(img); let r = 0, g = 0, b = 0, n = 0, R = 0, G = 0, B = 0, N = 0;
  for (let y = 0; y < img.height; y += s) for (let x = 0; x < img.width; x += s) {
    const i = (y * img.width + x) * 4, pr = d[i] / 255, pg = d[i + 1] / 255, pb = d[i + 2] / 255;
    const l = .2126 * pr + .7152 * pg + .0722 * pb, mx = Math.max(pr, pg, pb), mn = Math.min(pr, pg, pb);
    if (l < .12 || mx > .97) continue;
    R += pr; G += pg; B += pb; N++;
    if ((mx - mn) / (mx + 1e-3) < .25) { r += pr; g += pg; b += pb; n++; }   // near-neutral pixels
  }
  if (n < N * .02 || n < 50) { r = R; g = G; b = B; n = N; }       // fall back to gray world
  if (!n) return { temperature: 0, tint: 0 };
  r /= n; g /= n; b /= n;
  let w = 0, t = 0;
  for (let k = 0; k < 20; k++) { w = (b - r) * (1 + .35 * t) / (r + b); const target = r * (1 + w + .35 * t); t = 1 - target / g; t = Math.max(-.12, Math.min(.12, t)); }
  const clamp = v => Math.max(-100, Math.min(100, Math.round(v)));
  return { temperature: clamp(w / .0018 * .85), tint: clamp(t / .0012 * .85) };
}

function autoExposure(img, temperature = 0, tint = 0) {
  const d = img.data, s = step(img), w = temperature * .0018, t = tint * .0012, lum = [];
  for (let y = 0; y < img.height; y += s) for (let x = 0; x < img.width; x += s) {
    const i = (y * img.width + x) * 4;
    lum.push(.2126 * d[i] / 255 * (1 + w + .35 * t) + .7152 * d[i + 1] / 255 * (1 - t) + .0722 * d[i + 2] / 255 * (1 - w + .35 * t));
  }
  lum.sort((a, b) => a - b);
  const median = lum[Math.floor(lum.length * .5)] || .4, p98 = lum[Math.floor(lum.length * .98)] || 1;
  let e = 2.2 * Math.log2(.46 / Math.max(.02, median));
  e = Math.min(e, 2.2 * Math.log2(.98 / Math.max(.05, p98)) + .6);     // don't blow out highlights
  return Math.max(-2, Math.min(2, Math.round(e * 20) / 20));
}

/* straight-edge samples for level / upright: {x,y,dx,dy,w} in height-normalized centered coords */
function edgeSamples(img) {
  const sc = Math.min(1, 700 / Math.max(img.width, img.height)), W = Math.round(img.width * sc), H = Math.round(img.height * sc);
  const c = document.createElement('canvas'); c.width = W; c.height = H; const ctx = c.getContext('2d', { willReadFrequently: true });
  const src = document.createElement('canvas'); src.width = img.width; src.height = img.height; src.getContext('2d').putImageData(img, 0, 0);
  ctx.drawImage(src, 0, 0, W, H); const d = ctx.getImageData(0, 0, W, H).data, gray = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) gray[i] = (.299 * d[i * 4] + .587 * d[i * 4 + 1] + .114 * d[i * 4 + 2]) / 255;
  // light blur, then gradients; orientation from a 5x5 structure tensor (much less grid bias than raw Sobel angles)
  const sm = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x;
    sm[i] = (4 * gray[i] + 2 * (gray[i - 1] + gray[i + 1] + gray[i - W] + gray[i + W]) + gray[i - W - 1] + gray[i - W + 1] + gray[i + W - 1] + gray[i + W + 1]) / 16; }
  const GX = new Float32Array(W * H), GY = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x;
    GX[i] = sm[i - W + 1] + 2 * sm[i + 1] + sm[i + W + 1] - sm[i - W - 1] - 2 * sm[i - 1] - sm[i + W - 1];
    GY[i] = sm[i + W - 1] + 2 * sm[i + W] + sm[i + W + 1] - sm[i - W - 1] - 2 * sm[i - W] - sm[i - W + 1]; }
  const out = [];
  for (let y = 4; y < H - 4; y++) for (let x = 4; x < W - 4; x++) {
    const i = y * W + x, m = Math.hypot(GX[i], GY[i]); if (m < .3) continue;
    let jxx = 0, jyy = 0, jxy = 0;
    for (let v = -2; v <= 2; v++) for (let u = -2; u <= 2; u++) { const k = i + v * W + u; jxx += GX[k] * GX[k]; jyy += GY[k] * GY[k]; jxy += GX[k] * GY[k]; }
    const tr = jxx + jyy, coherence = Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / (tr + 1e-9);
    if (coherence < .85) continue;                                  // line-like only, not texture or corners
    const theta = .5 * Math.atan2(2 * jxy, jxx - jyy);               // gradient direction
    out.push({ x: (x - W / 2) / H, y: (y - H / 2) / H, dx: -Math.sin(theta), dy: Math.cos(theta), w: m * coherence });
  }
  return { samples: out, aspect: W / H };
}

const angleOf = (dx, dy) => Math.atan2(dy, dx);
function mapDir(Hm, s) { // forward map a short segment through a row-major homography
  const f = (x, y) => { const w = Hm[6] * x + Hm[7] * y + Hm[8]; return [(Hm[0] * x + Hm[1] * y + Hm[2]) / w, (Hm[3] * x + Hm[4] * y + Hm[5]) / w]; };
  const e = .004, a = f(s.x - s.dx * e, s.y - s.dy * e), b = f(s.x + s.dx * e, s.y + s.dy * e); return [b[0] - a[0], b[1] - a[1]];
}
// cost: how far mapped near-vertical (and optionally near-horizontal) lines are from true vertical/horizontal
function cost(E, t, useH, useV) {
  const Hm = MotusParams.homography(t, E.aspect); let c = 0, wsum = 0;
  for (const s of E.samples) {
    const [dx, dy] = mapDir(Hm, s); let a = angleOf(dx, dy) * 180 / Math.PI; a = ((a % 180) + 180) % 180;
    const dv = Math.abs(a - 90), dh = Math.min(a, 180 - a);
    if (useV && dv < 20) { c += s.w * Math.min(dv, 6) ** 2; wsum += s.w; }
    else if (useH && dh < 12) { c += s.w * Math.min(dh, 6) ** 2; wsum += s.w; }
  }
  return wsum ? c / wsum : Infinity;
}
function search(E, base, keys, ranges) {
  let best = { ...base }, bestC = cost(E, best, true, true);
  for (const [stepSize, span] of ranges) {
    const center = { ...best };
    const grid = k => { const out = []; for (let v = Math.max(-100, center[k] - span); v <= Math.min(100, center[k] + span); v += stepSize) out.push(v); return out; };
    for (const r of keys.includes('rotate') ? grid('rotate') : [center.rotate])
      for (const v of keys.includes('vertical') ? grid('vertical') : [center.vertical]) {
        const t = { ...center, rotate: r, vertical: v }, c = cost(E, t, true, true);
        if (c < bestC) { bestC = c; best = t; }
      }
  }
  return best;
}
function level(img, t) { const E = edgeSamples(img); if (E.samples.length < 40) return null; return search(E, t, ['rotate'], [[4, 100], [1, 6], [.25, 1.5]]); }
function upright(img, t, withRotate = true) {
  const E = edgeSamples(img); if (E.samples.length < 40) return null;
  return search(E, t, withRotate ? ['rotate', 'vertical'] : ['vertical'], [[8, 100], [2, 12], [.5, 3]]);
}

/* lateral chromatic aberration: radial scale of red & blue vs green, measured on full-res corners */
async function chromaticAberration(image) {
  const W = image.naturalWidth, H = image.naturalHeight, S = Math.min(384, Math.floor(Math.min(W, H) / 3));
  const cx = W / 2, cy = H / 2, norm = H, c = document.createElement('canvas'); c.width = S; c.height = S;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const crops = [];
  for (const [x0, y0] of [[0, 0], [W - S, 0], [0, H - S], [W - S, H - S]]) { ctx.clearRect(0, 0, S, S); ctx.drawImage(image, x0, y0, S, S, 0, 0, S, S); crops.push({ x0, y0, d: ctx.getImageData(0, 0, S, S).data }); await new Promise(r => setTimeout(r, 0)); }
  const sample = (crop, ch, x, y) => { const lx = x - crop.x0, ly = y - crop.y0; if (lx < 0 || ly < 0 || lx >= S - 1 || ly >= S - 1) return null;
    const ix = Math.floor(lx), iy = Math.floor(ly), fx = lx - ix, fy = ly - iy, i = (iy * S + ix) * 4 + ch;
    return (crop.d[i] * (1 - fx) + crop.d[i + 4] * fx) * (1 - fy) + (crop.d[i + S * 4] * (1 - fx) + crop.d[i + S * 4 + 4] * fx) * fy; };
  const pts = [];
  for (const crop of crops) for (let y = 2; y < S - 2; y += 1) for (let x = 2; x < S - 2; x += 1) {
    const i = (y * S + x) * 4 + 1, gx = crop.d[i + 4] - crop.d[i - 4], gy = crop.d[i + S * 4] - crop.d[i - S * 4];
    if (Math.abs(gx) + Math.abs(gy) > 60) pts.push([crop, crop.x0 + x, crop.y0 + y, crop.d[i]]);
  }
  if (pts.length < 200) return { r: 0, b: 0 };
  const fit = ch => { let best = 0, bestC = Infinity;
    for (let s = -.003; s <= .003001; s += .00015) { let c = 0, n = 0;
      for (const [crop, x, y, g] of pts) { const v = sample(crop, ch, cx + (x - cx) * (1 + s), cy + (y - cy) * (1 + s)); if (v === null) continue; c += (v - g) ** 2; n++; }
      if (n && c / n < bestC) { bestC = c / n; best = s; } }
    return best; };
  return { r: fit(0), b: fit(2) };
}

async function fileStats(file) {
  const bmp = await createImageBitmap(file), sc = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * sc)); c.height = Math.max(1, Math.round(bmp.height * sc));
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(bmp, 0, 0, c.width, c.height); bmp.close?.();
  return labStats(ctx.getImageData(0, 0, c.width, c.height));
}

return { labStats, airLight, autoWhiteBalance, autoExposure, level, upright, chromaticAberration, fileStats, edgeSamples };
})();
