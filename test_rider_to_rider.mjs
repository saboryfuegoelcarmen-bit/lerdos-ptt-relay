// Test del routing rider<->rider + central (usar contra relay local 4050).
// Uso: URL=ws://127.0.0.1:4050 npm test -- test_rider_to_rider.mjs
//   o:  node test_rider_to_rider.mjs
import WebSocket from 'ws';

const url = process.env.URL || 'ws://127.0.0.1:4050';
const logs = [];
let pass = 0, fail = 0;
const check = (n, ok, d) => { logs.push(`${ok?'PASS':'FAIL'} ${n}${d?' -> '+d:''}`); ok?pass++:fail++; };

const connect = (role, id, name) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', role, id, name })));
  ws.on('message', raw => { if (JSON.parse(raw).type === 'auth_ok') res(ws); });
  ws.on('error', rej);
});

// Cola por mensaje para cada socket.
function queued(ws) {
  const q = [];
  ws.on('message', raw => { try { q.push(JSON.parse(raw)); } catch (_) {} });
  return q;
}
// Espera hasta que se cumpla `pred` sobre los mensajes acumulados (o timeout).
const waitFor = (q, pred, ms = 1200) => new Promise((res) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (q.some(pred)) { clearInterval(iv); res(true); }
    else if (Date.now() - t0 > ms) { clearInterval(iv); res(false); }
  }, 25);
});
const waitSilence = (q, clear = true, ms = 700) => new Promise((res) => {
  setTimeout(() => { if (clear) q.length = 0; res(true); }, ms);
});
// Consume y limpia la cola (roster/restos).
const flush = (q) => { const n = q.length; q.length = 0; return n; };
const byAudio = (m) => m.type === 'audio';
const byFrom = (id) => (m) => (m.from && m.from.id === id) && (m.type === 'audio' || m.type === 'talking');

const download = async () => {
  const riderA = await connect('rider', 'rider-A', 'Ander');
  const riderB = await connect('rider', 'rider-B', 'Dana');
  const central = await connect('central', 'central', 'Central');
  const qA = queued(riderA), qB = queued(riderB), qC = queued(central);
  await waitSilence(qA); flush(qA); flush(qB); flush(qC);

  // 1) A habla dirigido a B: B lo recibe, la Central lo monitorea, A no oye eco.
  riderA.send(JSON.stringify({ type: 'talking', active: true, to: 'rider-B' }));
  riderA.send(JSON.stringify({ type: 'audio', chunks: [111], sampleRate: 16000, to: 'rider-B' }));
  const bGot = await waitFor(qB, byFrom('rider-A'));
  const cGot = await waitFor(qC, byFrom('rider-A'));
  await waitSilence(qB); await waitSilence(qC);
  const aEcho = flush(qA);
  check('rider->rider dirigido: B recibe audio de A (con to=rider-B)',
    bGot, JSON.stringify(qB.filter(byFrom('rider-A')).map(m => m.to)));
  check('rider->rider dirigido: la Central lo monitorea', cGot);
  check('rider->rider dirigido: A NO recibe su propio eco', aEcho === 0, `eco=${aEcho}`);
  flush(qB); flush(qC);

  // 2) A habla en broadcast: B y Central reciben, A no.
  riderA.send(JSON.stringify({ type: 'audio', chunks: [222], sampleRate: 16000 }));
  const bGot2 = await waitFor(qB, byFrom('rider-A'));
  const cGot2 = await waitFor(qC, byFrom('rider-A'));
  await waitSilence(qB); await waitSilence(qC);
  const aEcho2 = flush(qA);
  check('rider broadcast: B recibe el audio', bGot2);
  check('rider broadcast: Central recibe el audio', cGot2);
  check('rider broadcast: A NO oye su propio eco', aEcho2 === 0, `eco=${aEcho2}`);
  flush(qB); flush(qC);

  // 3) Central dirige a A: solo A.
  central.send(JSON.stringify({ type: 'audio', chunks: [333], sampleRate: 16000, to: 'rider-A' }));
  const aGot3 = await waitFor(qA, byFrom('central'));
  const bGot3 = await waitFor(qB, byFrom('central'), 600);
  check('central->rider dirigido: A recibe', aGot3);
  check('central->rider dirigido: B NO recibe', !bGot3);
  flush(qA); flush(qB);

  // 4) Central broadcast: A y B reciben.
  central.send(JSON.stringify({ type: 'audio', chunks: [444], sampleRate: 16000 }));
  const aGot4 = await waitFor(qA, byFrom('central'));
  const bGot4 = await waitFor(qB, byFrom('central'));
  check('central broadcast: A recibe', aGot4);
  check('central broadcast: B recibe', bGot4);

  riderA.close(); riderB.close(); central.close();
};

await download();
console.log(logs.join('\n'));
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);