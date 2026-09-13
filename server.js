/**
 * Lerdos PTT Relay — walkie talkie por Wi-Fi.
 *
 * Un servidor WebSocket minimo que conecta a los motorizados con la Central en
 * tiempo real. El motorizado mantiene su telefono (app Flutter) conectado al
 * relay mientras esta en linea; la Central (web) se conecta igual. Cuando alguien
 * habla, su audio se retransmite al otro lado y se anuncia QUIEN esta hablando.
 *
 * Roles:
 *   - rider  : un motorizado. Envia mensajes -> se reenvian a la central y a
 *              otros motorizados. Recibe mensajes desde la central o de otro
 *              motorizado.
 *   - central: la central de despacho. Escucha a todos los riders y puede
 *              responder a un rider concreto (o a todos).
 *
 * Enrutado por destinatario ("to"):
 *   - Si un mensaje de audio/talking trae "to" con un id concreto:
 *       * rider -> rider : el audio llega SOLO a ese motorizado. La Central
 *         igual lo escucha (monitoreo), marcado con el mismo "to".
 *       * central -> rider : llega solo a ese motorizado. Tambien lo escuchan
 *         las otras centrales (por si hay mas de una).
 *   - Sin "to" (o "to" = "all"): broadcast.
 *       rider  -> todas las centrales + todos los demas motorizados.
 *       central-> todos los motorizados.
 *   - Nunca se reenvia el audio al mismo emisor (ni eco central->central).
 *
 * Formato de mensajes JSON sobre el WebSocket:
 *   { "type": "auth", "role": "rider"|"central", "id": "...", "name": "..." }
 *   { "type": "talking", "active": true|false, "to"?: "id|all" }  // quién habla
 *   { "type": "audio", "chunks": [...], "sampleRate": 16000, "to"?: "id|all" }
 *   { "type": "roster", "riders": [...] }   // lista viva, enviada a central Y riders
 *
 * A todos los mensajes de talking/audio que retransmite el relay se les anade
 * "from": { role, id, name } del emisor real.
 *
 * El relay es "modesto": NO guarda audio (solo en vivo) y requiere que ambos
 * extremos esten conectados. Si un extremo no esta conectado, el tramo de audio
 * se descarta silenciosamente.
 *
 * Despliegue gratis:
 *   - Render (render.com): Web Service, build: npm install, start: npm start.
 *   - Railway: igual.
 *   - O en tu propia PC / la PC de la Central: `npm install && npm start`.
 */
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 4000;
const HEARTBEAT_MS = 30000;
const wss = new WebSocketServer({ port: PORT });

// Conexiones vivas.
const centralSockets = new Set();
const riderSockets = new Set();

// Nombre/id que anuncio cada socket para mostrar "quien habla".
const peerInfo = new Map();

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

/** Envia un objeto JSON a un socket si sigue abierto. */
function send(socket, obj) {
  if (socket.readyState === socket.OPEN) {
    try {
      socket.send(JSON.stringify(obj));
    } catch (_) {}
  }
}

/** Envia un objeto a TODAS las sesiones que tengan ese id dentro de un set. */
function sendToId(id, obj, sockets) {
  let sent = false;
  for (const s of sockets) {
    const info = peerInfo.get(s);
    if (info && info.id === id) {
      send(s, obj);
      sent = true;
    }
  }
  return sent;
}

/** Envia un evento de "quien esta hablando" respetando el destinatario ("to"). */
function forwardTalking(originSocket, info, active, to) {
  const targetId = to && to !== 'all' ? String(to) : null;
  const base = { type: 'talking', from: info, active, to: targetId || undefined };
  if (info.role === 'rider') {
    // La Central monitorea todo el aire que sueltan los motorizados.
    for (const c of centralSockets) send(c, base);
    // A los demas motorizados: solo al destino pedido, o a todos (broadcast).
    for (const s of riderSockets) {
      if (s === originSocket) continue;
      const rInfo = peerInfo.get(s) || {};
      if (targetId && targetId !== rInfo.id) continue;
      send(s, base);
    }
  } else {
    // La Central: le llega al rider concreto (o a todos). No se habla a si misma
    // ni a otras centrales (evita eco/feedback cuando hay mas de una).
    for (const r of riderSockets) {
      const rInfo = peerInfo.get(r) || {};
      if (targetId && targetId !== rInfo.id) continue;
      send(r, base);
    }
  }
}

/** Lista actual de interlocutores conectados (motorizados y centrales). */
function roster() {
  const list = [];
  for (const r of riderSockets) {
    const info = peerInfo.get(r);
    if (info) list.push({ id: info.id, name: info.name, role: info.role });
  }
  for (const c of centralSockets) {
    const info = peerInfo.get(c);
    if (info) list.push({ id: info.id, name: info.name, role: info.role });
  }
  return list;
}

/** Lista para la Central: SOLO motorizados (ella no debe verse a si misma). */
function rosterForCentral() {
  const list = [];
  for (const r of riderSockets) {
    const info = peerInfo.get(r);
    if (info) list.push({ id: info.id, name: info.name, role: info.role });
  }
  return list;
}

/** Envia el roster actualizado a las centrales (solo motorizados) y a los
 *  motorizados (todos los interlocutores, para que puedan elegir a quien). */
function broadcastRoster() {
  for (const c of centralSockets) send(c, { type: 'roster', riders: rosterForCentral() });
  for (const r of riderSockets) send(r, { type: 'roster', riders: roster() });
}

wss.on('connection', (socket) => {
  let connected = false;
  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    switch (msg.type) {
      case 'auth': {
        const role = msg.role === 'central' ? 'central' : 'rider';
        const info = {
          role,
          id: String(msg.id || '').trim(),
          name: msg.name || (role === 'central' ? 'Central' : 'Motorizado'),
        };
        peerInfo.set(socket, info);
        connected = true;

        // Central solo admite una sesion activa por socket; los riders varios ok.
        if (role === 'central') centralSockets.add(socket);
        else riderSockets.add(socket);

        send(socket, { type: 'auth_ok', role, id: info.id, name: info.name });
        log(`Conectado ${role} "${info.name}" (${info.id}) — riders:${riderSockets.size} central:${centralSockets.size}`);
        // Actualizo el roster en todas las centrales cuando entra/sale un rider.
        broadcastRoster();
        break;
      }

      case 'roster_req': {
        if (!connected) break;
        const info = peerInfo.get(socket) || {};
        send(socket, {
          type: 'roster',
          riders: info.role === 'central' ? rosterForCentral() : roster(),
        });
        break;
      }

      case 'talking': {
        if (!connected) break;
        const info = peerInfo.get(socket) || { role: 'rider', id: '', name: '?' };
        forwardTalking(socket, info, !!msg.active, msg.to);
        break;
      }

      case 'audio': {
        if (!connected) break;
        const info = peerInfo.get(socket) || { role: 'rider', id: '', name: '?' };
        const chunks = Array.isArray(msg.chunks) ? msg.chunks : [];
        const sampleRate = Number(msg.sampleRate) || 16000;
        const targetId = msg.to && msg.to !== 'all' ? String(msg.to) : null;

        const env = { type: 'audio', from: info, chunks, sampleRate, to: targetId || undefined };

        if (info.role === 'rider') {
          // El motorizado habla -> llega a la Central (monitoreo) y a los
          // demas motorizados: solo al destino pedido, o a todos (broadcast).
          for (const c of centralSockets) send(c, env);
          for (const s of riderSockets) {
            if (s === socket) continue; // no oir su propio eco
            const rInfo = peerInfo.get(s) || {};
            if (targetId && targetId !== rInfo.id) continue;
            send(s, env);
          }
        } else {
          // La Central habla -> llega al rider concreto (msg.to) o a todos.
          // Tambien la escuchan las otras centrales (si hay mas de una).
          for (const r of riderSockets) {
            const rInfo = peerInfo.get(r) || {};
            if (targetId && targetId !== rInfo.id) continue;
            send(r, env);
          }
        }
        break;
      }

      case 'ping': {
        send(socket, { type: 'pong' });
        break;
      }
    }
  });

  socket.on('close', () => {
    const info = peerInfo.get(socket);
    if (info) {
      log(`Desconectado ${info.role} "${info.name}"`);
      if (info.role === 'central') centralSockets.delete(socket);
      else riderSockets.delete(socket);
      // Al quitarse un rider, renovamos la lista en las centrales.
      broadcastRoster();
      // Si ese rider estaba hablando, avisamos que dejo de hablar.
      if (info.role === 'rider') {
        forwardTalking(socket, info, false, undefined);
      }
    }
    peerInfo.delete(socket);
    socket.terminate();
  });

  socket.on('error', () => {
    try { socket.terminate(); } catch (_) {}
  });
});

// Heartbeat: detecta sockets muertos (cliente que se desconecta sin cerrar)
// para no dejar "fantasmas" en el roster ni acumularlos.
setInterval(() => {
  for (const socket of new Set([...centralSockets, ...riderSockets])) {
    if (socket.isAlive === false) {
      try { socket.terminate(); } catch (_) {}
      continue;
    }
    socket.isAlive = false;
    try { socket.ping(); } catch (_) {}
  }
}, HEARTBEAT_MS);

log(`Lerdos PTT relay escuchando en el puerto ${PORT}`);