// Local project storage (IndexedDB). Everything stays on this device.
const DB_NAME = 'bendawmin';
const STORE = 'projects';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveProject(project) {
  const copy = JSON.parse(JSON.stringify(project));
  copy.modified = Date.now();
  await tx('readwrite', (s) => reqP(s.put(copy)));
  localStorage.setItem('bendawmin:last', project.id);
  return copy.modified;
}

export async function loadProject(id) {
  return tx('readonly', (s) => reqP(s.get(id)));
}

export async function deleteProject(id) {
  return tx('readwrite', (s) => reqP(s.delete(id)));
}

export async function listProjects() {
  const all = await tx('readonly', (s) => reqP(s.getAll()));
  return (all || [])
    .map((p) => ({ id: p.id, name: p.name, modified: p.modified, tracks: p.tracks?.length || 0 }))
    .sort((a, b) => b.modified - a.modified);
}

export function lastProjectId() {
  try { return localStorage.getItem('bendawmin:last'); } catch { return null; }
}

/** Download the project as a .bendawmin file (to move between computers). */
export function exportProjectFile(project) {
  const blob = new Blob([JSON.stringify(project, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(project.name || 'song').replace(/[^\w\- ]+/g, '').trim() || 'song'}.bendawmin`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function pickProjectFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.bendawmin,.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      try { resolve(JSON.parse(await f.text())); } catch (e) { reject(new Error('That file is not a benDAWmin project.')); }
    };
    input.click();
  });
}
