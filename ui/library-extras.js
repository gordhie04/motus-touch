/* Library and Studio additions: Archive, deleting folders, the "+" tile in the grid,
   an import screen when Studio has no photo, renaming people, and hiding face boxes.
   Uses app.js globals at call time. */
'use strict';

const LibraryExtras = (() => {
  const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem('motus.' + k); localStorage.setItem('motus.' + k, v); } catch { return null; } };

  /* ---------- Archive ---------- */
  const isArchived = p => !!p.archived;
  function setArchived(list, value) {
    for (const p of list) { p.archived = value; selected.delete(p.id); }
    if (value && active && list.includes(active)) { const next = photos.find(p => !p.archived && !isHidden(p)); if (next) selectPhoto(next); else { active = null; setScreen('library'); } }
    saveWorkspace(); renderSidebar(); renderLibrary(); renderFilmstrip(); renderRecent();
    notify(value ? `${list.length > 1 ? list.length + ' photos' : '“' + list[0].name + '”'} archived. Find ${list.length > 1 ? 'them' : 'it'} in Archive.` : 'Moved back to your library.');
  }

  function sidebar() {
    let b = document.getElementById('archive-photos');
    if (!b) {
      b = makeButton('', 'side-nav', () => openCollection('archive')); b.id = 'archive-photos';
      b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18v4H3zM5 9v10h14V9M10 13h4"/></svg><span>Archive</span><b id="archive-count">0</b>';
      document.getElementById('hidden-photos').after(b);
    }
    b.classList.toggle('active', collection === 'archive');
    document.getElementById('archive-count').textContent = photos.filter(isArchived).length;
    document.getElementById('photo-count').textContent = photos.filter(p => !isHidden(p) && !isArchived(p)).length;
  }

  /* ---------- Folders: delete ---------- */
  let fmenu = null, fdialog = null;
  function closeMenu() { fmenu?.remove(); fmenu = null; }
  function folderMenu(folder, x, y) {
    closeMenu(); PhotoMenu && document.querySelector('.photo-menu')?.remove();
    fmenu = document.createElement('div'); fmenu.className = 'photo-menu'; fmenu.setAttribute('role', 'menu');
    const title = document.createElement('div'); title.className = 'photo-menu-title'; title.textContent = folder.name; fmenu.append(title);
    const item = (label, fn, extra = '') => { const b = document.createElement('button'); b.type = 'button'; b.className = 'photo-menu-item ' + extra; b.textContent = label; b.setAttribute('role', 'menuitem'); b.onclick = () => { closeMenu(); fn(); }; fmenu.append(b); };
    item('Open folder', () => openCollection(folder.id));
    item(folder.hidden ? 'Show folder' : 'Hide folder', () => toggleFolder(folder));
    const sep = document.createElement('div'); sep.className = 'photo-menu-sep'; fmenu.append(sep);
    item('Delete folder…', () => confirmFolderDelete(folder), 'danger');
    document.body.append(fmenu);
    const r = fmenu.getBoundingClientRect(); fmenu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px'; fmenu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
    fmenu.querySelector('.photo-menu-item')?.focus();
  }
  function confirmFolderDelete(folder) {
    const inside = photos.filter(p => p.folderId === folder.id);
    if (!fdialog) {
      fdialog = document.createElement('dialog'); fdialog.id = 'folder-delete-dialog';
      fdialog.innerHTML = '<form method="dialog"><span class="eyebrow">DELETE FOLDER</span><h2 class="fd-title"></h2><p class="delete-copy fd-copy"></p>' +
        '<div class="dialog-actions"><button type="button" class="secondary-button" value="cancel">Cancel</button>' +
        '<button type="submit" class="secondary-button fd-keep" value="keep">Delete folder, keep photos</button>' +
        '<button type="submit" class="primary-button danger-button fd-all" value="all">Delete folder and photos</button></div></form>';
      fdialog.querySelector('[value=cancel]').onclick = () => fdialog.close('cancel');
      fdialog.addEventListener('click', e => { if (e.target === fdialog) fdialog.close('cancel'); });
      document.body.append(fdialog);
    }
    fdialog.querySelector('.fd-title').textContent = `Delete “${folder.name}”?`;
    fdialog.querySelector('.fd-copy').textContent = inside.length
      ? `It holds ${inside.length} photo${inside.length > 1 ? 's' : ''}. Keep them (they move to All photos) or delete them from Motus-Touch too. Original files on your Mac are never touched.`
      : 'The folder is empty.';
    fdialog.querySelector('.fd-all').classList.toggle('hidden', !inside.length);
    fdialog.querySelector('.fd-keep').textContent = inside.length ? 'Delete folder, keep photos' : 'Delete folder';
    fdialog.returnValue = '';
    fdialog.onclose = () => {
      const v = fdialog.returnValue; if (v !== 'keep' && v !== 'all') return;
      if (v === 'all') { const ids = new Set(inside.map(p => p.id)); for (const p of inside) forgetPhoto(p);
        photos = photos.filter(p => !ids.has(p.id)); if (active && ids.has(active.id)) { active = null; sourceImage = null; previewData = null; renderedData = null; } }
      else for (const p of inside) p.folderId = null;
      folders = folders.filter(f => f.id !== folder.id);
      if (collection === folder.id) collection = 'all';
      saveWorkspace(); renderSidebar(); renderFolderOptions(); if (screen === 'library') renderLibrary(); else if (!active) setScreen('library'); renderFilmstrip(); renderRecent();
      notify(v === 'all' ? `Folder and ${inside.length} photo${inside.length > 1 ? 's' : ''} deleted.` : `Folder “${folder.name}” deleted.${inside.length ? ' Its photos are in All photos.' : ''}`);
    };
    fdialog.showModal(); fdialog.querySelector('[value=cancel]').focus();
  }
  function folderHeaderButton() {
    let b = document.getElementById('library-delete-folder');
    if (!b) { b = makeButton('', 'secondary-button', () => { const f = folders.find(f => f.id === collection); if (f) confirmFolderDelete(f); });
      b.id = 'library-delete-folder'; b.textContent = 'Delete folder'; document.getElementById('library-new-folder').before(b); }
    b.classList.toggle('hidden', !folders.some(f => f.id === collection));
  }

  /* ---------- "+" tile in the photo grid ---------- */
  function addTile() {
    const grid = document.getElementById('photo-grid');
    if (collection === 'hidden' || collection === 'archive' || !grid.children.length && !collectionPhotos().length) return;
    const t = makeButton('', 'photo-card add-photo-card', () => document.getElementById('file-input').click());
    t.innerHTML = '<span class="add-photo-plus"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></span><span class="add-photo-label">Add photos</span>';
    t.setAttribute('aria-label', 'Import photos');
    grid.prepend(t);
  }

  /* ---------- Studio with no photo ---------- */
  function studioEmpty(show) {
    let e = document.getElementById('studio-empty');
    if (!e) {
      e = document.createElement('div'); e.id = 'studio-empty'; e.className = 'studio-empty hidden';
      e.innerHTML = '<div class="studio-empty-card"><span class="add-photo-plus"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></span><h2>Start with a photo</h2><p>Import one to begin editing. It stays on your Mac.</p>' +
        '<div class="studio-empty-actions"><button type="button" class="primary-button" id="studio-empty-import">Import photos</button><button type="button" class="secondary-button" id="studio-empty-sample">Try the sample</button></div></div>';
      document.getElementById('stage').append(e);
      e.querySelector('#studio-empty-import').onclick = () => document.getElementById('file-input').click();
      e.querySelector('#studio-empty-sample').onclick = () => selectPhoto(ensureDemo());
      e.addEventListener('dragover', ev => ev.preventDefault());
      e.addEventListener('drop', ev => { ev.preventDefault(); if (ev.dataTransfer?.files?.length) importFiles(ev.dataTransfer.files); });
    }
    e.classList.toggle('hidden', !show);
    if (show) { document.getElementById('breadcrumb-photo').textContent = 'No photo'; }
    document.getElementById('editor-screen').classList.toggle('studio-has-no-photo', !!show);
  }
  function openStudio() {
    const photo = active || photos.find(p => !isHidden(p) && !isArchived(p));
    if (photo) return selectPhoto(photo);
    setScreen('editor'); studioEmpty(true);
  }
  function onScreen(next) { studioEmpty(next === 'editor' && !active); }

  /* ---------- people: names + face box toggle ---------- */
  const personLabel = t => { const m = /^Person (\d+)$/.exec(t); return m && active?.personNames?.[m[1]] || (t === 'All people' ? 'All' : t); };
  // rename in place, like a file name: the chip (or face box label) itself becomes the text field
  function rename(target, anchor) {
    const m = /^Person (\d+)$/.exec(target); if (!m || !active) return;
    // the first click of a double-click re-draws the chips and boxes, so find the element that is on screen now
    const onBox = !!anchor.closest('.face-box');
    const el = anchor.isConnected ? anchor : onBox ? document.querySelector(`.face-box[data-person="${target}"] span`) : document.querySelector(`#target-chips button[aria-label="Target: ${target}"]`);
    if (!el || el.querySelector('.person-rename')) return;
    const input = document.createElement('input'); input.type = 'text'; input.className = 'person-rename'; input.maxLength = 30;
    input.value = active.personNames?.[m[1]] || ''; input.placeholder = target; input.setAttribute('aria-label', `Name for ${target}`);
    input.style.width = Math.max(64, el.getBoundingClientRect().width - 8) + 'px';
    el.classList.add('renaming'); el.textContent = ''; el.append(input); input.focus(); input.select();
    let done = false;
    const finish = save => { if (done) return; done = true; if (save) { const v = input.value.trim(); active.personNames = { ...(active.personNames || {}) }; if (v) active.personNames[m[1]] = v; else delete active.personNames[m[1]]; saveSoon(); }
      buildPanel(); };
    for (const ev of ['click', 'mousedown', 'dblclick', 'keyup']) input.addEventListener(ev, e => e.stopPropagation());
    input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
  }
  function decorateChips() {
    for (const b of document.querySelectorAll('#target-chips button')) {
      const t = (b.getAttribute('aria-label') || '').replace(/^Target: /, '');
      if (/^Person \d+$/.test(t)) { b.textContent = personLabel(t); b.title = 'Double-click to rename'; b.ondblclick = e => { e.preventDefault(); rename(t, b); }; }
    }
  }
  const boxesHidden = () => pref('faceBoxesHidden') === '1';
  function faceToggle(hasFaces) {
    let b = document.getElementById('face-box-toggle');
    if (!b) {
      b = makeButton('', 'face-box-toggle', () => { pref('faceBoxesHidden', boxesHidden() ? '0' : '1'); applyBoxes(); });
      b.id = 'face-box-toggle';
    }
    // lives on the person row in the portrait panel; falls back to the image overlay
    const host = document.getElementById('target-chips');
    if (host) host.append(b); else document.getElementById('original-button')?.before(b);
    b.classList.toggle('hidden', !hasFaces);
    applyBoxes();
  }
  function applyBoxes() {
    const hidden = boxesHidden(), b = document.getElementById('face-box-toggle');
    document.getElementById('image-frame')?.classList.toggle('face-boxes-hidden', hidden);
    if (b) { b.innerHTML = icon(hidden ? 'eyeoff' : 'eye') + (hidden ? ' Show face boxes' : ' Hide face boxes'); b.setAttribute('aria-pressed', String(hidden)); }
  }

  /* ---------- right-click on folders ---------- */
  document.addEventListener('contextmenu', e => {
    const el = e.target.closest('[data-folder-id]'); if (!el || e.target.closest('[data-photo-id]')) return;
    const f = folders.find(f => f.id === el.dataset.folderId); if (!f) return;
    e.preventDefault(); folderMenu(f, e.clientX, e.clientY);
  });
  document.addEventListener('pointerdown', e => { if (fmenu && !fmenu.contains(e.target)) closeMenu(); }, true);
  document.addEventListener('keydown', e => { if (fmenu && e.key === 'Escape') closeMenu(); });

  return { isArchived, setArchived, sidebar, folderHeaderButton, addTile, openStudio, onScreen, studioEmpty, personLabel, decorateChips, faceToggle, rename, boxesHidden };
})();
