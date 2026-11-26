// DAWG HAUS service worker: caches the app so it opens offline.
// Bump VERSION whenever files change so users get the update.
const VERSION = 'dawghaus-v0.8.2';
const FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/timing.js', 'js/store.js', 'js/storage.js', 'js/project.js', 'js/midi.js',
  'js/audio/engine.js', 'js/audio/synth.js', 'js/audio/presets.js', 'js/audio/sampler.js', 'js/audio/growl.js', 'js/audio/drums.js', 'js/audio/effects.js', 'js/audio/worklets.js', 'js/audio/sampleinst.js', 'js/audio/audition.js', 'js/audio/bend.js', 'js/audio/analyze.js', 'js/ui/tuner.js', 'js/ui/chords.js', 'js/export.js', 'js/mp3worker.js', 'vendor/lame.min.js', 'js/automation.js',
  'js/ui/dom.js', 'js/ui/timeline.js', 'js/ui/tracks.js', 'js/ui/pianoroll.js', 'js/ui/dock.js', 'js/ui/drumeditor.js', 'js/ui/fxpanel.js', 'js/ui/autolanes.js', 'samples/index.json',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network first (so updates show up), falling back to the cache when offline.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html'))),
  );
});
