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

  /* Partial faces (profiles, cropped close-ups) are missed by the detector. Fallback: parse the whole photo
     and, if a large enough face region shows up (skin with nose or lips), use its outline as the face. */
  async function partial(src, W, H) {
    const size = Math.max(W, H);
    // parse() crops 1.9x the box around its centre; give it a box whose crop is the whole photo
    const b = size / 1.9, cy = H / 2 - size / 2 + size / 2.2, box = { x: (W / 2 - b / 2) / W, y: (cy - b / 2) / H, w: b / W, h: b / H };
    const p = await parse(src, W, H, box), S = p.S, lab = p.labels;
    const FACE = new Set([L.skin, L.nose, L.ulip, L.llip, L.mouth, L.leye, L.reye, L.lbrow, L.rbrow]);
    // largest connected face region
    const seen = new Uint8Array(S * S); let best = null;
    for (let i = 0; i < S * S; i++) {
      if (seen[i] || !FACE.has(lab[i])) continue;
      const st = [i], px = []; seen[i] = 1;
      while (st.length) { const j = st.pop(), x = j % S, y = (j / S) | 0; px.push(j);
        for (const k of [x > 0 ? j - 1 : -1, x < S - 1 ? j + 1 : -1, y > 0 ? j - S : -1, y < S - 1 ? j + S : -1]) if (k >= 0 && !seen[k] && FACE.has(lab[k])) { seen[k] = 1; st.push(k); } }
      if (!best || px.length > best.length) best = px;
    }
    if (!best || best.length < S * S * .03) return null;
    let x0 = S, y0 = S, x1 = 0, y1 = 0; const cen = {}, ext = {};
    for (const j of best) { const x = j % S, y = (j / S) | 0, l = lab[j];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      (cen[l] = cen[l] || [0, 0, 0]); cen[l][0] += x; cen[l][1] += y; cen[l][2]++; }
    const has = l => cen[l] && cen[l][2] > 20, at = l => [cen[l][0] / cen[l][2], cen[l][1] / cen[l][2]];
    if (!has(L.nose) && !has(L.ulip) && !has(L.llip)) return null;           // skin alone could be an arm or a back
    const toImg = ([x, y]) => [(p.crop.x * W + (x + .5) / S * p.crop.size * W) / W, (p.crop.y * H + (y + .5) / S * p.crop.size * W) / H];
    const bw = x1 - x0, bh = y1 - y0, pt = (fx, fy) => [x0 + bw * fx, y0 + bh * fy];
    const eyeL = has(L.leye) ? at(L.leye) : has(L.reye) ? at(L.reye) : pt(.32, .38), eyeR = has(L.reye) ? at(L.reye) : has(L.leye) ? at(L.leye) : pt(.68, .38);
    const nose = has(L.nose) ? at(L.nose) : pt(.5, .58), mouth = has(L.ulip) ? at(L.ulip) : has(L.llip) ? at(L.llip) : pt(.5, .75);
    const kps = [eyeL, eyeR, nose, [mouth[0] - bw * .08, mouth[1]], [mouth[0] + bw * .08, mouth[1]]].map(toImg);
    const [ax, ay] = toImg([x0, y0]), [bx, by] = toImg([x1, y1]);
    return { x: ax, y: ay, w: bx - ax, h: by - ay, score: .5, kps, partial: true };
  }

  /* Hair mask from the MediaPipe multiclass segmenter (class 1 = hair) on a tall crop around each head, so long hair is covered.
     BiSeNet's hair label stops at the edge of its face crop and often marks dark background, leaves or hands as hair.
     Stored as a 256x256 probability grid in normalized coordinates, like the face labels. */
  async function hairSeg(src, W, H, f) {
    const fw = f.w * W, fh = f.h * H, cx = (f.x + f.w / 2) * W, cy = (f.y + f.h / 2) * H;
    const cw = fw * 4.2, ch = fh * 5.5, x0 = cx - cw / 2, y0 = cy - fh * 1.6, S = 256;
    const c = document.createElement('canvas'); c.width = S; c.height = S;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
    ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, x0, y0, cw, ch, 0, 0, S, S);
    const d = ctx.getImageData(0, 0, S, S).data, x = new Float32Array(S * S * 3);
    for (let i = 0; i < S * S; i++) { x[i * 3] = d[i * 4] / 255; x[i * 3 + 1] = d[i * 4 + 1] / 255; x[i * 3 + 2] = d[i * 4 + 2] / 255; }   // NHWC RGB 0..1
    const out = await MotusModels.run('hairseg', { input_29: { type: 'float32', dims: [1, S, S, 3], data: x } });
    const o = Object.values(out)[0].data, K = 6, p = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) { let m = -Infinity; for (let k = 0; k < K; k++) m = Math.max(m, o[i * K + k]);
      let sum = 0; for (let k = 0; k < K; k++) sum += Math.exp(o[i * K + k] - m); p[i] = Math.exp(o[i * K + 1] - m) / sum; }
    return { x: x0 / W, y: y0 / H, w: cw / W, h: ch / H, S, p };
  }
  // fallback if the segmenter can't run: BiSeNet's own hair label
  function parseHair(f) { const n = f.S * f.S, p = new Float32Array(n); for (let i = 0; i < n; i++) p[i] = f.labels[i] === L.hair ? 1 : 0;
    return { x: f.crop.x, y: f.crop.y, w: f.crop.size, h: f.crop.sizeY, S: f.S, p }; }
  /* Keep only hair attached to this person's head, and where two people's hair touches, give each cell to the nearer face
     (distance in units of each face's width, vertical counted less so long hair stays with its head). */
  function ownHair(faces, k, W, H) {
    const f = faces[k], g = f.hair, S = g.S, p = g.p, n = S * S;
    const at = i => [(g.x + ((i % S) + .5) / S * g.w) * W, (g.y + (((i / S) | 0) + .5) / S * g.h) * H];
    const fx = (f.x + f.w / 2) * W, fy = (f.y + f.h / 2 - f.h * .15) * H, rx = f.w * W * .9, ry = f.h * H;
    const reach = new Uint8Array(n), st = [];
    for (let i = 0; i < n; i++) { if (p[i] <= .5) continue; const [x, y] = at(i); if (((x - fx) / rx) ** 2 + ((y - fy) / ry) ** 2 <= 1) { reach[i] = 1; st.push(i); } }
    while (st.length) { const j = st.pop(), x = j % S, y = (j / S) | 0;
      for (const q of [x > 0 ? j - 1 : -1, x < S - 1 ? j + 1 : -1, y > 0 ? j - S : -1, y < S - 1 ? j + S : -1]) if (q >= 0 && !reach[q] && p[q] > .5) { reach[q] = 1; st.push(q); } }
    const near = new Uint8Array(n);   // one cell of margin so the soft edge survives
    for (let i = 0; i < n; i++) if (reach[i]) { const x = i % S, y = (i / S) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const a = x + dx, b = y + dy; if (a >= 0 && b >= 0 && a < S && b < S) near[b * S + a] = 1; } }
    const cen = faces.map(o => [(o.x + o.w / 2) * W, (o.y + o.h / 2) * H, o.w * W]);
    for (let i = 0; i < n; i++) { if (!near[i]) { p[i] = 0; continue; } if (faces.length < 2) continue;
      const [x, y] = at(i); let best = 0, bd = Infinity; cen.forEach(([cx, cy, w], j) => { const dd = Math.hypot(x - cx, (y - cy) * .6) / w; if (dd < bd) { bd = dd; best = j; } });
      if (best !== k) p[i] = 0; }
  }

  async function run(photo, img) {
    const src = toCanvas(img), W = img.width, H = img.height;
    const faces = await detect(src, W, H);
    if (!faces.length) { const f = await partial(src, W, H); if (f) faces.push(f); }
    for (const f of faces) Object.assign(f, await parse(src, W, H, f));
    for (const f of faces) { try { f.hair = await hairSeg(src, W, H, f); } catch (e) { console.warn('Hair segmenter failed; using face parsing hair', e); f.hair = parseHair(f); } }
    faces.forEach((f, k) => ownHair(faces, k, W, H));
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
