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

/* ------------------------------------------------------------------ */
/*  Configuration                                                     */
/* ------------------------------------------------------------------ */

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '../public/');
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;
const ROOM_CLEANUP_DELAY_MS = 5 * 60 * 1000; // 5 minutes

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

/* ------------------------------------------------------------------ */
/*  HTTP static-file server                                           */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  // Map "/" to "/index.html"
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  // Strip query string
  urlPath = urlPath.split('?')[0];

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

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.playerNum = null;
  ws.roomCode = null;
  ws.on('error', () => {});
  let messageWindow = Date.now(), messageCount = 0;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
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
    if (['move', 'restart', 'chat', 'signal'].includes(msg.type) && !isMember) return sendTo(ws, { type: 'error', error: 'Not in a room' });
    if (['join_room', 'reconnect'].includes(msg.type) && (typeof msg.code !== 'string' || !/^[a-z]{4}$/i.test(msg.code))) return sendTo(ws, { type: 'error', error: 'Invalid room code' });
    switch (msg.type) {
      /* ---- Room lifecycle ---- */

      case 'create_room': {
        if (rooms.size >= 1000) return sendTo(ws, { type: 'error', error: 'Rooms are busy. Try later.' });
        const code = generateRoomCode();
        const game = new CheckersGame();
        const room = { game, players: { 1: ws, 2: null }, tokens: { 1: randomBytes(24).toString('hex'), 2: null }, revision: 0, rematch: new Set() };
        rooms.set(code, room);

        ws.playerNum = 1;
        ws.roomCode = code;

        sendTo(ws, { type: 'room_created', code, player: 1, token: room.tokens[1] });
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

        const state = room.game.getState();
        const counts = room.game.getPieceCounts();

        sendTo(ws, { type: 'room_joined', code, player: 2, token: room.tokens[2], state, counts, revision: room.revision, started: true, opponentConnected: !!room.players[1] });
        sendTo(room.players[1], { type: 'player_joined', state, counts });
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

        const state = room.game.getState();
        const counts = room.game.getPieceCounts();
        sendTo(ws, { type: 'room_joined', code, player, token: room.tokens[player], state, counts, revision: room.revision, started: !!room.tokens[2], opponentConnected: !!getOpponent(room, player) });

        const opponent = getOpponent(room, player);
        sendTo(opponent, { type: 'opponent_reconnected' });
        break;
      }

      /* ---- Gameplay ---- */

      case 'leave_room': {
        if (!isMember) break;
        clearTimeout(currentRoom.cleanupTimer);
        broadcast(currentRoom, { type: 'room_closed', error: 'The room was closed. Start a new game when you are ready.' });
        rooms.delete(ws.roomCode);
        for (const socket of Object.values(currentRoom.players)) if (socket) { socket.roomCode = null; socket.playerNum = null; }
        break;
      }

      case 'move': {
        const room = rooms.get(ws.roomCode);
        if (!room) return sendTo(ws, { type: 'error', error: 'Not in a room' });

        const coord = a => Array.isArray(a) && a.length === 2 && a.every(v => Number.isInteger(v) && v >= 0 && v < 8);
        if (!coord(msg.from) || !coord(msg.to) || msg.revision !== room.revision || !room.players[1] || !room.players[2]) return sendTo(ws, { type: 'move_result', valid: false, error: 'Board changed or partner disconnected. Try again when connected.', state: room.game.getState(), counts: room.game.getPieceCounts(), revision: room.revision });

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

        if (result.valid) broadcast(room, payload);
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

        broadcast(room, {
          type: 'chat',
          text: msg.text.trim(),
          from: ws.playerNum,
          timestamp: Date.now(),
        });
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

    // If both players are gone, schedule cleanup
    if (!room.players[1] && !room.players[2]) {
      room.cleanupTimer = setTimeout(() => {
        rooms.delete(ws.roomCode);
      }, ROOM_CLEANUP_DELAY_MS);
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
