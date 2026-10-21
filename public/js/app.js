/**
 * app.js — Entry point.
 *
 * Creates all module instances, wires up DOM events on the landing and
 * waiting views, and connects the WebSocket.
 */
document.addEventListener('DOMContentLoaded', () => {
  /* ─── WebSocket URL ─── */
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const WS_URL = window.BACKEND_URL || `${protocol}//${location.host}`;

  /* ─── Create instances ─── */
  const ws    = new WS(WS_URL);
  const board = new Board('board');
  const chat  = new Chat();
  const voice = new VoiceCall();
  const game  = new Game(ws, board, chat, voice);

  /* ─── Connect ─── */
  ws.connect();

  /* ================================================================
   *  LANDING VIEW
   * ================================================================ */

  const createBtn    = document.getElementById('create-btn');
  const roomInput    = document.getElementById('room-input');
  const joinBtn      = document.getElementById('join-btn');
  const landingError = document.getElementById('landing-error');
  const connectionNote = document.getElementById('connection-note');
  let roomPending = false;
  const availability = () => { createBtn.disabled = joinBtn.disabled = !ws.connected || roomPending || !!ws.token; };
  availability();
  ws.on('connected', () => { connectionNote.textContent = 'Ready when you are'; availability(); });
  ws.on('disconnected', () => { roomPending = false; connectionNote.textContent = 'Reconnecting… your game is held for you'; availability(); });
  ws.on('reconnect_failed', () => { connectionNote.textContent = 'Connection unavailable. Refresh to try again.'; });
  ['room_created', 'room_joined', 'room_closed', 'error'].forEach(type => ws.on(type, () => { roomPending = false; availability(); }));

  createBtn.addEventListener('click', () => {
    landingError.hidden = true;
    roomPending = ws.send({ type: 'create_room' }); availability();
  });

  // Force uppercase, letters only
  roomInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  });

  joinBtn.addEventListener('click', () => {
    const code = roomInput.value.trim().toUpperCase();
    if (code.length !== 4 || !/^[A-Z]{4}$/.test(code)) {
      landingError.textContent = 'Enter a valid 4-letter code';
      landingError.hidden = false;
      return;
    }
    landingError.hidden = true;
    ws.roomCode = code;
    roomPending = ws.send({ type: 'join_room', code }); availability();
  });

  // Allow pressing Enter in the room-code input
  roomInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      joinBtn.click();
    }
  });

  /* ================================================================
   *  WAITING VIEW
   * ================================================================ */

  document.getElementById('copy-btn').addEventListener('click', () => {
    const code = document.getElementById('display-code').textContent;
    const btn  = document.getElementById('copy-btn');
    Promise.resolve().then(() => navigator.clipboard.writeText(code)).then(() => {
      const original = btn.textContent;
      btn.textContent = 'Copied! 💜';
      setTimeout(() => { btn.textContent = original; }, 2000);
    }).catch(() => {
      // Fallback: select the text visually
      const el = document.getElementById('display-code');
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    });
  });

  document.getElementById('back-btn').addEventListener('click', () => {
    ws.send({ type: 'leave_room' }); ws.clearIdentity(); availability();
    game.showView('landing-view');
  });

  /* ================================================================
   *  VOICE CONTROLS
   * ================================================================ */

  const micBtn = document.getElementById('mic-btn');

  micBtn.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    if (!game.ready || !game.opponentConnected) { game.showToast('Voice needs both players connected'); return; }
    if (!voice.isActive) {
      // Start voice — player 1 initiates, player 2 accepts
      voice.init(ws, game.myPlayer === 1);
    } else {
      voice.toggleMute();
    }
  });

  // Long-press to stop call entirely
  let longPressTimer = null;
  let suppressClick = false;
  micBtn.addEventListener('pointerdown', () => {
    if (!voice.isActive) return;
    longPressTimer = setTimeout(() => {
      suppressClick = true;
      voice.stop();
    }, 1000);
  });
  micBtn.addEventListener('pointerup',    () => clearTimeout(longPressTimer));
  micBtn.addEventListener('pointerleave', () => clearTimeout(longPressTimer));
  micBtn.addEventListener('pointercancel', () => { clearTimeout(longPressTimer); suppressClick = false; });

  voice.onStateChange(({ isActive, isMuted }) => {
    if (!isActive) {
      micBtn.classList.remove('active');
      micBtn.textContent = '🎤';
      micBtn.title = 'Both players tap to join voice';
    } else if (isMuted) {
      micBtn.textContent = '🔇';
      micBtn.classList.add('active');
    } else {
      micBtn.textContent = '🎤';
      micBtn.classList.add('active');
    }
  });

  /* ================================================================
   *  GAME OVER
   * ================================================================ */

  document.getElementById('rematch-btn').addEventListener('click', () => {
    game.requestRestart();
  });

  document.getElementById('home-btn').addEventListener('click', () => {
    voice.stop(); ws.send({ type: 'leave_room' }); ws.clearIdentity();
    location.reload();
  });
});
