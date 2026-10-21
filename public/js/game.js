/**
 * Game — Main orchestrator.
 *
 * Connects WebSocket events to the Board, Chat and VoiceCall modules.
 * Performs client-side move computation for UI highlighting (server is
 * still authoritative).
 */
class Game {
  /**
   * @param {WS}        ws
   * @param {Board}     board
   * @param {Chat}      chat
   * @param {VoiceCall} voice
   */
  constructor(ws, board, chat, voice) {
    this.ws = ws;
    this.board = board;
    this.chat = chat;
    this.voice = voice;

    /** @type {number|null} Player number (1 or 2) */
    this.myPlayer = null;
    /** @type {string|null} */
    this.roomCode = null;
    this.isMyTurn = false;
    this.gameActive = false;
    /** @type {number[][]|null} Current board state (8×8 ints) */
    this.boardState = null;
    /** @type {number[]|null} */
    this.mustCapture = null;

    this.setupWSHandlers();
    this.setupBoardHandler();
    this.setupChatHandler();
  }

  /* ==================================================================
   *  CLIENT-SIDE MOVE COMPUTATION (for UI highlighting only)
   * ================================================================== */

  /** Piece values belonging to a player. */
  getPlayerValues(player) {
    return player === 1 ? [1, 3] : [2, 4];
  }

  /** Is the cell value an opponent piece? */
  isOpponent(cellVal) {
    return cellVal > 0 && !this.getPlayerValues(this.myPlayer).includes(cellVal);
  }

  /** Is the cell value one of our pieces? */
  isOwnPiece(cellVal) {
    return this.getPlayerValues(this.myPlayer).includes(cellVal);
  }

  /** Is a piece value a king? */
  isKing(val) {
    return val === 3 || val === 4;
  }

  /** Owner of a cell value (1, 2, or 0). */
  ownerOf(val) {
    if (val === 1 || val === 3) return 1;
    if (val === 2 || val === 4) return 2;
    return 0;
  }

  /** Forward row-directions for a piece value. */
  directions(piece) {
    if (this.isKing(piece)) return [-1, 1];
    return this.ownerOf(piece) === 1 ? [-1] : [1];
  }

  inBounds(r, c) {
    return r >= 0 && r < 8 && c >= 0 && c < 8;
  }

  /**
   * Compute valid moves for a piece (client-side, mirrors server logic).
   * Used only for showing move indicators — the server validates all moves.
   */
  computeValidMoves(row, col) {
    if (!this.boardState) return [];
    const piece = this.boardState[row][col];
    if (!piece || !this.isOwnPiece(piece)) return [];

    if (this.hasAnyCaptures()) {
      return this.getCaptures(row, col, piece);
    }
    return this.getSimpleMoves(row, col, piece);
  }

  getCaptures(row, col, piece) {
    const dirs = this.directions(piece);
    const captures = [];

    for (const dr of dirs) {
      for (const dc of [-1, 1]) {
        const mr = row + dr;
        const mc = col + dc;
        const lr = row + dr * 2;
        const lc = col + dc * 2;
        if (!this.inBounds(lr, lc)) continue;
        if (!this.isOpponent(this.boardState[mr][mc])) continue;
        if (this.boardState[lr][lc] !== 0) continue;
        captures.push({ to: [lr, lc], captures: [[mr, mc]] });
      }
    }
    return captures;
  }

  getSimpleMoves(row, col, piece) {
    const dirs = this.directions(piece);
    const moves = [];

    for (const dr of dirs) {
      for (const dc of [-1, 1]) {
        const nr = row + dr;
        const nc = col + dc;
        if (this.inBounds(nr, nc) && this.boardState[nr][nc] === 0) {
          moves.push({ to: [nr, nc], captures: [] });
        }
      }
    }
    return moves;
  }

  /** Does the current player have any capture anywhere? */
  hasAnyCaptures() {
    if (!this.boardState) return false;
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const val = this.boardState[r][c];
        if (!val || !this.isOwnPiece(val)) continue;
        if (this.getCaptures(r, c, val).length > 0) return true;
      }
    }
    return false;
  }

  /* ==================================================================
   *  WEBSOCKET HANDLERS
   * ================================================================== */

  setupWSHandlers() {
    const ws = this.ws;

    ws.on('room_created', (data) => {
      this.myPlayer = data.player;
      this.roomCode = data.code;
      ws.setIdentity(data.code, data.player);
      this.showView('waiting-view');
      document.getElementById('display-code').textContent = data.code;
    });

    ws.on('room_joined', (data) => {
      this.myPlayer = data.player;
      this.roomCode = ws.roomCode || data.code;
      ws.setIdentity(this.roomCode, data.player);
      this.startGame(data.state, data.counts);
    });

    ws.on('player_joined', (data) => {
      this.startGame(data.state, data.counts);
    });

    ws.on('move_result', (data) => {
      if (data.valid) {
        this.boardState = data.state.board;
        this.mustCapture = data.state.mustCapture;
        this.board.setState(data.state.board, data.state.currentPlayer, this.myPlayer, data.state.mustCapture);
        if (data.from && data.to) this.board.setLastMove(data.from, data.to);
        this.updateScores(data.counts);
        this.updateTurn(data.state);
      } else {
        this.board.clearSelection();
      }
    });

    ws.on('chat', (data) => {
      this.chat.addMessage(data.text, data.from, data.from === this.myPlayer, data.timestamp);
    });

    ws.on('signal', (data) => {
      this.voice.handleSignal(data.data);
    });

    ws.on('game_over', (data) => {
      this.boardState = data.state.board;
      this.board.setState(data.state.board, data.state.currentPlayer, this.myPlayer, null);
      this.updateScores(data.counts);
      this.gameActive = false;

      const overlay = document.getElementById('game-over-overlay');
      document.getElementById('winner-text').textContent =
        data.winner === this.myPlayer ? 'You win! 🎉' : 'They win! 💜';
      overlay.classList.add('visible');
      overlay.hidden = false;

      const ti = document.getElementById('turn-indicator');
      ti.textContent = data.winner === this.myPlayer ? 'Victory!' : 'Next time!';
      ti.className = 'turn-indicator game-over-turn';
    });

    ws.on('opponent_disconnected', () => {
      this.chat.addSystemMessage('Opponent disconnected...');
      document.getElementById('connection-dot').className = 'status-dot disconnected';
    });

    ws.on('opponent_reconnected', () => {
      this.chat.addSystemMessage('Opponent reconnected! 💜');
      document.getElementById('connection-dot').className = 'status-dot connected';
    });

    ws.on('game_restarted', (data) => {
      const overlay = document.getElementById('game-over-overlay');
      overlay.classList.remove('visible');
      overlay.hidden = true;
      this.startGame(data.state, data.counts);
    });

    ws.on('connected', () => {
      const dot = document.getElementById('connection-dot');
      if (dot) dot.className = 'status-dot connected';
    });

    ws.on('disconnected', () => {
      const dot = document.getElementById('connection-dot');
      if (dot) dot.className = 'status-dot reconnecting';
    });

    ws.on('error', (data) => {
      const errEl = document.getElementById('landing-error');
      if (errEl) {
        errEl.textContent = data.error || data.message || 'Something went wrong';
        errEl.hidden = false;
      }
    });
  }

  /* ==================================================================
   *  BOARD CLICK & DRAG HANDLERS
   * ================================================================== */

  setupBoardHandler() {
    // Tap to move / select
    this.board.onCellClick((row, col) => {
      if (!this.gameActive || !this.boardState) return;

      const cell = this.boardState[row][col];

      if (!this.isMyTurn) {
        if (this.isOwnPiece(cell)) {
          this.showToast("It's your partner's turn ●");
        }
        return;
      }

      if (this.board.selectedCell) {
        const [sr, sc] = this.board.selectedCell;

        // Clicked the same piece — deselect
        if (row === sr && col === sc) {
          this.board.clearSelection();
          return;
        }

        // Clicked another own piece — reselect (unless multi-jump mustCapture restricts)
        if (this.isOwnPiece(cell)) {
          if (this.mustCapture &&
              (this.mustCapture[0] !== row || this.mustCapture[1] !== col)) {
            this.showToast('Must complete multi-jump! ⚔️');
            return;
          }
          this.selectPiece(row, col);
          return;
        }

        // Clicked a non-own cell — try to move there
        const validMove = this.board.validMoves.find(
          (m) => m.to[0] === row && m.to[1] === col
        );
        if (validMove) {
          this.ws.send({ type: 'move', from: [sr, sc], to: [row, col] });
          this.board.clearSelection();
        } else {
          this.board.clearSelection();
        }
      } else {
        // No piece selected yet
        if (!this.isOwnPiece(cell)) return;

        // Must-capture constraint
        if (this.mustCapture &&
            (this.mustCapture[0] !== row || this.mustCapture[1] !== col)) {
          this.showToast('Must complete multi-jump! ⚔️');
          return;
        }

        this.selectPiece(row, col);
      }
    });

    // Drag-and-drop piece sliding across tiles
    this.board.onMoveAttempt((fromRow, fromCol, toRow, toCol) => {
      if (!this.gameActive || !this.boardState) return;

      if (!this.isMyTurn) {
        this.showToast("It's your partner's turn ●");
        return;
      }

      // Check if fromRow, fromCol is own piece
      const piece = this.boardState[fromRow][fromCol];
      if (!this.isOwnPiece(piece)) return;

      // Check mustCapture constraint
      if (this.mustCapture &&
          (this.mustCapture[0] !== fromRow || this.mustCapture[1] !== fromCol)) {
        this.showToast('Must complete multi-jump! ⚔️');
        return;
      }

      // Get valid moves for source piece
      const validMoves = this.computeValidMoves(fromRow, fromCol);
      const matched = validMoves.find(m => m.to[0] === toRow && m.to[1] === toCol);

      if (matched) {
        this.ws.send({ type: 'move', from: [fromRow, fromCol], to: [toRow, toCol] });
        this.board.clearSelection();
      } else {
        if (this.hasAnyCaptures() && matched === undefined) {
          this.showToast('Jump capture is forced! ⚔️');
        }
        this.board.render();
      }
    });
  }

  showToast(text) {
    let toast = document.getElementById('game-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'game-toast';
      toast.className = 'game-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add('visible');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, 2200);
  }

  selectPiece(row, col) {
    this.board.setSelected(row, col);
    const moves = this.computeValidMoves(row, col);
    if (moves.length === 0 && this.hasAnyCaptures()) {
      this.showToast('Another piece must capture! ⚔️');
    }
    this.board.setValidMoves(moves);
  }

  /* ==================================================================
   *  CHAT HANDLER
   * ================================================================== */

  setupChatHandler() {
    this.chat.onSend((text) => {
      this.ws.send({ type: 'chat', text });
    });
  }

  /* ==================================================================
   *  GAME FLOW
   * ================================================================== */

  startGame(state, counts) {
    this.showView('game-view');
    this.gameActive = true;
    this.boardState = state.board;
    this.mustCapture = state.mustCapture;
    this.board.setState(state.board, state.currentPlayer, this.myPlayer, state.mustCapture);
    this.updateTurn(state);
    this.updateScores(counts);
    document.getElementById('game-room-code').textContent = this.roomCode;
    document.getElementById('connection-dot').className = 'status-dot connected';

    // Resize board after the game view is displayed
    setTimeout(() => this.board.resize(), 50);
  }

  updateTurn(state) {
    this.isMyTurn = state.currentPlayer === this.myPlayer;
    this.mustCapture = state.mustCapture;
    const el = document.getElementById('turn-indicator');
    el.textContent = this.isMyTurn ? 'Your turn ●' : 'Their turn ○';
    el.className = 'turn-indicator ' + (this.isMyTurn ? 'your-turn' : 'their-turn');

    // Auto-select must-capture piece
    if (this.isMyTurn && state.mustCapture) {
      this.selectPiece(state.mustCapture[0], state.mustCapture[1]);
    }
  }

  updateScores(counts) {
    if (!counts) return;
    document.getElementById('p1-score').textContent = '● ' + counts[1];
    document.getElementById('p2-score').textContent = '● ' + counts[2];
  }

  /**
   * Show one view and hide the others.
   * @param {'landing-view'|'waiting-view'|'game-view'} viewId
   */
  showView(viewId) {
    ['landing-view', 'waiting-view', 'game-view'].forEach((id) => {
      const el = document.getElementById(id);
      if (id === viewId) {
        el.style.display = id === 'game-view' ? 'flex' : '';
      } else {
        el.style.display = 'none';
      }
    });
  }

  /** Send a restart (rematch) request to the server. */
  requestRestart() {
    this.ws.send({ type: 'restart' });
  }
}

window.Game = Game;
