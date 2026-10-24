/**
 * PlayTogether — HTTP + WebSocket server
 *
 * Serves static files from ../public/ and manages multiplayer checkers rooms
 * with chat and WebRTC signalling over a single WebSocket connection.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const CheckersGame = require('./game');
const { randomBytes } = require('node:crypto');
const push = require('./notifications');
const notify = push.createNotifier();

/* ------------------------------------------------------------------ */
/*  Configuration                                                     */
/* ------------------------------------------------------------------ */

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '../public/');
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const ROOM_CLEANUP_DELAY_MS = 30 * 60 * 1000; // Hold a table for 30 minutes after both leave the browser.

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/* ------------------------------------------------------------------ */
/*  Room state                                                        */
/* ------------------------------------------------------------------ */

/** @type {Map<string, { game: CheckersGame, players: { 1: WebSocket|null, 2: WebSocket|null }, cleanupTimer?: NodeJS.Timeout }>} */
const rooms = new Map();

/** Generate a unique 4-letter uppercase room code. */
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * 26)];
  } while (rooms.has(code));
  return code;
}

/* ------------------------------------------------------------------ */
/*  Utility: safe send / broadcast                                    */
/* ------------------------------------------------------------------ */

/** Send JSON data to a single WebSocket (swallows errors). */
function sendTo(ws, data) {
  try {
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(data));
    }
  } catch (_) {
    /* connection may have closed between check and send — ignore */
  }
}

/** Broadcast JSON data to both players in a room. */
function broadcast(room, data) {
  sendTo(room.players[1], data);
  sendTo(room.players[2], data);
}

/** Get the opponent's WebSocket (or null). */
function getOpponent(room, playerNum) {
  return room.players[playerNum === 1 ? 2 : 1] || null;
}

function lobbyState(room) {
  return { type: 'lobby_state', started: room.started,
    connected: { 1: !!room.players[1], 2: !!room.players[2] },
    ready: { 1: room.ready.has(1), 2: room.ready.has(2) } };
}

function roomSnapshot(room, code, player) {
  return { code, player, token: room.tokens[player], state: room.game.getState(),
    counts: room.game.getPieceCounts(), revision: room.revision, started: room.started,
    opponentConnected: !!getOpponent(room, player), lobby: lobbyState(room), history: room.history };
}

/* ------------------------------------------------------------------ */
/*  ICE / TURN Servers Configuration & Cache                          */
/* ------------------------------------------------------------------ */

let cachedIceServers = null;
let cachedIceExpiry = 0;

async function handleIceServers(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const now = Date.now();
  if (cachedIceServers && now < cachedIceExpiry) {
    return res.end(JSON.stringify({ iceServers: cachedIceServers }));
  }

  // 1. Dynamic Metered.ca integration (if configured in environment)
  const meteredDomain = process.env.METERED_DOMAIN;
  const meteredApiKey = process.env.METERED_API_KEY;

  if (meteredDomain && meteredApiKey) {
    try {
      const url = `https://${meteredDomain}/api/v1/turn/credentials?apiKey=${meteredApiKey}`;
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data) && data.length > 0) {
          cachedIceServers = data;
          cachedIceExpiry = now + 10 * 60 * 1000; // Cache 10 minutes
          return res.end(JSON.stringify({ iceServers: cachedIceServers }));
        }
      }
    } catch (err) {
      console.warn('[ICE] Failed to fetch Metered TURN credentials:', err.message);
    }
  }

  // 2. Custom TURN credentials (if configured in environment)
  const customTurnUrl = process.env.TURN_URL;
  const customTurnUser = process.env.TURN_USERNAME;
  const customTurnCred = process.env.TURN_CREDENTIAL;

  const servers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
    { urls: ['stun:stun.cloudflare.com:3478'] },
  ];

  if (customTurnUrl && customTurnUser && customTurnCred) {
    servers.push({
      urls: customTurnUrl.split(',').map((s) => s.trim()),
      username: customTurnUser,
      credential: customTurnCred,
    });
  }

  cachedIceServers = servers;
  cachedIceExpiry = now + 60 * 1000;
  res.end(JSON.stringify({ iceServers: cachedIceServers }));
}

/* ------------------------------------------------------------------ */
/*  HTTP static-file server                                           */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/api/push-key') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ publicKey: push.publicKey }));
  }
  if (urlPath === '/api/ice-servers') {
    return handleIceServers(req, res);
  }

  // Map "/" to "/index.html"
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, urlPath);

  // Prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

/* ------------------------------------------------------------------ */
/*  WebSocket server                                                  */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.playerNum = null;
  ws.roomCode = null;
  ws.on('error', () => {});
  let messageWindow = Date.now(), messageCount = 0;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw, isBinary) => {
    // Binary messages are voice audio relay frames
    if (isBinary) {
      if (!ws.roomCode || !ws.playerNum) return;
      const room = rooms.get(ws.roomCode);
      if (!room || room.players[ws.playerNum] !== ws) return;
      const opponent = getOpponent(room, ws.playerNum);
      if (opponent && opponent.readyState === 1 /* OPEN */) {
        opponent.send(raw, { binary: true });
      }
      return;
    }

    if (Date.now() - messageWindow > 10000) { messageWindow = Date.now(); messageCount = 0; }
    if (++messageCount > 120) return ws.close(1008, 'Too many messages');
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return sendTo(ws, { type: 'error', error: 'Invalid JSON' });
    }

    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') return sendTo(ws, { type: 'error', error: 'Invalid message' });
    const currentRoom = rooms.get(ws.roomCode);
    const isMember = currentRoom && currentRoom.players[ws.playerNum] === ws;
    if (['create_room', 'join_room', 'reconnect'].includes(msg.type) && isMember) return sendTo(ws, { type: 'error', error: 'Already in a room' });
    if (['move', 'restart', 'chat', 'signal', 'ready', 'presence', 'push_subscribe', 'sync'].includes(msg.type) && !isMember) return sendTo(ws, { type: 'error', error: 'Not in a room' });
    if (['join_room', 'reconnect'].includes(msg.type) && (typeof msg.code !== 'string' || !/^[a-z]{4}$/i.test(msg.code))) return sendTo(ws, { type: 'error', error: 'Invalid room code' });
    switch (msg.type) {
      /* ---- Room lifecycle ---- */

      case 'sync': {
        sendTo(ws, { type: 'room_joined', ...roomSnapshot(currentRoom, ws.roomCode, ws.playerNum) });
        break;
      }

      case 'presence': {
        if (typeof msg.hidden === 'boolean') currentRoom.hidden[ws.playerNum] = msg.hidden;
        break;
      }

      case 'push_subscribe': {
        if (msg.subscription === null) delete currentRoom.subscriptions[ws.playerNum];
        else if (push.validSubscription(msg.subscription)) currentRoom.subscriptions[ws.playerNum] = { endpoint: msg.subscription.endpoint, keys: { auth: msg.subscription.keys.auth, p256dh: msg.subscription.keys.p256dh } };
        else return sendTo(ws, { type: 'error', error: 'This notification subscription is not supported.', pushError: true });
        sendTo(ws, { type: 'push_saved', enabled: !!currentRoom.subscriptions[ws.playerNum] });
        break;
      }

      case 'create_room': {
        if (rooms.size >= 1000) return sendTo(ws, { type: 'error', error: 'Rooms are busy. Try later.' });
        const code = generateRoomCode();
        const game = new CheckersGame();
        const room = { game, players: { 1: ws, 2: null }, tokens: { 1: randomBytes(24).toString('hex'), 2: null }, revision: 0, rematch: new Set(), ready: new Set(), started: false, history: [], nextMessageId: 1, subscriptions: {}, hidden: {} };
        rooms.set(code, room);

        ws.playerNum = 1;
        ws.roomCode = code;

        sendTo(ws, { type: 'room_created', ...roomSnapshot(room, code, 1) });
        break;
      }

      case 'join_room': {
        const code = (msg.code || '').toUpperCase();
        const room = rooms.get(code);

        if (!room) {
          return sendTo(ws, { type: 'error', error: 'Room not found' });
        }
        if (room.tokens[2] !== null) {
          return sendTo(ws, { type: 'error', error: 'Room is full' });
        }

        // Cancel any pending cleanup timer
        if (room.cleanupTimer) {
          clearTimeout(room.cleanupTimer);
          room.cleanupTimer = undefined;
        }

        room.players[2] = ws;
        room.tokens[2] = randomBytes(24).toString('hex');
        ws.playerNum = 2;
        ws.roomCode = code;

        sendTo(ws, { type: 'room_joined', ...roomSnapshot(room, code, 2) });
        broadcast(room, lobbyState(room));
        notify(room, code, 1, 'lobby', 'Your partner joined. Come back when you’re ready.');
        break;
      }

      case 'reconnect': {
        const code = (msg.code || '').toUpperCase();
        const player = msg.player;
        const room = rooms.get(code);

        if (!room) {
          return sendTo(ws, { type: 'error', error: 'Room not found', resetIdentity: true });
        }
        if (player !== 1 && player !== 2) {
          return sendTo(ws, { type: 'error', error: 'Invalid player number' });
        }
        if (typeof msg.token !== 'string' || msg.token !== room.tokens[player]) return sendTo(ws, { type: 'error', error: 'This seat belongs to another player', resetIdentity: true });

        // Cancel any pending cleanup timer
        if (room.cleanupTimer) {
          clearTimeout(room.cleanupTimer);
          room.cleanupTimer = undefined;
        }

        const oldSocket = room.players[player];
        room.players[player] = ws;
        if (oldSocket && oldSocket !== ws) { oldSocket.roomCode = null; oldSocket.close(4001, 'Session replaced'); }
        ws.playerNum = player;
        ws.roomCode = code;

        sendTo(ws, { type: 'room_joined', ...roomSnapshot(room, code, player) });

        const opponent = getOpponent(room, player);
        sendTo(opponent, { type: 'opponent_reconnected' });
        if (!room.started) broadcast(room, lobbyState(room));
        break;
      }

      /* ---- Gameplay ---- */

      case 'leave_room': {
        // A saved departure can be delivered after a network loss without reclaiming the seat.
        const code = isMember ? ws.roomCode : msg.code;
        const room = rooms.get(code);
        if (!room) { sendTo(ws, { type: 'room_closed', error: 'You left the room.' }); break; }
        if (!isMember && (![1, 2].includes(msg.player) || typeof msg.token !== 'string' || room.tokens[msg.player] !== msg.token)) {
          return sendTo(ws, { type: 'error', error: 'Unable to leave this seat', resetIdentity: true });
        }
        clearTimeout(room.cleanupTimer);
        const departing = isMember ? ws.playerNum : msg.player;
        notify(room, code, departing === 1 ? 2 : 1, 'room', 'Your partner left. This table has ended.');
        const notice = { type: 'room_closed', error: 'A player left. This room has ended.' };
        broadcast(room, notice);
        if (!isMember) sendTo(ws, notice);
        rooms.delete(code);
        for (const socket of Object.values(room.players)) if (socket) { socket.roomCode = null; socket.playerNum = null; }
        break;
      }

      case 'ready': {
        if (currentRoom.started) break;
        if (typeof msg.ready !== 'boolean') return sendTo(ws, { type: 'error', error: 'Invalid ready status' });
        if (msg.ready) currentRoom.ready.add(ws.playerNum);
        else currentRoom.ready.delete(ws.playerNum);
        if (currentRoom.ready.size === 2 && currentRoom.players[1] && currentRoom.players[2]) {
          currentRoom.started = true;
          broadcast(currentRoom, { type: 'game_started', state: currentRoom.game.getState(), counts: currentRoom.game.getPieceCounts(), revision: currentRoom.revision });
          notify(currentRoom, ws.roomCode, currentRoom.game.currentPlayer, 'turn', 'The game has started. It’s your turn.');
        } else broadcast(currentRoom, lobbyState(currentRoom));
        break;
      }

      case 'move': {
        const room = rooms.get(ws.roomCode);
        if (!room) return sendTo(ws, { type: 'error', error: 'Not in a room' });

        const coord = a => Array.isArray(a) && a.length === 2 && a.every(v => Number.isInteger(v) && v >= 0 && v < 8);
        if (!coord(msg.from) || !coord(msg.to) || msg.revision !== room.revision || !room.started) return sendTo(ws, { type: 'move_result', valid: false, error: 'Board changed or the game has not started. Try again.', state: room.game.getState(), counts: room.game.getPieceCounts(), revision: room.revision });

        // Verify it's this player's turn
        if (room.game.currentPlayer !== ws.playerNum) {
          return sendTo(ws, {
            type: 'move_result',
            valid: false,
            error: 'Not your turn',
          });
        }

        const [fr, fc] = msg.from;
        const [tr, tc] = msg.to;
        const result = room.game.makeMove(fr, fc, tr, tc);
        if (result.valid) room.revision++;
        const counts = room.game.getPieceCounts();

        const payload = {
          type: 'move_result',
          valid: result.valid,
          from: msg.from,
          to: msg.to,
          captured: result.captured,
          promoted: result.promoted,
          continueCapture: result.continueCapture,
          state: result.state,
          counts,
          revision: room.revision,
        };
        if (result.error) payload.error = result.error;

        if (result.valid) {
          broadcast(room, payload);
          if (!result.state.gameOver && result.state.currentPlayer !== ws.playerNum) notify(room, ws.roomCode, result.state.currentPlayer, 'turn', 'Your turn. Tap to return to your table.');
        }
        else sendTo(ws, payload);

        // Check for game over
        if (result.state && result.state.gameOver) {
          broadcast(room, {
            type: 'game_over',
            winner: result.state.winner,
            state: result.state,
            counts,
          });
        }
        break;
      }

      case 'restart': {
        const room = rooms.get(ws.roomCode);
        if (!room) return sendTo(ws, { type: 'error', error: 'Not in a room' });

        if (!room.game.gameOver) return sendTo(ws, { type: 'error', error: 'Finish this game before a rematch' });
        room.rematch.add(ws.playerNum);
        if (room.rematch.size < 2) { broadcast(room, { type: 'rematch_waiting', player: ws.playerNum }); break; }
        room.rematch.clear(); room.revision++;
        room.game.reset();
        notify(room, ws.roomCode, room.game.currentPlayer, 'turn', 'Your rematch has started. It’s your turn.');
        broadcast(room, {
          type: 'game_restarted',
          revision: room.revision,
          state: room.game.getState(),
          counts: room.game.getPieceCounts(),
        });
        break;
      }

      /* ---- Chat & signalling ---- */

      case 'chat': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;
        if (typeof msg.text !== 'string' || !msg.text.trim() || msg.text.length > 1000) return sendTo(ws, { type: 'error', error: 'Message must be 1–1000 characters' });

        if (typeof msg.clientId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(msg.clientId)) return sendTo(ws, { type: 'error', error: 'Invalid message ID', chatError: true });
        const existing = room.history.find(m => m.from === ws.playerNum && m.clientId === msg.clientId);
        if (existing) { sendTo(ws, existing); break; }
        const original = msg.replyTo == null ? null : room.history.find(m => m.id === msg.replyTo);
        if (msg.replyTo != null && !original) return sendTo(ws, { type: 'error', error: 'That message is no longer available to reply to.', chatError: true });
        const message = { type: 'chat', id: room.nextMessageId++, clientId: msg.clientId,
          text: msg.text.trim(), from: ws.playerNum, timestamp: Date.now(),
          reply: original ? { id: original.id, from: original.from, text: original.text.slice(0, 160) } : null };
        room.history.push(message);
        if (room.history.length > 40) room.history.shift();
        broadcast(room, message);
        notify(room, ws.roomCode, ws.playerNum === 1 ? 2 : 1, 'chat', 'Your partner sent a message. Tap to read it.');
        break;
      }

      case 'signal': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;

        const opponent = getOpponent(room, ws.playerNum);
        sendTo(opponent, { type: 'signal', data: msg.data });
        break;
      }

      /* ---- Heartbeat ---- */

      case 'pong': {
        ws.isAlive = true;
        break;
      }

      default:
        sendTo(ws, { type: 'error', error: `Unknown message type: ${msg.type}` });
    }
  });

  /* ---- Connection close ---- */

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room || room.players[ws.playerNum] !== ws) return;

    // Notify opponent
    const opponent = getOpponent(room, ws.playerNum);
    sendTo(opponent, { type: 'opponent_disconnected' });

    // Vacate the slot (don't destroy room yet)
    room.players[ws.playerNum] = null;
    if (!room.started) { room.ready.delete(ws.playerNum); broadcast(room, lobbyState(room)); }

    // If both players are gone, schedule cleanup
    if (!room.players[1] && !room.players[2]) {
      const code = ws.roomCode;
      room.cleanupTimer = setTimeout(() => { rooms.delete(code); }, ROOM_CLEANUP_DELAY_MS);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  Heartbeat: ping every 25 s, terminate unresponsive after 10 s     */
/* ------------------------------------------------------------------ */

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      // Give a final grace window
      setTimeout(() => {
        if (!ws.isAlive) ws.terminate();
      }, HEARTBEAT_TIMEOUT_MS);
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

/* ------------------------------------------------------------------ */
/*  Start                                                             */
/* ------------------------------------------------------------------ */

server.listen(PORT, '0.0.0.0', () => {
  console.log(`PlayTogether server listening on http://0.0.0.0:${server.address().port}`);
});
