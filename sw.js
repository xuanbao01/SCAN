// 离线缓存 + 跨源隔离头（让识别可用多线程）
const CACHE = 'scanquiz-v1';
const ASSETS = [
  './', 'index.html', 'app.js', 'ocr.js', 'bank.js', 'manifest.webmanifest', 'icon-180.png', 'icon-512.png',
  'vendor/ort.wasm.min.js', 'vendor/ort-wasm-simd-threaded.mjs', 'vendor/ort-wasm-simd-threaded.wasm', 'vendor/xlsx.full.min.js',
  'models/det.onnx', 'models/rec.onnx', 'models/keys.txt',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function withHeaders(r) {
  if (!r || r.status === 0 || r.type === 'opaque') return r;
  const h = new Headers(r.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = req.mode === 'navigate' ? 'index.html' : req;
    let r = await cache.match(key, { ignoreSearch: true });
    if (!r) {
      try { r = await fetch(req); if (r.ok && req.mode !== 'navigate') cache.put(req, r.clone()); }
      catch (err) { r = await cache.match('index.html'); }
    }
    return withHeaders(r);
  })());
});
