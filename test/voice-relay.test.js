const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { WebSocket } = require('ws');

function waitForServer(port) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tryConnect = () => {
      const req = http.get(`http://127.0.0.1:${port}/api/ice-servers`, (res) => {
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - started > 5000) reject(new Error('Server start timed out'));
        else setTimeout(tryConnect, 100);
      });
    };
    tryConnect();
  });
}

test('ICE endpoint and WebSocket binary voice relay', async (t) => {
  const port = 3456;
  const serverPath = path.join(__dirname, '../server/index.js');
  const serverProc = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });

  t.after(() => {
    serverProc.kill();
  });

  await waitForServer(port);

  await t.test('GET /api/ice-servers returns STUN configuration', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/ice-servers`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.iceServers));
    assert.ok(data.iceServers.length >= 1);
    assert.ok(data.iceServers[0].urls.length > 0);
  });

  await t.test('Binary voice packets are relayed between room peers', async () => {
    const ws1 = new WebSocket(`ws://127.0.0.1:${port}`);
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}`);
    ws1.binaryType = 'arraybuffer';
    ws2.binaryType = 'arraybuffer';

    await Promise.all([
      new Promise((res) => ws1.on('open', res)),
      new Promise((res) => ws2.on('open', res)),
    ]);

    // Peer 1 creates room
    let roomCode = null;
    await new Promise((resolve) => {
      ws1.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(raw);
        if (msg.type === 'room_created') {
          roomCode = msg.code;
          resolve();
        }
      });
      ws1.send(JSON.stringify({ type: 'create_room' }));
    });

    assert.ok(roomCode);

    // Peer 2 joins room
    await new Promise((resolve) => {
      ws2.on('message', (raw, isBinary) => {
        if (isBinary) return;
        const msg = JSON.parse(raw);
        if (msg.type === 'room_joined') {
          resolve();
        }
      });
      ws2.send(JSON.stringify({ type: 'join_room', code: roomCode }));
    });

    // Test sending binary voice frame from Peer 1 to Peer 2
    const voicePayload = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]);
    const receivedPromise = new Promise((resolve) => {
      ws2.on('message', (data, isBinary) => {
        if (isBinary) {
          resolve(new Uint8Array(data));
        }
      });
    });

    ws1.send(voicePayload.buffer);

    const received = await receivedPromise;
    assert.deepEqual(Array.from(received), Array.from(voicePayload));

    // Test sending binary voice frame from Peer 2 to Peer 1
    const voicePayload2 = new Uint8Array([0xca, 0xfe, 0xba, 0xbe, 0x04, 0x05, 0x06]);
    const receivedPromise2 = new Promise((resolve) => {
      ws1.on('message', (data, isBinary) => {
        if (isBinary) {
          resolve(new Uint8Array(data));
        }
      });
    });

    ws2.send(voicePayload2.buffer);

    const received2 = await receivedPromise2;
    assert.deepEqual(Array.from(received2), Array.from(voicePayload2));

    ws1.close();
    ws2.close();
  });
});
