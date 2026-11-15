/* Model registry. Every model ships inside the app folder and is pinned to a SHA-256 here,
   so a swapped or corrupted file is refused. Add new models only with their license and source. */
'use strict';

const MotusModels = (() => {
const REGISTRY = {
  yunet: {
    file: 'models/face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    license: 'MIT', source: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet',
    purpose: 'Face detection'
  },
  faceparse: {
    file: 'models/face_parsing_bisenet_resnet18.onnx',
    sha256: '0d9bd318e46987c3bdbfacae9e2c0f461cae1c6ac6ea6d43bbe541a91727e33f',
    license: 'MIT code; weights trained on CelebAMask-HQ (non-commercial dataset)', source: 'https://github.com/yakhyo/face-parsing',
    purpose: 'Face parsing: skin, brows, eyes, glasses, nose, mouth, lips, hair'
  },
  motus_touch: {
    file: 'models/motus_touch.onnx',
    sha256: '3b4e59d07f3dee7532f71b76914a386a315039422ec4cf70100b24d572c70426',
    license: 'Non-commercial (trained on FFHQR/FFHQ, CC BY-NC-SA 4.0); network code Apache-2.0 (ABPN)', source: 'motus-train, trained on UVA CS GPU',
    purpose: 'Motus Touch'
  },
  abpn_detect: {
    file: 'models/abpn_detect_fp16.onnx',
    sha256: '5e54f4d76cb30277369a7b6d49dd87f8744b469539427fd341578fdba4876409',
    license: 'Apache-2.0', source: 'https://modelscope.cn/models/damo/cv_unet_skin-retouching',
    purpose: 'Blemish detection (ABPN)'
  },
  abpn_inpaint: {
    file: 'models/abpn_inpaint_fp16.onnx',
    sha256: '5612826f3a56d85a08fc1bec990510c23ffc789bf3e95aebb8f6ff7c445b38cf',
    license: 'Apache-2.0', source: 'https://modelscope.cn/models/damo/cv_unet_skin-retouching',
    purpose: 'Blemish healing (ABPN)'
  },
  abpn_blend: {
    file: 'models/abpn_blend_fp16.onnx',
    sha256: '086ca62b2cad5e4d1e486a776cdce6e97f1dd31bee381af867896d437fddae43',
    license: 'Apache-2.0', source: 'https://modelscope.cn/models/damo/cv_unet_skin-retouching',
    purpose: 'Skin evening blend layer (ABPN)'
  }
};

let worker = null, seq = 0;
const pending = new Map(), loaded = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker('engine/model-worker.js');
  worker.onmessage = ({ data }) => { const p = pending.get(data.id); if (!p) return; pending.delete(data.id); data.ok ? p.resolve(data.result) : p.reject(new Error(data.error)); };
  worker.onerror = e => { for (const p of pending.values()) p.reject(new Error(e.message || 'Model worker failed')); pending.clear(); };
  return worker;
}
function call(op, payload, transfer = []) {
  return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); getWorker().postMessage({ id, op, payload }, transfer); });
}
function load(name) {
  const m = REGISTRY[name]; if (!m) return Promise.reject(new Error(`Unknown model ${name}`));
  if (!loaded.has(name)) loaded.set(name, call('load', { name, url: new URL(m.file, location.href).href, sha256: m.sha256 }).catch(e => { loaded.delete(name); throw e; }));
  return loaded.get(name);
}
async function run(name, feeds, fetch = null) {
  await load(name);
  const transfer = Object.values(feeds).map(t => t.data?.buffer).filter(Boolean);
  return call('run', { name, feeds, fetch }, transfer);
}
// quick end-to-end check: load YuNet and run it on a blank frame
async function selfTest() {
  const info = await load('yunet');
  const out = await run('yunet', { input: { type: 'float32', dims: [1, 3, 640, 640], data: new Float32Array(3 * 640 * 640) } });
  return { backend: info.backend, outputs: Object.keys(out).length };
}

return { load, run, selfTest, registry: REGISTRY };
})();
