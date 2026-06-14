/* Firebase Cloud Messaging background handler */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

/* La config viene usata solo per ricevere push in background */
try {
  firebase.initializeApp({
    apiKey:            "AIzaSyBRpSLDgJmiOVEhQQoqBlJ8yDYq2WDawww",
    authDomain:        "italquake.firebaseapp.com",
    projectId:         "italquake",
    storageBucket:     "italquake.firebasestorage.app",
    messagingSenderId: "456621086487",
    appId:             "1:456621086487:web:1df98fb06d9e4bada20952"
  });
  const messaging = firebase.messaging();
  messaging.onBackgroundMessage(payload => {
    const n = payload.notification || {};
    const d = payload.data || {};
    self.registration.showNotification(n.title || '🔴 Nuovo terremoto', {
      body: n.body || '',
      icon: './icon-192.png',
      tag: d.eventId || 'itq_push_' + Date.now(),
      data: { url: d.url || './' }
    });
  });
} catch(e) { /* Firebase non configurato */ }

/* Click su notifica → apri l'app */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url ? e.notification.data.url : './';
  e.waitUntil(clients.matchAll({type:'window'}).then(ws => {
    for(const w of ws) if(w.url.includes('italquake')&&'focus'in w) return w.focus();
    return clients.openWindow(url);
  }));
});

/* Incrementa questa stringa ad ogni nuova versione pubblicata:
   è il modo in cui il Service Worker rileva l'aggiornamento e
   mostra il banner "Nuova versione disponibile" agli utenti
   che hanno già installato l'app. */
const CACHE = 'italquake-v3';
const PRECACHE = ['./index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e =>
  /* cache:'reload' forza il download dal server, bypassando la cache HTTP del browser:
     altrimenti il precache potrebbe salvare una index.html già "vecchia" */
  e.waitUntil(caches.open(CACHE).then(c =>
    Promise.all(PRECACHE.map(url => fetch(url, {cache:'reload'}).then(resp => c.put(url, resp))))
  ))
);
self.addEventListener('activate', e =>
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))
);
/* L'app invia questo messaggio quando l'utente clicca "Aggiorna" nel banner */
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});
self.addEventListener('fetch', e => {
  // Solo cache per i file locali; le richieste INGV vanno sempre in rete
  if (!e.request.url.startsWith(self.location.origin)) return;
  if (e.request.method !== 'GET') return;
  // Network-first: quando online si prende sempre la versione più recente
  // (e si aggiorna la cache); offline si usa l'ultima versione salvata.
  e.respondWith(
    fetch(e.request).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy)).catch(()=>{});
      return resp;
    }).catch(() => caches.match(e.request))
  );
});
