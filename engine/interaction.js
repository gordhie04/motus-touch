/* Fast dragging: while a slider or curve is being dragged, render from a lighter copy (2048 px),
   then redraw once at full preview resolution when the drag stops. Uses app.js globals at call time. */
'use strict';
const Interaction = (() => {
  const DRAFT = 2048, IDLE = 220;
  let dragging = false, lastInput = 0, finalTimer = 0, lastWasDraft = false;
  function makeDraft(canvas, w, h) {
    const k = DRAFT / Math.max(w, h); if (k >= .8) return null;            // already small: no draft needed
    const c = document.createElement('canvas'); c.width = Math.round(w * k); c.height = Math.round(h * k);
    const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.drawImage(canvas, 0, 0, c.width, c.height);
    return g.getImageData(0, 0, c.width, c.height);
  }
  const busy = () => dragging || performance.now() - lastInput < IDLE;
  function pick(full, draft) {
    if (draft && busy()) {
      lastWasDraft = true; clearTimeout(finalTimer);
      finalTimer = setTimeout(function again() { if (busy()) finalTimer = setTimeout(again, IDLE); else scheduleRender(); }, IDLE);
      return draft;
    }
    lastWasDraft = false; return full;
  }
  const isControl = t => t && (t.matches?.('input[type=range]') || t.closest?.('.engine-curve, .slider, [role=slider]'));
  document.addEventListener('pointerdown', e => { if (isControl(e.target)) { dragging = true; lastInput = performance.now(); } }, true);
  const up = () => { if (dragging) { dragging = false; lastInput = 0; scheduleRender(); } };
  document.addEventListener('pointerup', up, true); document.addEventListener('pointercancel', up, true);
  document.addEventListener('input', e => { if (isControl(e.target)) lastInput = performance.now(); }, true);
  document.addEventListener('keydown', e => { if (isControl(e.target)) lastInput = performance.now(); }, true);
  return { makeDraft, pick, get draft() { return lastWasDraft; } };
})();
