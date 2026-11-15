/* Face analysis: YuNet detection + BiSeNet parsing, run in the model worker.
   Results are resolution-independent (normalized coordinates + a 512x512 label map per face),
   so one analysis of the preview serves both the preview and the full-resolution export. */
'use strict';

const MotusFaces = (() => {
  const cache = new Map();   // photoId -> Promise<analysis>
  const done = new Map();    // photoId -> analysis

  // CelebAMask-HQ labels
  const L = { skin: 1, lbrow: 2, rbrow: 3, leye: 4, reye: 5, glasses: 6, lear: 7, rear: 8, earring: 9, nose: 10, mouth: 11, ulip: 12, llip: 13, neck: 14, cloth: 16, hair: 17, hat: 18 };

  function toCanvas(img) {
    if (img instanceof ImageData) { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').putImageData(img, 0, 0); return c; }
    return img;
  }

  async function detect(src, W, H) {
    const S = 640, s = S / Math.max(W, H), c = document.createElement('canvas'); c.width = S; c.height = S;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
    ctx.drawImage(src, 0, 0, Math.round(W * s), Math.round(H * s));
    const d = ctx.getImageData(0, 0, S, S).data, x = new Float32Array(3 * S * S);
    for (let i = 0; i < S * S; i++) { x[i] = d[i * 4 + 2]; x[S * S + i] = d[i * 4 + 1]; x[2 * S * S + i] = d[i * 4]; }   // BGR, 0..255
    const out = await MotusModels.run('yunet', { input: { type: 'float32', dims: [1, 3, S, S], data: x } });
    const cand = [];
    for (const st of [8, 16, 32]) {
      const n = S / st, cls = out['cls_' + st].data, obj = out['obj_' + st].data, bb = out['bbox_' + st].data, kp = out['kps_' + st].data;
      for (let i = 0; i < n * n; i++) {
        const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
        if (score < .6) continue;
        const r = Math.floor(i / n), col = i % n, cx = (col + bb[i * 4]) * st, cy = (r + bb[i * 4 + 1]) * st, w = Math.exp(bb[i * 4 + 2]) * st, h = Math.exp(bb[i * 4 + 3]) * st;
        const kps = []; for (let k = 0; k < 5; k++) kps.push([(col + kp[i * 10 + k * 2]) * st / s / W, (r + kp[i * 10 + k * 2 + 1]) * st / s / H]);
        cand.push({ x: (cx - w / 2) / s / W, y: (cy - h / 2) / s / H, w: w / s / W, h: h / s / H, score, kps });
      }
    }
    cand.sort((a, b) => b.score - a.score);
    const iou = (a, b) => { const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * W, iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)) * H; const I = ix * iy; return I / (a.w * a.h * W * H + b.w * b.h * W * H - I); };
    const keep = []; for (const c of cand) if (keep.every(k => iou(k, c) < .3)) keep.push(c);
    return keep.filter(f => f.w * W > 24).sort((a, b) => a.x - b.x);  // left to right = Person 1, 2, ...
  }

  // square crop around the face (as the parser was trained), padded with black outside the photo
  async function parse(src, W, H, face) {
    const cx = (face.x + face.w / 2) * W, cy = (face.y + face.h / 2) * H, size = Math.max(face.w * W, face.h * H) * 1.9;
    const x0 = cx - size / 2, y0 = cy - size / 2.2;
    const S = 512, c = document.createElement('canvas'); c.width = S; c.height = S;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
    ctx.drawImage(src, x0, y0, size, size, 0, 0, S, S);
    const d = ctx.getImageData(0, 0, S, S).data, x = new Float32Array(3 * S * S), mean = [.485, .456, .406], std = [.229, .224, .225];
    for (let i = 0; i < S * S; i++) for (let k = 0; k < 3; k++) x[k * S * S + i] = (d[i * 4 + k] / 255 - mean[k]) / std[k];
    const out = await MotusModels.run('faceparse', { input: { type: 'float32', dims: [1, 3, S, S], data: x } }, ['output']);
    const logits = out.output.data, n = S * S, labels = new Uint8Array(n), best = new Float32Array(n).fill(-Infinity);
    const C = out.output.dims[1];
    for (let k = 0; k < C; k++) { const off = k * n; for (let i = 0; i < n; i++) { const v = logits[off + i]; if (v > best[i]) { best[i] = v; labels[i] = k; } } }
    return { crop: { x: x0 / W, y: y0 / H, size: size / W, sizeY: size / H }, labels, S };
  }

  async function run(photo, img) {
    const src = toCanvas(img), W = img.width, H = img.height;
    const faces = await detect(src, W, H);
    for (const f of faces) Object.assign(f, await parse(src, W, H, f));
    return { faces, w: W, h: H };
  }

  // analyze once per photo; resolves with {faces:[...]} ; notifies when finished
  function analyze(photo, img, onDone) {
    if (!cache.has(photo.id)) {
      const p = run(photo, img).then(a => { done.set(photo.id, a); onDone?.(a); return a; })
        .catch(e => { cache.delete(photo.id); console.error('Face analysis failed', e); throw e; });
      cache.set(photo.id, p);
    }
    return cache.get(photo.id);
  }
  const get = photo => done.get(photo.id) || null;
  const busy = photo => cache.has(photo.id) && !done.has(photo.id);
  function forget(photo) { cache.delete(photo.id); done.delete(photo.id); }

  return { analyze, get, busy, forget, L };
})();
