/* AI skin retouching with ABPN (Alibaba DAMO, "Adaptive Blend Pyramid Network", CVPR 2022, Apache-2.0).
   Three networks, run once per face in the model worker and cached:
     1. abpn_detect   finds blemishes (acne, spots, freckles) as a probability map
     2. abpn_inpaint  repaints only those pixels from the surrounding skin (texture is kept)
     3. abpn_blend    predicts a soft-light layer that evens tone (dodge & burn)
   The sliders never re-run the networks: they choose which healed spots to keep and how much of
   the blend layer to apply. If nothing is detected, nothing changes. */
'use strict';

const MotusABPN = (() => {
const FL = MotusFaces.L;
const jobs = new Map();          // photoId|WxH -> Promise
const SKIN = new Set([FL.skin, FL.nose, FL.lear, FL.rear, FL.neck]);

function cropCanvas(src, x0, y0, cw, ch, pw, ph) {
  const c = document.createElement('canvas'); c.width = pw; c.height = ph;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, x0, y0, cw, ch, 0, 0, pw, ph); return c;
}
function toPlanar(data, n, out = new Float32Array(3 * n)) {   // RGBA bytes -> CHW in [-1, 1]
  for (let i = 0; i < n; i++) { out[i] = data[i * 4] / 127.5 - 1; out[n + i] = data[i * 4 + 1] / 127.5 - 1; out[2 * n + i] = data[i * 4 + 2] / 127.5 - 1; }
  return out;
}
function resizePlane(src, sw, sh, dw, dh, nearest) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) { const fy = nearest ? Math.min(sh - 1, Math.floor((y + .5) * sh / dh)) : Math.max(0, (y + .5) * sh / dh - .5);
    for (let x = 0; x < dw; x++) {
      if (nearest) { out[y * dw + x] = src[fy * sw + Math.min(sw - 1, Math.floor((x + .5) * sw / dw))]; continue; }
      const fx = Math.max(0, (x + .5) * sw / dw - .5), x0 = Math.min(sw - 1, fx | 0), y0 = Math.min(sh - 1, fy | 0), x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sh - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
      out[y * dw + x] = (src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx) * (1 - ty) + (src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx) * ty;
    } }
  return out;
}

// face parse labels sampled into crop pixel space
function skinMask(face, W, H, x0, y0, s, pw, ph) {
  const S = face.S, lab = face.labels, cx = face.crop.x * W, cy = face.crop.y * H, size = face.crop.size * W, m = new Uint8Array(pw * ph);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    const X = x0 + (x + .5) / s, Y = y0 + (y + .5) / s, u = Math.floor((X - cx) / size * S), v = Math.floor((Y - cy) / size * S);
    if (u >= 0 && v >= 0 && u < S && v < S && SKIN.has(lab[v * S + u])) m[y * pw + x] = 1;
  }
  return m;
}

async function faceJob(src, W, H, face, cap) {
  // square crop 1.5x the detected face, clipped to the photo (as the reference pipeline)
  const fx = face.x * W, fy = face.y * H, fw = face.w * W, fh = face.h * H, L = 1.5 * Math.max(fw, fh), cxm = fx + fw / 2, cym = fy + fh / 2;
  const x0 = Math.max(0, Math.floor(cxm - L / 2)), y0 = Math.max(0, Math.floor(cym - L / 2)), x1 = Math.min(W, Math.ceil(cxm + L / 2)), y1 = Math.min(H, Math.ceil(cym + L / 2));
  const cw = x1 - x0, ch = y1 - y0; if (cw < 32 || ch < 32) return null;
  // work between 384 px (tiny faces get upsampled so spots are a few pixels wide) and `cap`
  const s = Math.min(cap, Math.max(384, Math.max(cw, ch))) / Math.max(cw, ch), pw = Math.round(cw * s), ph = Math.round(ch * s), n = pw * ph;
  const orig = cropCanvas(src, x0, y0, cw, ch, pw, ph).getContext('2d').getImageData(0, 0, pw, ph).data;
  const x = toPlanar(orig, n);

  // 1) detection at 768x768
  const d768 = cropCanvas(src, x0, y0, cw, ch, 768, 768).getContext('2d').getImageData(0, 0, 768, 768).data;
  const det = await MotusModels.run('abpn_detect', { image: { type: 'float32', dims: [1, 3, 768, 768], data: toPlanar(d768, 768 * 768) } });
  const logit = det.logits.data, p768 = new Float32Array(768 * 768); for (let i = 0; i < p768.length; i++) p768[i] = 1 / (1 + Math.exp(-logit[i]));
  const prob = resizePlane(p768, 768, 768, pw, ph, true), allow = skinMask(face, W, H, x0, y0, s, pw, ph);
  const m = new Float32Array(n); let any = 0;
  for (let i = 0; i < n; i++) { const p = prob[i] * allow[i]; m[i] = p >= .5 ? 1 : p >= .35 ? p : 0; if (m[i]) any++; }

  // 2) inpaint only the 512 tiles that contain a blemish (32 px context on every side)
  const healed = Float32Array.from(x);
  if (any) {
    const P = 512, PAD = 32, T = P + 2 * PAD, tilesX = Math.ceil(pw / P), tilesY = Math.ceil(ph / P);
    for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) {
      let has = false; for (let y = ty * P; y < Math.min(ph, ty * P + P) && !has; y++) for (let xx = tx * P; xx < Math.min(pw, tx * P + P); xx++) if (m[y * pw + xx]) { has = true; break; }
      if (!has) continue;
      const img = new Float32Array(3 * T * T), keep = new Float32Array(T * T);
      for (let y = 0; y < T; y++) for (let xx = 0; xx < T; xx++) {
        const sy = ty * P + y - PAD, sx = tx * P + xx - PAD, j = y * T + xx;
        if (sy < 0 || sx < 0 || sy >= ph || sx >= pw) continue;              // zero padding, as in training
        const i = sy * pw + sx, k = 1 - m[i]; keep[j] = k;
        img[j] = x[i] * k; img[T * T + j] = x[n + i] * k; img[2 * T * T + j] = x[2 * n + i] * k;
      }
      const o = (await MotusModels.run('abpn_inpaint', { image: { type: 'float32', dims: [1, 3, T, T], data: img }, mask: { type: 'float32', dims: [1, 1, T, T], data: keep } })).output.data;
      for (let y = PAD; y < PAD + P; y++) for (let xx = PAD; xx < PAD + P; xx++) {
        const sy = ty * P + y - PAD, sx = tx * P + xx - PAD; if (sy >= ph || sx >= pw) continue;
        const i = sy * pw + sx, a = m[i]; if (!a) continue; const j = y * T + xx;
        for (let c = 0; c < 3; c++) healed[c * n + i] = x[c * n + i] * (1 - a) + o[c * T * T + j] * a;
      }
    }
  }

  // 3) blend layer from the healed face at 512x512
  const h512 = new Float32Array(3 * 512 * 512);
  for (let c = 0; c < 3; c++) h512.set(resizePlane(healed.subarray(c * n, (c + 1) * n), pw, ph, 512, 512, false), c * 512 * 512);
  const mg = (await MotusModels.run('abpn_blend', { image: { type: 'float32', dims: [1, 3, 512, 512], data: h512 } })).blend.data;
  for (let i = 0; i < mg.length; i++) mg[i] = mg[i] < 0 ? 0 : mg[i] > 1 ? 1 : mg[i];

  // blemishes as separate spots, each classified so the sliders can pick acne, freckles or moles
  const comp = new Int32Array(n).fill(-1), spots = [], stack = [], FWp = Math.max(20, fw * s);
  for (let i = 0; i < n; i++) {
    if (!m[i] || comp[i] >= 0) continue;
    const id = spots.length; let area = 0, peak = 0, dr = 0, dg = 0, db = 0, wsum = 0; comp[i] = id; stack.push(i);
    while (stack.length) { const j = stack.pop(), jx = j % pw, jy = (j / pw) | 0; area++; peak = Math.max(peak, prob[j]);
      const a = m[j]; dr += (x[j] - healed[j]) * a; dg += (x[n + j] - healed[n + j]) * a; db += (x[2 * n + j] - healed[2 * n + j]) * a; wsum += a;
      for (const k of [jx > 0 ? j - 1 : -1, jx < pw - 1 ? j + 1 : -1, jy > 0 ? j - pw : -1, jy < ph - 1 ? j + pw : -1]) if (k >= 0 && m[k] && comp[k] < 0) { comp[k] = id; stack.push(k); } }
    dr /= 2 * wsum; dg /= 2 * wsum; db /= 2 * wsum;                       // mean (spot - healed) in 0..1 units
    const dark = -(.2126 * dr + .7152 * dg + .0722 * db), red = dr - (dg + db) / 2, diam = 2 * Math.sqrt(area / Math.PI) / FWp;
    const kind = dark > .08 && diam > .03 && red < .6 * dark ? 'mole' : red > .012 && red > .35 * dark ? 'acne' : 'freckle';
    spots.push({ peak, kind, diam, dark, red });
  }
  // only the change is stored (0..1 units)
  const delta = new Float32Array(3 * n);
  for (let i = 0; i < 3 * n; i++) delta[i] = (healed[i] - x[i]) / 2;
  return { x0, y0, s, pw, ph, delta, comp, spots, mg, W, H };
}

// the result for this image size, scaled from one computed at another size (same photo) if needed
function at(face, W, H) {
  const all = face.ai; if (!all) return undefined;
  const own = all[W + 'x' + H]; if (own !== undefined) return own;
  for (const [k0, e] of Object.entries(all)) {
    if (e === null) return null;
    if (!e.W) continue;
    const k = W / e.W; if (Math.abs(H / e.H - k) > .01) continue;
    return { ...e, x0: e.x0 * k, y0: e.y0 * k, s: e.s / k, W, H };
  }
  return undefined;
}
function key(photo, img) { return photo.id + '|' + img.width + 'x' + img.height; }
function cacheKey(img) { return img.width + 'x' + img.height; }
function ready(photo, img, analysis) { return analysis.faces.every(f => at(f, img.width, img.height) !== undefined); }
function busy(photo, img) { return jobs.has(key(photo, img)); }

// run all networks for every face of this image size; resolves when cached on the face objects
function prepare(photo, img, analysis, cap = 1024) {
  const k = key(photo, img); if (jobs.has(k)) return jobs.get(k);
  const src = img instanceof ImageData ? (() => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').putImageData(img, 0, 0); return c; })() : img;
  const p = (async () => {
    for (const f of analysis.faces) { f.ai = f.ai || {}; if (f.ai[cacheKey(img)] === undefined) f.ai[cacheKey(img)] = await faceJob(src, img.width, img.height, f, cap); }
  })().finally(() => jobs.delete(k));
  jobs.set(k, p); return p;
}
function drop(analysis, img) { for (const f of analysis.faces) if (f.ai) delete f.ai[cacheKey(img)]; }

return { prepare, ready, busy, drop, cacheKey, at };
})();
