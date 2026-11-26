// Central state with undo/redo and debounced autosave.
import { applyAutoLabels } from './project.js';
import { saveProject } from './storage.js';

const MAX_HISTORY = 150;

export class Store {
  constructor(project) {
    this.project = project;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.lastMerge = null;
    this.saveTimer = null;
    this.saveStatus = 'saved';
    // UI state that is not part of the song
    this.ui = {
      selectedTrackId: project.tracks[0]?.id || null,
      selectedClipId: null,
      selectedClipIds: [], // extra clips picked with Ctrl+Shift-click (includes selectedClipId when active)
      snap: 'beat',
      pxPerQuarter: 48,
      mixerOpen: false,
      octave: 4,
      kbVelocity: 100,
    };
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  emit(kind) { for (const fn of this.listeners) fn(kind); }

  /**
   * Change the project. fn mutates the project in place.
   * opts.merge: key; consecutive changes with the same key within 1.2s become one undo step.
   * opts.silent: skip full UI re-render (used while dragging sliders).
   */
  mutate(fn, opts = {}) {
    const now = performance.now();
    const merging = opts.merge && this.lastMerge && this.lastMerge.key === opts.merge && now - this.lastMerge.time < 1200;
    if (!merging) {
      this.undoStack.push(JSON.stringify(this.project));
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
    }
    this.lastMerge = opts.merge ? { key: opts.merge, time: now } : null;
    fn(this.project);
    applyAutoLabels(this.project);
    this.scheduleSave();
    this.emit(opts.silent ? 'silent' : 'project');
  }

  /** Replace the whole project (open / new / import). Clears history. */
  load(project) {
    this.project = project;
    applyAutoLabels(project);
    this.undoStack = [];
    this.redoStack = [];
    this.ui.selectedTrackId = project.tracks[0]?.id || null;
    this.ui.selectedClipId = null;
    this.emit('load');
    this.saveNow();
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(this.undoStack.pop());
    this.lastMerge = null;
    this.fixSelection();
    this.scheduleSave();
    this.emit('project');
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.project));
    this.project = JSON.parse(this.redoStack.pop());
    this.lastMerge = null;
    this.fixSelection();
    this.scheduleSave();
    this.emit('project');
  }

  /** Ids of every selected clip (one, or several picked with Ctrl+Shift-click). */
  clipSelection() {
    const primary = this.ui.selectedClipId;
    if (!primary) return [];
    const ids = this.ui.selectedClipIds || [];
    const exists = (id) => this.project.tracks.some((t) => t.clips.some((c) => c.id === id));
    return ids.includes(primary) ? ids.filter(exists) : [primary];
  }

  isClipSelected(id) { return !!id && this.clipSelection().includes(id); }

  fixSelection() {
    const p = this.project;
    if (!p.tracks.find((t) => t.id === this.ui.selectedTrackId)) this.ui.selectedTrackId = p.tracks[0]?.id || null;
    if (!p.tracks.some((t) => t.clips.some((c) => c.id === this.ui.selectedClipId))) this.ui.selectedClipId = null;
  }

  setUI(patch) {
    // picking a single track elsewhere (lane, mixer) ends a multi-selection
    if (patch.selectedTrackId && !patch.selectedTrackIds) patch = { ...patch, selectedTrackIds: [patch.selectedTrackId] };
    Object.assign(this.ui, patch);
    this.emit('ui');
  }

  track(id) { return this.project.tracks.find((t) => t.id === id); }
  selectedTrack() { return this.track(this.ui.selectedTrackId); }

  findClip(clipId) {
    for (const t of this.project.tracks) {
      const c = t.clips.find((x) => x.id === clipId);
      if (c) return { track: t, clip: c };
    }
    return null;
  }

  scheduleSave() {
    this.saveStatus = 'unsaved';
    this.emit('save');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 800);
  }

  async saveNow() {
    clearTimeout(this.saveTimer);
    try {
      this.saveStatus = 'saving';
      this.emit('save');
      this.project.modified = await saveProject(this.project);
      this.saveStatus = 'saved';
    } catch (e) {
      console.error(e);
      this.saveStatus = 'error';
    }
    this.emit('save');
  }
}
