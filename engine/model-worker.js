/* Runs AI models off the main thread so the interface never freezes.
   Loads only files from this app's own folder, and refuses any model whose SHA-256 doesn't match. */
'use strict';
importScripts('../vendor/onnxruntime-web/ort.webgpu.min.js');

ort.env.wasm.wasmPaths = new URL('../vendor/onnxruntime-web/', self.location.href).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
ort.env.logLevel = 'error';

const sessions = new Map();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

async function hasWebGPU() {
  try { return !!(self.navigator.gpu && await self.navigator.gpu.requestAdapter()); } catch { return false; }
}

async function load({ name, url, sha256 }) {
  if (sessions.has(name)) return sessions.get(name).info;
  const target = new URL(url, self.location.href);
  if (target.origin !== self.location.origin) throw new Error('Models must be local files.');
  const res = await fetch(target, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Model file missing: ${target.pathname}`);
  const buf = await res.arrayBuffer();
  const digest = hex(await crypto.subtle.digest('SHA-256', buf));
  if (digest !== sha256) throw new Error(`Model ${name} failed its integrity check and was not loaded.`);
  const gpu = await hasWebGPU();
  let session, backend;
  for (const ep of gpu ? ['webgpu', 'wasm'] : ['wasm']) {
    try { session = await ort.InferenceSession.create(buf, { executionProviders: [ep], graphOptimizationLevel: 'all' }); backend = ep; break; }
    catch (e) { if (ep === 'wasm') throw e; }
  }
  const info = { inputs: session.inputNames, outputs: session.outputNames, backend, bytes: buf.byteLength };
  sessions.set(name, { session, info });
  return info;
}

async function run({ name, feeds, fetch }) {
  const s = sessions.get(name); if (!s) throw new Error(`Model ${name} is not loaded.`);
  const input = {};
  for (const [k, t] of Object.entries(feeds)) input[k] = new ort.Tensor(t.type, t.data, t.dims);
  const out = await (fetch ? s.session.run(input, fetch) : s.session.run(input)), result = {}, transfer = [];
  for (const [k, t] of Object.entries(out)) {
    const data = t.location === 'gpu-buffer' ? await t.getData() : t.data;
    result[k] = { type: t.type, dims: t.dims, data }; if (data?.buffer) transfer.push(data.buffer);
  }
  return { result, transfer };
}

self.onmessage = async ({ data }) => {
  const { id, op, payload } = data;
  try {
    if (op === 'load') self.postMessage({ id, ok: true, result: await load(payload) });
    else if (op === 'run') { const { result, transfer } = await run(payload); self.postMessage({ id, ok: true, result }, transfer); }
    else if (op === 'unload') { await sessions.get(payload.name)?.session.release(); sessions.delete(payload.name); self.postMessage({ id, ok: true, result: true }); }
    else throw new Error('Unknown operation');
  } catch (e) { self.postMessage({ id, ok: false, error: e.message || String(e) }); }
};
