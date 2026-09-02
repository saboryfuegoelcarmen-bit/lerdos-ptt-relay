/**
 * Lerdos PTT Relay — walkie talkie por Wi-Fi.
 *
 * Un servidor WebSocket minimo que conecta a los motorizados con la Central en
 * tiempo real. El motorizado mantiene su telefono (app Flutter) conectado al
 * relay mientras esta en linea; la Central (web) se conecta igual. Cuando alguien
 * habla, su audio se retransmite al otro lado y se anuncia QUIEN esta hablando.
 *
 * Roles:
 *   - rider  : un motorizado. Envia mensajes -> se reenvian a la central.
 *              Recibe mensajes desde la central.
 *   - central: la central de despacho. Escucha a todos los riders y puede
 *              responder a un rider concreto (o a todos).
 *
 * Formato de mensajes JSON sobre el WebSocket:
 *   { "type": "auth", "role": "rider"|"central", "id": "...", "name": "..." }
 *   { "type": "talking", "active": true|false }            // quién habla ahora
 *   { "type": "audio", "chunks": [...], "sampleRate": 16000 } // datos de audio
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
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT) || 4000;
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
  if (socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify(obj));
    } catch (_) {}
  }
}

/** Envia un evento de "quien esta hablando" a todas las centrales/a un rider. */
function broadcastTalking(info, active) {
  const msg = { type: 'talking', from: info, active };
  for (const c of centralSockets) send(c, msg);
}

/** Lista actual de riders conectados (para que la Central muestre quien esta al aire). */
function roster() {
  const list = [];
  for (const r of riderSockets) {
    const info = peerInfo.get(r);
    if (info) list.push({ id: info.id, name: info.name, role: info.role });
  }
  return list;
}

/** Envia el roster actualizado a todas las centrales. */
function broadcastRoster() {
  const msg = { type: 'roster', riders: roster() };
  for (const c of centralSockets) send(c, msg);
}

wss.on('connection', (socket) => {
  let connected = false;

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
          id: msg.id || '',
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
        if (role === 'rider') broadcastRoster();
        break;
      }

      case 'roster_req': {
        if (!connected) break;
        send(socket, { type: 'roster', riders: roster() });
        break;
      }

      case 'talking': {
        if (!connected) break;
        const info = peerInfo.get(socket) || { role: 'rider', id: '', name: '?' };
        broadcastTalking(info, !!msg.active);
        break;
      }

      case 'audio': {
        if (!connected) break;
        const info = peerInfo.get(socket) || { role: 'rider', id: '', name: '?' };
        const chunks = Array.isArray(msg.chunks) ? msg.chunks : [];
        const sampleRate = Number(msg.sampleRate) || 16000;

        if (info.role === 'rider') {
          // El motorizado habla -> llega a la Central.
          for (const c of centralSockets) {
            send(c, { type: 'audio', from: info, chunks, sampleRate });
          }
        } else {
          // La Central habla -> llega al rider concreto (msg.to) o a todos.
          for (const r of riderSockets) {
            const rInfo = peerInfo.get(r) || {};
            if (msg.to && msg.to !== rInfo.id) continue;
            send(r, { type: 'audio', from: info, chunks, sampleRate });
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
        else {
          riderSockets.delete(socket);
          // Al quitarse un rider, renovamos la lista en las centrales.
          broadcastRoster();
        }
        // Si ese rider estaba hablando, avisamos que dejo de hablar.
        if (info.role === 'rider' && centralSockets.size && info) {
          broadcastTalking(info, false);
        }
      }
      peerInfo.delete(socket);
      socket.terminate();
    });

  socket.on('error', () => {
    try { socket.terminate(); } catch (_) {}
  });
});

log(`Lerdos PTT relay escuchando en el puerto ${PORT}`);
