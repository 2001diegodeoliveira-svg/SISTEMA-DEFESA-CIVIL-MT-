/* SGI PROTEGE — service worker (Fase 5: Web Push; Fase 7: resiliência).
   Escopo: raiz (servido por rota explícita em server.js).
   Estratégia:
     - /api/* : network-first, com fallback para o cache (dado antigo
       em queda de rede; a UI sinaliza X-Stale/erro).
     - estáticos mesma origem: cache-first (app shell), atualizados
       em segundo plano a cada deploy (CACHE bump).
   NUNCA cacheia POST nem o que não for GET mesma origem. */
var CACHE = 'sgi-v1';
var SHELL = [
  '/',
  '/mapa.html',
  '/index.html',
  '/css/animated-icons.css',
  '/js/demo.js',
  '/js/protecao.js',
  '/js/data.js',
  '/js/proxy.js',
  '/js/organizacao.js',
  '/js/api.js',
  '/js/session.js',
  '/js/monitor.js',
  '/js/saude.js',
  '/imagens/logo.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL).catch(() => null))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(chaves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).then((res) => {
        var copia = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copia)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((hit) => {
        if (hit) return hit;
        return new Response(JSON.stringify({ erro: 'Sem conexão.' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }))
    );
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      var copia = res.clone();
      caches.open(CACHE).then((cache) => cache.put(req, copia)).catch(() => {});
      return res;
    }).catch(() => caches.match('/mapa.html')))
  );
});

self.addEventListener('push', (event) => {
  let dados = {};
  try {
    dados = event.data ? event.data.json() : {};
  } catch (e) {
    dados = { title: 'SGI PROTEGE', body: (event.data && event.data.text()) || '' };
  }
  const titulo = dados.title || 'SGI PROTEGE — alerta';
  const opcoes = {
    body: dados.body || '',
    icon: '/imagens/logo.png',
    badge: '/imagens/logo.png',
    tag: dados.tag || 'sgi-alerta',
    data: { url: dados.url || '/mapa.html' },
  };
  event.waitUntil(self.registration.showNotification(titulo, opcoes));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/mapa.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
      for (const j of janelas) {
        if (j.url.includes('/mapa.html')) return j.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
