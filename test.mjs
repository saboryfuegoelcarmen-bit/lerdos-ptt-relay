import WebSocket from 'ws';
const url = process.env.URL || 'ws://localhost:4000';
const logs = [];
let pass = 0, fail = 0;
const check = (n, ok, d) => { logs.push(`${ok?'PASS':'FAIL'} ${n}${d?' -> '+d:''}`); ok?pass++:fail++; };

const connect = (role, id, name) => new Promise((res, rej) => {
  const ws = new WebSocket(url);
  ws.on('open', ()=> ws.send(JSON.stringify({type:'auth', role, id, name})));
  ws.on('message', raw => { if(JSON.parse(raw).type==='auth_ok') res(ws); });
  ws.on('error', rej);
});

const rider = await connect('rider', 'rider-99', 'Pedro Elias');
const central = await connect('central', 'central', 'Central');

// 1) Motorizado habla -> Central recibe audio Int16 + quien habla.
let pickedAudio = false, pickedTalkingName = '';
await new Promise((done) => {
  let gotAudio = false, gotTalking = false;
  central.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type==='audio'){ gotAudio = true; }
    if (m.type==='talking' && m.active){ gotTalking = true; pickedTalkingName = (m.from && m.from.name)||''; }
    if (gotAudio && gotTalking) done();
  });
  rider.send(JSON.stringify({type:'talking', active:true}));
  rider.send(JSON.stringify({type:'audio', chunks:[-100,0,32767,-32768], sampleRate:16000}));
  setTimeout(done, 1500);
});
pickedAudio = true;
check('Motorizado->Central: recibe audio Int16', pickedAudio);
check('Motorizado->Central: se anuncia quien habla (nombre)', pickedTalkingName === 'Pedro Elias', pickedTalkingName);

// 2) Central responde -> el motorizado recibe.
let centralToRider = false;
await new Promise((done) => {
  rider.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type==='audio' && m.from && m.from.role==='central'){ centralToRider=true; done(); }
  });
  central.send(JSON.stringify({type:'audio', chunks:[1,2,3], sampleRate:16000}));
  setTimeout(done, 1500);
});
check('Central->Motorizado: audio llega al rider', centralToRider);

// 3) Roster: la Central recibe la lista de motorizados conectados.
let gotRoster = [];
await new Promise((done) => {
  central.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type==='roster'){ gotRoster = m.riders||[]; done(); }
  });
  central.send(JSON.stringify({type:'roster_req'}));
  setTimeout(done, 1500);
});
check('Central: recibe roster con el motorizado conectado',
  gotRoster.some(r=>r.name==='Pedro Elias'), JSON.stringify(gotRoster));

console.log(logs.join('\n'));
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail?1:0);
