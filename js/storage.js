// Local project storage (IndexedDB). Everything stays on this device.
const DB_NAME = 'bendawmin'; // original name kept so songs made in earlier versions stay
const STORE = 'projects';
const AUDIO = 'audio'; // recorded audio: { id, sampleRate, data: Float32Array }

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(AUDIO)) db.createObjectStore(AUDIO, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn, storeName = STORE) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
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

// ---------- recorded audio ----------
export async function saveAudio(rec) {
  await tx('readwrite', (s) => reqP(s.put(rec)), AUDIO);
}
export async function loadAudio(id) {
  return tx('readonly', (s) => reqP(s.get(id)), AUDIO);
}

/** Every audio id a project uses (audio clips + sampler instruments). */
export function audioIdsOf(project) {
  const ids = new Set();
  for (const t of project.tracks || []) {
    for (const c of t.clips || []) if (c.audioId) ids.add(c.audioId);
    if (t.sampler?.audioId) ids.add(t.sampler.audioId);
  }
  return [...ids];
}

function f32ToB64(f32) {
  // 16-bit PCM keeps backups small
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767)));
  const bytes = new Uint8Array(i16.buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64ToF32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const i16 = new Int16Array(bytes.buffer);
  const f32 = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32767;
  return f32;
}

/** Save audio that came inside a backup file. */
export async function importEmbeddedAudio(data) {
  for (const a of data.__audio || []) await saveAudio({ id: a.id, sampleRate: a.sampleRate, data: b64ToF32(a.pcm) });
  delete data.__audio;
}

/** Download the project as a .dawghaus file (to move between computers). Recordings are included. */
export async function exportProjectFile(project) {
  const out = JSON.parse(JSON.stringify(project));
  out.__audio = [];
  for (const id of audioIdsOf(project)) {
    const a = await loadAudio(id);
    if (a) out.__audio.push({ id, sampleRate: a.sampleRate, pcm: f32ToB64(a.data) });
  }
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(project.name || 'song').replace(/[^\w\- ]+/g, '').trim() || 'song'}.dawghaus`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

export function pickProjectFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.dawghaus,.bendawmin,.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      try { resolve(JSON.parse(await f.text())); } catch (e) { reject(new Error('That file is not a DAWG HAUS song.')); }
    };
    input.click();
  });
}
