/* Right-click menu for photos (Library grid, filmstrip, Recent photos) with Open, Hide/Show and Delete.
   Deleting removes the photo and its edits from Motus-Touch only; the original file on the computer is never touched.
   Uses app.js globals at call time (photos, selected, active, screen, collection ...). */
'use strict';

const PhotoMenu = (() => {
  let menu = null, dialog = null;

  function targets(photo) {
    // right-clicking a photo that is part of a multi-selection acts on the whole selection
    if (selected.has(photo.id) && selected.size > 1) return photos.filter(p => selected.has(p.id));
    return [photo];
  }

  function close() { menu?.remove(); menu = null; }

  function item(label, onClick, extra = '') {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'photo-menu-item ' + extra; b.textContent = label;
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => { close(); onClick(); });
    return b;
  }

  function open(photo, x, y) {
    close();
    const list = targets(photo), many = list.length > 1;
    menu = document.createElement('div'); menu.className = 'photo-menu'; menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', many ? `${list.length} photos` : photo.name);
    const title = document.createElement('div'); title.className = 'photo-menu-title'; title.textContent = many ? `${list.length} photos selected` : photo.name;
    menu.append(title);
    if (!many) menu.append(item('Open in Studio', () => selectPhoto(photo)));
    const allHidden = list.every(p => p.hidden);
    menu.append(item(allHidden ? (many ? 'Show photos' : 'Show photo') : (many ? 'Hide photos' : 'Hide photo'), () => {
      for (const p of list) p.hidden = !allHidden;
      selected.clear(); refresh(); notify(allHidden ? 'Visible again.' : 'Hidden. Find it in Hidden items.');
    }));
    const allArchived = list.every(p => p.archived);
    menu.append(item(allArchived ? 'Move back to library' : (many ? 'Archive photos' : 'Archive photo'), () => LibraryExtras.setArchived(list, !allArchived)));
    const sep = document.createElement('div'); sep.className = 'photo-menu-sep'; menu.append(sep);
    menu.append(item(many ? `Delete ${list.length} photos…` : 'Delete photo…', () => confirmDelete(list), 'danger'));
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
    menu.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
    menu.querySelector('.photo-menu-item')?.focus();
  }

  function confirmDelete(list) {
    if (!dialog) {
      dialog = document.createElement('dialog'); dialog.id = 'delete-dialog';
      dialog.innerHTML = '<form method="dialog"><span class="eyebrow">DELETE</span><h2 id="delete-title"></h2>' +
        '<p class="delete-copy">They are removed from Motus-Touch along with their edits. The original files on your Mac are not touched.</p>' +
        '<div class="dialog-actions"><button type="button" class="secondary-button" value="cancel">Cancel</button>' +
        '<button type="submit" class="primary-button danger-button" value="delete">Delete</button></div></form>';
      dialog.querySelector('[value=cancel]').addEventListener('click', () => dialog.close('cancel'));
      dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close('cancel'); });
      document.body.append(dialog);
    }
    dialog.querySelector('#delete-title').textContent = list.length > 1 ? `Delete ${list.length} photos?` : `Delete “${list[0].name}”?`;
    dialog.querySelector('.delete-copy').textContent = list.length > 1
      ? 'They are removed from Motus-Touch along with their edits. The original files on your Mac are not touched.'
      : 'It is removed from Motus-Touch along with its edits. The original file on your Mac is not touched.';
    dialog.returnValue = '';
    dialog.onclose = () => { if (dialog.returnValue === 'delete') remove(list); };
    dialog.showModal();
    dialog.querySelector('[value=cancel]').focus();
  }

  function remove(list) {
    const ids = new Set(list.map(p => p.id));
    const wasActive = active && ids.has(active.id);
    let next = null;
    if (wasActive) { const pool = collectionPhotos(), i = pool.indexOf(active); next = pool.slice(i + 1).find(p => !ids.has(p.id)) || pool.slice(0, i).reverse().find(p => !ids.has(p.id)) || null; }
    for (const p of list) { if (p.url?.startsWith('blob:')) URL.revokeObjectURL(p.url); selected.delete(p.id); }
    photos = photos.filter(p => !ids.has(p.id));
    if (wasActive) { active = null; sourceImage = null; previewData = null; renderedData = null; }
    saveWorkspace();
    if (wasActive) { if (next) selectPhoto(next); else setScreen('library'); }
    refresh();
    notify(list.length > 1 ? `${list.length} photos deleted.` : `“${list[0].name}” deleted.`);
  }

  function refresh() {
    renderSidebar(); renderLibrary(); renderFilmstrip(); renderRecent();
    if (active) updateStatus();
  }

  document.addEventListener('contextmenu', e => {
    const el = e.target.closest('[data-photo-id]'); if (!el) return;
    const photo = photos.find(p => p.id === el.dataset.photoId); if (!photo) return;
    e.preventDefault(); open(photo, e.clientX, e.clientY);
  });
  document.addEventListener('pointerdown', e => { if (menu && !menu.contains(e.target)) close(); }, true);
  document.addEventListener('keydown', e => {
    if (menu && e.key === 'Escape') { close(); return; }
    // Delete / Backspace removes selected photos in the Library
    if ((e.key === 'Delete' || e.key === 'Backspace') && screen === 'library' && selected.size && !e.target.closest('input,textarea,select,[contenteditable]') && !document.querySelector('dialog[open]')) {
      e.preventDefault(); confirmDelete(photos.filter(p => selected.has(p.id)));
    }
  });
  addEventListener('blur', close); addEventListener('resize', close); document.addEventListener('scroll', close, true);

  return { open, confirmDelete };
})();
