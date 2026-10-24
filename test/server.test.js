const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const WebSocket = require('ws');
let server, url; const clients = [];
before(async () => {
  server = spawn(process.execPath, ['server/index.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const [line] = await once(server.stdout, 'data');
  const port = String(line).match(/:(\d+)/)[1]; url = `ws://127.0.0.1:${port}`;
});
after(() => { clients.forEach(c => c.ws.terminate()); server?.kill(); });
async function client() {
  const ws = new WebSocket(url), queue = [], pending = [];
  ws.on('message', data => { const msg = JSON.parse(data); const i = pending.findIndex(p => p.type === msg.type); if (i >= 0) pending.splice(i, 1)[0].resolve(msg); else queue.push(msg); });
  ws.on('error', () => {});
  await once(ws, 'open');
  const c = { ws, send: data => ws.send(JSON.stringify(data)), next: type => {
    const i = queue.findIndex(m => m.type === type); if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(Error('Missing '+type)), 3000); pending.push({ type, resolve: v => { clearTimeout(timer); resolve(v); } }); });
  } }; clients.push(c); return c;
}
test('bad messages are rejected and the process stays available', async () => {
  const c = await client();
  for (const message of [null, [], { type: 'join_room', code: 23 }, { type: 'reconnect', code: {} }]) { c.send(message); assert.equal((await c.next('error')).type, 'error'); }
  c.send({ type: 'create_room' }); assert.match((await c.next('room_created')).code, /^[A-Z]{4}$/);
});
test('private seats, revision checks, reconnection and room departure', async () => {
  const a = await client(), b = await client(), stranger = await client();
  a.send({ type: 'create_room' }); const host = await a.next('room_created');
  a.send({ type: 'create_room' }); assert.match((await a.next('error')).error, /Already/);
  b.send({ type: 'join_room', code: host.code }); const guest = await b.next('room_joined');
  assert.equal(guest.started, false);
  a.send({ type: 'move', from: [5,0], to: [4,1], revision: 0 }); assert.equal((await a.next('move_result')).valid, false);
  a.send({ type: 'ready', ready: true }); b.send({ type: 'ready', ready: true });
  await a.next('game_started'); await b.next('game_started');
  stranger.send({ type: 'reconnect', code: host.code, player: 1 }); assert.equal((await stranger.next('error')).resetIdentity, true);
  a.send({ type: 'move', from: null, to: [4,1], revision: 0 }); assert.equal((await a.next('move_result')).valid, false);
  a.send({ type: 'move', from: [5,0], to: [4,1], revision: 0 }); assert.equal((await a.next('move_result')).revision, 1); await b.next('move_result');
  a.send({ type: 'move', from: [5,0], to: [4,1], revision: 0 }); assert.equal((await a.next('move_result')).valid, false);
  b.send({ type: 'restart' }); assert.match((await b.next('error')).error, /Finish/);
  b.ws.close(); await once(b.ws, 'close'); await a.next('opponent_disconnected');
  stranger.send({ type: 'join_room', code: host.code }); assert.match((await stranger.next('error')).error, /full/);
  const resumed = await client(); resumed.send({ type: 'reconnect', code: host.code, player: 2, token: guest.token });
  const restored = await resumed.next('room_joined'); assert.equal(restored.revision, 1); assert.equal(restored.state.board[4][1], 1); await a.next('opponent_reconnected');
  const replacement = await client(); replacement.send({ type: 'reconnect', code: host.code, player: 1, token: host.token });
  await replacement.next('room_joined'); await once(a.ws, 'close');
  resumed.send({ type: 'move', from: [2,1], to: [3,0], revision: 1 }); assert.equal((await resumed.next('move_result')).valid, true); assert.equal((await replacement.next('move_result')).revision, 2);
  resumed.send({ type: 'chat', text: {} }); await resumed.next('error');
  replacement.send({ type: 'leave_room' }); await resumed.next('room_closed');
  stranger.send({ type: 'join_room', code: host.code }); assert.match((await stranger.next('error')).error, /not found/);
});
test('homepage with query parameters still loads', async () => {
  const response = await fetch(url.replace('ws:', 'http:')+'/?room=ABCD'); assert.equal(response.status, 200); assert.match(await response.text(), /PlayTogether/);
});

test('lobby readiness resets when a player drops and chat replies survive reconnects', async () => {
  const a = await client(), b = await client();
  a.send({ type: 'create_room' }); const host = await a.next('room_created');
  b.send({ type: 'join_room', code: host.code }); const guest = await b.next('room_joined');
  b.send({ type: 'ready', ready: true });
  b.ws.close(); await once(b.ws, 'close'); await a.next('opponent_disconnected');
  const resumed = await client(); resumed.send({ type: 'reconnect', code: host.code, player: 2, token: guest.token });
  const snapshot = await resumed.next('room_joined'); assert.equal(snapshot.lobby.ready[2], false);
  a.send({ type: 'chat', text: '<img src=x onerror=alert(1)>', clientId: 'one' });
  const first = await a.next('chat'); await resumed.next('chat');
  resumed.send({ type: 'chat', text: 'reply', clientId: 'two', replyTo: first.id });
  const reply = await resumed.next('chat'); await a.next('chat');
  assert.deepEqual(reply.reply, { id: first.id, from: 1, text: first.text });
  resumed.send({ type: 'chat', text: 'reply', clientId: 'two', replyTo: first.id });
  assert.equal((await resumed.next('chat')).id, reply.id);
  a.send({ type: 'sync' }); const restored = await a.next('room_joined');
  assert.equal(restored.history.length, 2); assert.deepEqual(restored.history[1].reply, reply.reply);
  a.send({ type: 'chat', text: 'forged reply', clientId: 'three', replyTo: 99999 });
  assert.equal((await a.next('error')).chatError, true);
  a.send({ type: 'push_subscribe', subscription: { endpoint: 'https://127.0.0.1/private', keys: {} } });
  assert.equal((await a.next('error')).pushError, true);
  for (let i = 0; i < 43; i++) { a.send({ type: 'chat', text: 'bounded history', clientId: 'more-' + i }); await a.next('chat'); }
  a.send({ type: 'sync' }); assert.equal((await a.next('room_joined')).history.length, 40);
});

test('a queued authenticated departure closes the room, while a stranger cannot', async () => {
  const a = await client(), b = await client(), stranger = await client();
  a.send({ type: 'create_room' }); const host = await a.next('room_created');
  b.send({ type: 'join_room', code: host.code }); const guest = await b.next('room_joined');
  a.send({ type: 'ready', ready: true }); b.send({ type: 'ready', ready: true });
  await a.next('game_started'); await b.next('game_started');
  b.ws.close(); await once(b.ws, 'close'); await a.next('opponent_disconnected');
  a.send({ type: 'move', from: [5,0], to: [4,1], revision: 0 });
  assert.equal((await a.next('move_result')).valid, true);
  stranger.send({ type: 'leave_room', code: host.code, player: 2, token: 'wrong' });
  await stranger.next('error');
  const departed = await client();
  departed.send({ type: 'leave_room', code: host.code, player: 2, token: guest.token });
  await departed.next('room_closed'); await a.next('room_closed');
  departed.send({ type: 'leave_room', code: host.code, player: 2, token: guest.token });
  await departed.next('room_closed');
  stranger.send({ type: 'reconnect', code: host.code, player: 1, token: host.token });
  assert.equal((await stranger.next('error')).resetIdentity, true);
});
