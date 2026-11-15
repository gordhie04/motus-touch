/* Motus Touch: trained on ~14,500 professional retouches (FFHQR), see motus-train/.
   One network per face: returns the retouched face and a map of where it edited. Run once per face in
   the model worker and cached; the slider only scales the stored change, so it is instant. */
'use strict';

const MotusPro = (() => {
const TARGET = 460;                  // face-box width the network was trained at (FFHQ aligned faces at 1024 px)
const jobs = new Map();

function planar(data, n) {
  const o = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { o[i] = data[i * 4] / 127.5 - 1; o[n + i] = data[i * 4 + 1] / 127.5 - 1; o[2 * n + i] = data[i * 4 + 2] / 127.5 - 1; }
  return o;
}

async function faceJob(src, W, H, face) {
  const fw = face.w * W, fh = face.h * H, L = 1.6 * Math.max(fw, fh), cx = face.x * W + fw / 2, cy = face.y * H + fh / 2;
  const x0 = Math.max(0, Math.floor(cx - L / 2)), y0 = Math.max(0, Math.floor(cy - L / 2));
  const cw = Math.min(W, Math.ceil(cx + L / 2)) - x0, ch = Math.min(H, Math.ceil(cy + L / 2)) - y0;
  if (cw < 32 || ch < 32) return null;
  // bring the face to the training scale; the network needs sides that are multiples of 64
  const s = TARGET / Math.max(fw, 1), PW = Math.max(64, Math.round(cw * s / 64) * 64), PH = Math.max(64, Math.round(ch * s / 64) * 64);
  if (PW * PH > 1536 * 1536) return null;
  const c = document.createElement('canvas'); c.width = PW; c.height = PH;
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.drawImage(src, x0, y0, cw, ch, 0, 0, PW, PH);
  const n = PW * PH, x = planar(g.getImageData(0, 0, PW, PH).data, n);
  const r = await MotusModels.run('motus_touch', { image: { type: 'float32', dims: [1, 3, PH, PW], data: x.slice() } });   // the worker takes ownership of what it is sent
  const out = r.retouched.data, delta = new Float32Array(3 * n);
  for (let i = 0; i < 3 * n; i++) delta[i] = (out[i] - x[i]) / 2;          // change in 0..1 units
  return { x0, y0, sx: PW / cw, sy: PH / ch, PW, PH, delta, mask: Float32Array.from(r.mask.data), W, H };
}

// the result for this image size, scaled from one computed at another size (same photo) if needed
function at(face, W, H) {
  const all = face.pro; if (!all) return undefined;
  const own = all[W + 'x' + H]; if (own !== undefined) return own;
  for (const [k0, e] of Object.entries(all)) {
    if (e === null) return null;
    if (!e.W) continue;
    const k = W / e.W; if (Math.abs(H / e.H - k) > .01) continue;
    return { ...e, x0: e.x0 * k, y0: e.y0 * k, sx: e.sx / k, sy: e.sy / k, W, H };
  }
  return undefined;
}
const key = (photo, img) => photo.id + '|' + img.width + 'x' + img.height + '|pro';
const ck = img => img.width + 'x' + img.height;
function ready(photo, img, a) { return a.faces.every(f => at(f, img.width, img.height) !== undefined); }
function busy(photo, img) { return jobs.has(key(photo, img)); }
function prepare(photo, img, a) {
  const k = key(photo, img); if (jobs.has(k)) return jobs.get(k);
  const src = img instanceof ImageData ? (() => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').putImageData(img, 0, 0); return c; })() : img;
  const p = (async () => { for (const f of a.faces) { f.pro = f.pro || {}; if (f.pro[ck(img)] === undefined) f.pro[ck(img)] = await faceJob(src, img.width, img.height, f); } })().finally(() => jobs.delete(k));
  jobs.set(k, p); return p;
}
function drop(a, img) { for (const f of a.faces) if (f.pro) delete f.pro[ck(img)]; }

// add `amount` of the learned change inside `allow` (soft skin mask, region coordinates)
function apply(R, G, B, P, amount, allow, w, h, rx0, ry0) {
  const { x0, y0, sx, sy, PW, PH, delta } = P, N = PW * PH;
  for (let y = 0; y < h; y++) { const fy = (ry0 + y + .5 - y0) * sy - .5; if (fy < -.5 || fy > PH - .5) continue;
    for (let x = 0; x < w; x++) { const i = y * w + x, a = allow[i] * amount; if (a <= 0) continue;
      const fx = (rx0 + x + .5 - x0) * sx - .5; if (fx < -.5 || fx > PW - .5) continue;
      const edge = Math.min(1, Math.min(fx + .5, PW - .5 - fx) / (PW * .05), Math.min(fy + .5, PH - .5 - fy) / (PH * .05));   // fade out at the crop border
      if (edge <= 0) continue;
      const ax = Math.max(0, Math.min(PW - 1, Math.floor(fx))), ay = Math.max(0, Math.min(PH - 1, Math.floor(fy))), bx = Math.min(PW - 1, ax + 1), by = Math.min(PH - 1, ay + 1);
      const tx = Math.max(0, Math.min(1, fx - ax)), ty = Math.max(0, Math.min(1, fy - ay));
      const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty, j00 = ay * PW + ax, j10 = ay * PW + bx, j01 = by * PW + ax, j11 = by * PW + bx;
      const d = c => delta[c * N + j00] * w00 + delta[c * N + j10] * w10 + delta[c * N + j01] * w01 + delta[c * N + j11] * w11;
      R[i] += d(0) * a * edge; G[i] += d(1) * a * edge; B[i] += d(2) * a * edge; } }
}

// on by default; localStorage motus.retouchEngine = 'classic' switches back to the ABPN + spot tools
let enabled = true; try { enabled = localStorage.getItem('motus.retouchEngine') !== 'classic'; } catch (e) {}
return { prepare, ready, busy, drop, apply, at, get enabled() { return enabled && !!MotusModels.registry.motus_touch; } };
})();
