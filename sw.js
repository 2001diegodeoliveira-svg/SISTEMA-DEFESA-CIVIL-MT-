/* SGI PROTEGE — service worker mínimo (Fase 5: Web Push).
   Escopo: raiz (servido por rota explícita em server.js).
   Sem cache offline nesta fase (isso é Fase 7). */
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
