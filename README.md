# Lerdos PTT Relay

Relay WebSocket en tiempo real para el **walkie-talkie** de Lerdos (motorizado
<-> central), conectado **por Wi-Fi**, y que avisa **quién está hablando**.

## Qué hace

- El `motorizado` (app Flutter) mantiene una conexión WebSocket abierta mientras
  está en línea.
- La `Central` (web) también se conecta.
- Cuando cualquiera de los dos suelta/agarra el botón de hablar, manda su audio
  en vivo y el relay lo retransmite al otro lado.
- Cada mensaje de audio lleva `from.name`, así la Central muestra **quién está
  hablando** en ese momento.

## Desplegarlo gratis

**Opción A — Render (mejor para que funcione en cualquier lado):**
1. Sube esta carpeta a un repo de GitHub.
2. En Render: *New > Web Service*.
3. Build command: `npm install`
4. Start command: `npm start`
5. Render te da una URL tipo `https://tu-relay.onrender.com`.
6. Usa esa URL en la app y en la Central.

**Opción B — Railway:** mismo procedimiento.

**Opción C — En tu PC / la PC de la Central (para pruebas locales):**
```
npm install
npm start
```
Queda escuchando en `ws://localhost:4000` (o en el puerto `PORT`).

## Formato de mensajes

```
Cliente -> Relay:
  { "type": "auth", "role": "rider"|"central", "id": "...", "name": "..." }
  { "type": "talking", "active": true|false }
  { "type": "audio", "chunks": [Float32Array...], "sampleRate": 16000,
    "to": "riderId-opcional (solo cuando la central responde)" }

Relay -> Cliente:
  { "type": "auth_ok", ... }
  { "type": "talking", "from": {...}, "active": bool }
  { "type": "audio", "from": {...}, "chunks": [...], "sampleRate": 16000 }
```

## Notas de privacidad / costo

- **No guarda audio** (solo en vivo). Sin registro de voz.
- Para 1 motorizado <-> Central es gratuito en el tier free de Render/Railway.
- Requiere que ambos extremos tengan internet (es por Wi-Fi/datos, no radio).
