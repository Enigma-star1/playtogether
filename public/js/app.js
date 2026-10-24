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
  const away = new Away(ws, game);
  game.away = away;
  // Reuse one chat panel in the lobby and in the game.
  document.body.appendChild(chat.section);
  game.showView('landing-view');

  window.ws = ws;
  window.board = board;
  window.chat = chat;
  window.voice = voice;
  window.game = game;

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
  const availability = () => {
    createBtn.disabled = joinBtn.disabled = !ws.connected || roomPending || !!ws.token;
    document.getElementById('resume-panel').hidden = !ws.token || ws.autoRejoin;
    document.getElementById('resume-label').textContent = `Your seat at table ${ws.roomCode} is saved.`;
    document.getElementById('resume-btn').disabled = !ws.connected || roomPending;
    document.getElementById('leave-saved-btn').disabled = roomPending;
    if (ws.leaving) connectionNote.textContent = 'Leaving your room when the connection returns…';
  };
  availability();
  ws.on('connected', () => { connectionNote.textContent = ws.autoRejoin ? 'Returning to your table…' : 'Ready when you are'; availability(); });
  ws.on('disconnected', () => { roomPending = false; connectionNote.textContent = 'Reconnecting… your game is held for you'; availability(); });
  ws.on('reconnect_failed', () => { connectionNote.textContent = 'Connection unavailable. Refresh to try again.'; });
  ['room_created', 'room_joined', 'room_closed', 'error'].forEach(type => ws.on(type, () => {
    roomPending = false;
    if (!ws.token) connectionNote.textContent = ws.connected ? 'Ready when you are' : 'Connecting…';
    availability();
  }));
  document.getElementById('resume-btn').addEventListener('click', () => {
    landingError.hidden = true; roomPending = ws.resume(); availability();
    connectionNote.textContent = 'Restoring your seat…';
  });
  const params = new URLSearchParams(location.search);
  const inviteCode = params.get('room')?.toUpperCase();
  if (/^[A-Z]{4}$/.test(inviteCode)) roomInput.value = inviteCode;
  const resumeNotification = code => {
    if (ws.token && ws.roomCode === code && !ws.autoRejoin && ws.connected) document.getElementById('resume-btn').click();
  };
  ws.on('connected', () => { if (params.get('resume') === '1') resumeNotification(inviteCode); });
  navigator.serviceWorker?.addEventListener('message', event => {
    if (event.data?.type === 'resume_table') resumeNotification(event.data.code);
  });

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
    const invite = new URL(location.pathname, location.origin); invite.searchParams.set('room', code);
    Promise.resolve().then(() => navigator.clipboard.writeText(invite.href)).then(() => {
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

  const leaveOverlay = document.getElementById('leave-overlay');
  let previousFocus;
  const closeLeave = () => { leaveOverlay.hidden = true; leaveOverlay.classList.remove('visible'); previousFocus?.focus(); };
  const askLeave = () => {
    previousFocus = document.activeElement;
    leaveOverlay.hidden = false; leaveOverlay.classList.add('visible');
    document.getElementById('cancel-leave-btn').focus();
  };
  ['back-btn', 'leave-btn', 'leave-saved-btn', 'home-btn'].forEach(id => document.getElementById(id).addEventListener('click', askLeave));
  document.getElementById('cancel-leave-btn').addEventListener('click', closeLeave);
  leaveOverlay.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLeave();
    if (e.key === 'Tab') {
      e.preventDefault();
      document.getElementById(document.activeElement.id === 'cancel-leave-btn' ? 'confirm-leave-btn' : 'cancel-leave-btn').focus();
    }
  });
  document.getElementById('confirm-leave-btn').addEventListener('click', () => {
    closeLeave(); voice.stop(); ws.leaveRoom(); game.resetRoom(); availability();
  });
  document.getElementById('ready-btn').addEventListener('click', () => {
    if (ws.send({ type: 'ready', ready: !game.lobbyReady })) document.getElementById('ready-btn').disabled = true;
  });
  const soundBtn = document.getElementById('sound-btn');
  const updateSound = () => { soundBtn.textContent = chat.soundEnabled ? 'Sound on' : 'Sound off'; soundBtn.setAttribute('aria-pressed', String(chat.soundEnabled)); };
  updateSound();
  soundBtn.addEventListener('click', () => {
    chat.soundEnabled = !chat.soundEnabled; updateSound();
    try { localStorage.setItem('playtogether-sound', chat.soundEnabled ? 'on' : 'off'); } catch (_) {}
    if (chat.soundEnabled) { chat.unlockAudio(); chat.playChime('turn'); }
    else chat.audioContext?.suspend().catch(() => {});
  });

  /* ================================================================
   *  VOICE CONTROLS
   * ================================================================ */

  const micBtn = document.getElementById('mic-btn');

  micBtn.addEventListener('click', () => {
    if (suppressClick) { suppressClick = false; return; }
    if (!game.ready || !game.opponentConnected) { game.showToast('Voice needs both players connected'); return; }
    
    // Clear incoming call ring if we're answering
    micBtn.classList.remove('incoming-call');

    if (!voice.isActive) {
      voice.unlockAudio();
      // Start voice — player 1 initiates, player 2 accepts
      voice.init(ws, game.myPlayer === 1);
    } else {
      voice.toggleMute();
    }
  });

  // Incoming call notification
  voice.onIncomingCall((isIncoming) => {
    if (isIncoming && !voice.isActive) {
      micBtn.classList.add('incoming-call');
      micBtn.title = 'Partner is calling! Tap to join voice';
      game.showToast('📞 Partner is on voice call — Tap 🎤 to join!');
      if (navigator.vibrate) {
        try { navigator.vibrate([100, 80, 100]); } catch (_) {}
      }
    } else {
      micBtn.classList.remove('incoming-call');
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
      game.showToast('Voice call ended');
    }, 1000);
  });
  micBtn.addEventListener('pointerup',    () => clearTimeout(longPressTimer));
  micBtn.addEventListener('pointerleave', () => clearTimeout(longPressTimer));
  micBtn.addEventListener('pointercancel', () => { clearTimeout(longPressTimer); suppressClick = false; });

  let wasConnected = false;
  voice.onStateChange(({ isActive, isConnected, isMuted, isRelay }) => {
    if (!isActive) {
      micBtn.classList.remove('active', 'connected', 'incoming-call');
      micBtn.textContent = '🎤';
      micBtn.title = 'Tap to start voice call';
      wasConnected = false;
    } else {
      micBtn.classList.remove('incoming-call');
      micBtn.classList.add('active');

      if (isConnected) {
        micBtn.classList.add('connected');
        micBtn.textContent = isMuted ? '🔇' : '🎙️';
        micBtn.title = isMuted ? 'Muted — Tap to unmute' : 'Connected — Tap to mute, hold to hang up';
        if (!wasConnected) {
          game.showToast(isRelay ? 'Voice connected! 🎙️' : 'Voice connected (P2P)! 🎙️');
          wasConnected = true;
        }
      } else {
        micBtn.classList.remove('connected');
        micBtn.textContent = '🎤';
        micBtn.title = 'Connecting voice...';
      }
    }
  });

  /* ================================================================
   *  GAME OVER
   * ================================================================ */

  document.getElementById('rematch-btn').addEventListener('click', () => {
    game.requestRestart();
  });

});
