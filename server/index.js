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
  let urlPath = req.url === '/' ? '/index.html' : req.url;
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

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.playerNum = null;
  ws.roomCode = null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return sendTo(ws, { type: 'error', error: 'Invalid JSON' });
    }

    switch (msg.type) {
      /* ---- Room lifecycle ---- */

      case 'create_room': {
        const code = generateRoomCode();
        const game = new CheckersGame();
        const room = { game, players: { 1: ws, 2: null } };
        rooms.set(code, room);

        ws.playerNum = 1;
        ws.roomCode = code;

        sendTo(ws, { type: 'room_created', code, player: 1 });
        break;
      }

      case 'join_room': {
        const code = (msg.code || '').toUpperCase();
        const room = rooms.get(code);

        if (!room) {
          return sendTo(ws, { type: 'error', error: 'Room not found' });
        }
        if (room.players[2] !== null) {
          return sendTo(ws, { type: 'error', error: 'Room is full' });
        }

        // Cancel any pending cleanup timer
        if (room.cleanupTimer) {
          clearTimeout(room.cleanupTimer);
          room.cleanupTimer = undefined;
        }

        room.players[2] = ws;
        ws.playerNum = 2;
        ws.roomCode = code;

        const state = room.game.getState();
        const counts = room.game.getPieceCounts();

        sendTo(ws, { type: 'room_joined', player: 2, state, counts });
        sendTo(room.players[1], { type: 'player_joined', state, counts });
        break;
      }

      case 'reconnect': {
        const code = (msg.code || '').toUpperCase();
        const player = msg.player;
        const room = rooms.get(code);

        if (!room) {
          return sendTo(ws, { type: 'error', error: 'Room not found' });
        }
        if (player !== 1 && player !== 2) {
          return sendTo(ws, { type: 'error', error: 'Invalid player number' });
        }

        // Cancel any pending cleanup timer
        if (room.cleanupTimer) {
          clearTimeout(room.cleanupTimer);
          room.cleanupTimer = undefined;
        }

        room.players[player] = ws;
        ws.playerNum = player;
        ws.roomCode = code;

        const state = room.game.getState();
        const counts = room.game.getPieceCounts();
        sendTo(ws, { type: 'room_joined', player, state, counts });

        const opponent = getOpponent(room, player);
        sendTo(opponent, { type: 'opponent_reconnected' });
        break;
      }

      /* ---- Gameplay ---- */

      case 'move': {
        const room = rooms.get(ws.roomCode);
        if (!room) return sendTo(ws, { type: 'error', error: 'Not in a room' });

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
        };
        if (result.error) payload.error = result.error;

        broadcast(room, payload);

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

        room.game.reset();
        broadcast(room, {
          type: 'game_restarted',
          state: room.game.getState(),
          counts: room.game.getPieceCounts(),
        });
        break;
      }

      /* ---- Chat & signalling ---- */

      case 'chat': {
        const room = rooms.get(ws.roomCode);
        if (!room) return;

        broadcast(room, {
          type: 'chat',
          text: msg.text,
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
    if (!room) return;

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
  console.log(`PlayTogether server listening on http://0.0.0.0:${PORT}`);
});
