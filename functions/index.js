'use strict';

const functions = require('firebase-functions');
const admin     = require('firebase-admin');
const https     = require('https');

admin.initializeApp();

const db        = admin.firestore();
const messaging = admin.messaging();

/* ── Costanti ── */
const INGV_BASE      = 'https://webservices.ingv.it/fdsnws/event/1/query';
const WINDOW_MINUTES = 6;   // finestra di lookback in minuti
const MAX_EVENT_AGE  = 24;  // ore: dopo queste ore puliamo sentEvents

/* ── Utilità geografica ── */
function haverDist(la1, lo1, la2, lo2) {
  const R = 6371, r = Math.PI / 180;
  const dlat = (la2 - la1) * r;
  const dlon  = (lo2 - lo1) * r;
  const a = Math.sin(dlat / 2) ** 2 +
            Math.cos(la1 * r) * Math.cos(la2 * r) * Math.sin(dlon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* Estrae il codice provincia a 2 lettere dalla stringa INGV, es. "(BN)" */
function extractProv(place) {
  const m = place && place.match(/\(([A-Z]{2})\)\s*$/);
  return m ? m[1] : null;
}

/* ── HTTP helper ── */
function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else reject(new Error('HTTP ' + res.statusCode));
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Timeout INGV')); });
  });
}

/* ── Parser formato text INGV ── */
function parseEqText(text) {
  return text.trim().split(/\r?\n/)
    .filter(l => l && !l.startsWith('#'))
    .map(line => {
      const p = line.split('|');
      if (p.length < 12) return null;
      const depth = parseFloat(p[4]);
      const mag   = parseFloat(p[10]);
      const lat   = parseFloat(p[2]);
      const lon   = parseFloat(p[3]);
      if (isNaN(lat) || isNaN(lon) || isNaN(mag)) return null;
      const rawTime = p[1].trim();
      const time    = rawTime.endsWith('Z') ? rawTime : rawTime + 'Z';
      return {
        id:      p[0].trim(),
        time,
        lat,
        lon,
        depth:   isNaN(depth) ? 0 : depth,
        magType: p[9].trim(),
        mag,
        place:   p[12] ? p[12].trim() : 'N/D'
      };
    })
    .filter(Boolean);
}

/* ── Logica di matching utente ↔ evento ──
   Specchio esatto dei criteri applicati in shouldNotif() nel frontend. */
function userMatchesEvent(user, ev) {
  const minMag = typeof user.minMag === 'number' ? user.minMag : 3;
  if (ev.mag < minMag) return false;

  if (user.province) {
    const ep = extractProv(ev.place);
    if (!ep || ep !== user.province) return false;
  }

  const maxDist = typeof user.maxDist === 'number' ? user.maxDist : 0;
  if (maxDist > 0) {
    /* Se l'utente ha impostato un raggio ma non ha la posizione GPS
       non inviamo la notifica (comportamento coerente col frontend). */
    if (user.userLat == null || user.userLon == null) return false;
    const d = haverDist(user.userLat, user.userLon, ev.lat, ev.lon);
    if (d > maxDist) return false;
  }

  const maxDepth = typeof user.maxDepth === 'number' ? user.maxDepth : 0;
  if (maxDepth > 0 && ev.depth > maxDepth) return false;

  return true;
}

/* ── Funzione principale: eseguita ogni 2 minuti da Cloud Scheduler ── */
exports.sendEarthquakeNotifications = functions.pubsub
  .schedule('every 2 minutes')
  .onRun(async () => {
    const now   = new Date();
    const start = new Date(now - WINDOW_MINUTES * 60 * 1000);
    const fmt   = d => d.toISOString().slice(0, 19);

    /* 1. Recupera eventi recenti da INGV (solo Italia) */
    const url =
      `${INGV_BASE}?format=text` +
      `&starttime=${fmt(start)}&endtime=${fmt(now)}` +
      `&orderby=time&minmagnitude=0` +
      `&minlat=33&maxlat=49&minlon=4&maxlon=21&limit=100`;

    let events;
    try {
      const text = await fetchText(url);
      events = parseEqText(text);
    } catch (e) {
      console.error('Errore INGV fetch:', e.message);
      return null;
    }

    if (!events.length) {
      console.log('Nessun evento nel periodo.');
      return null;
    }

    /* 2. Filtra gli eventi già notificati */
    const newEvents = [];
    const sentRef   = db.collection('sentEvents');

    await Promise.all(events.map(async ev => {
      const snap = await sentRef.doc(ev.id).get();
      if (!snap.exists) {
        newEvents.push(ev);
        await sentRef.doc(ev.id).set({
          sentAt: admin.firestore.FieldValue.serverTimestamp(),
          mag:    ev.mag,
          place:  ev.place
        });
      }
    }));

    if (!newEvents.length) {
      console.log('Tutti gli eventi già notificati.');
      return null;
    }
    console.log(`Nuovi eventi da notificare: ${newEvents.map(e => `${e.id} M${e.mag}`).join(', ')}`);

    /* 3. Recupera utenti con notifiche abilitate */
    const usersSnap = await db.collection('users')
      .where('notifEnabled', '==', true)
      .get();

    if (usersSnap.empty) {
      console.log('Nessun utente con notifiche attive.');
      return null;
    }

    const users = usersSnap.docs
      .map(d => ({ uid: d.id, ...d.data() }))
      .filter(u => u.fcmToken);   /* solo utenti con token FCM valido */

    if (!users.length) {
      console.log('Nessun utente con token FCM registrato.');
      return null;
    }

    /* 4. Per ogni evento, invia ai token degli utenti che corrispondono ai criteri */
    const sendPromises = [];

    for (const ev of newEvents) {
      const matchingUsers  = users.filter(u => userMatchesEvent(u, ev));
      const matchingTokens = matchingUsers.map(u => u.fcmToken);

      if (!matchingTokens.length) {
        console.log(`Evento ${ev.id}: nessun utente corrisponde ai criteri.`);
        continue;
      }
      console.log(`Evento ${ev.id} M${ev.mag.toFixed(1)}: invio a ${matchingTokens.length} utente/i.`);

      const title = `🔴 Terremoto M${ev.mag.toFixed(1)}`;
      const body  = `${ev.place}\n${ev.time.replace('T', ' ').slice(0, 19)} UTC · ${ev.depth.toFixed(0)} km`;

      /* FCM supporta max 500 token per chiamata */
      for (let i = 0; i < matchingTokens.length; i += 500) {
        const chunk = matchingTokens.slice(i, i + 500);
        sendPromises.push(
          messaging.sendEachForMulticast({
            tokens: chunk,
            notification: { title, body },
            data: {
              eventId: ev.id,
              url:     'https://italquake.firebaseapp.com/'
            },
            webpush: {
              notification: { icon: '/icon-192.png', tag: ev.id },
              fcmOptions:   { link: 'https://italquake.firebaseapp.com/' }
            }
          }).then(res => {
            console.log(`  ✅ OK: ${res.successCount}  ❌ Fail: ${res.failureCount}`);
            /* Rimuovi i token non più validi da Firestore */
            const cleanups = [];
            res.responses.forEach((r, idx) => {
              if (!r.success) {
                const code = r.error && r.error.code;
                if (
                  code === 'messaging/registration-token-not-registered' ||
                  code === 'messaging/invalid-registration-token'
                ) {
                  const badToken = chunk[idx];
                  cleanups.push(
                    db.collection('users')
                      .where('fcmToken', '==', badToken)
                      .get()
                      .then(s => Promise.all(s.docs.map(d => d.ref.update({ fcmToken: null }))))
                      .catch(() => {})
                  );
                }
              }
            });
            return Promise.all(cleanups);
          })
        );
      }
    }

    await Promise.all(sendPromises);

    /* 5. Pulizia: rimuovi sentEvents più vecchi di MAX_EVENT_AGE ore */
    const cutoff = new Date(now - MAX_EVENT_AGE * 3600 * 1000);
    const oldSnap = await sentRef
      .where('sentAt', '<', cutoff)
      .limit(200)
      .get();

    if (!oldSnap.empty) {
      const batch = db.batch();
      oldSnap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      console.log(`Puliti ${oldSnap.size} sentEvents scaduti.`);
    }

    return null;
  });
