/**
 * Board — Canvas-rendered checkers board with touch/click input
 * and automatic board flipping so each player sees their pieces at the bottom.
 *
 * Playable squares satisfy (row + col) % 2 === 1.
 * Cell values: 0=empty, 1=P1 man, 2=P2 man, 3=P1 king, 4=P2 king.
 */
class Board {
  /**
   * @param {string} canvasId  The id attribute of the <canvas> element
   */
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext('2d');

    /* ── colour palette ── */
    this.LIGHT_SQ          = '#D2B48C';
    this.DARK_SQ           = '#8B5E3C';
    this.P1_COLOR          = '#FF6B6B';
    this.P1_STROKE         = '#cc4444';
    this.P2_COLOR          = '#3a3a52';
    this.P2_STROKE         = '#5a5a72';
    this.KING_ACCENT       = '#FFD700';
    this.SELECTED_HIGHLIGHT = 'rgba(187,134,252,0.35)';
    this.VALID_DOT         = 'rgba(187,134,252,0.6)';
    this.CAPTURE_DOT       = 'rgba(255,107,107,0.6)';
    this.LAST_MOVE         = 'rgba(187,134,252,0.15)';

    /* ── state ── */
    /** @type {number[][]|null} */
    this.board = null;
    /** @type {number|null} */
    this.myPlayer = null;
    /** @type {number|null} */
    this.currentPlayer = null;
    /** @type {number[]|null} */
    this.selectedCell = null;
    /** @type {Array<{to:number[], captures:number[][]}>} */
    this.validMoves = [];
    /** @type {number[]|null} */
    this.mustCapture = null;
    /** @type {{from:number[], to:number[]}|null} */
    this.lastMove = null;
    /** @type {Function|null} */
    this.clickCallback = null;

    this.cellSize = 0;
    this.setupCanvas();
    this.addEventListeners();
  }

  /* ─────────── coordinate transforms (board flipping) ─────────── */

  /**
   * Board coords → display coords.
   * P1 sees the board normally; P2 sees it flipped 180°.
   */
  toDisplay(row, col) {
    if (this.myPlayer === 2) return [7 - row, 7 - col];
    return [row, col];
  }

  /** Display coords → board coords (the transform is its own inverse). */
  toBoard(displayRow, displayCol) {
    if (this.myPlayer === 2) return [7 - displayRow, 7 - displayCol];
    return [displayRow, displayCol];
  }

  /* ─────────── canvas sizing ─────────── */

  setupCanvas() {
    const container = this.canvas.parentElement;
    const availableWidth = container.clientWidth || (container.parentElement ? container.parentElement.clientWidth : 0) || 360;
    const size = Math.max(Math.min(availableWidth, 520), 280);
    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.canvas.style.width = size + 'px';
    this.canvas.style.height = size + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.cellSize = size / 8;

    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const container = this.canvas.parentElement;
    const availableWidth = container.clientWidth || (container.parentElement ? container.parentElement.clientWidth : 0) || 360;
    const size = Math.max(Math.min(availableWidth, 520), 280);
    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.canvas.style.width = size + 'px';
    this.canvas.style.height = size + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.cellSize = size / 8;
    this.render();
  }

  /* ─────────── input ─────────── */

  addEventListeners() {
    let lastInputTime = 0;

    const handleInput = (clientX, clientY) => {
      const now = Date.now();
      if (now - lastInputTime < 100) return; // Debounce double-firing events (touch + click)
      lastInputTime = now;

      const rect = this.canvas.getBoundingClientRect();
      const cs = rect.width / 8;
      if (cs <= 0) return;

      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const displayCol = Math.floor(x / cs);
      const displayRow = Math.floor(y / cs);

      if (displayRow < 0 || displayRow > 7 || displayCol < 0 || displayCol > 7) return;

      const cell = this.toBoard(displayRow, displayCol);
      if (cell && this.clickCallback) {
        this.clickCallback(cell[0], cell[1]);
      }
    };

    // Use pointerdown for instant, responsive input without tap delay or double firing
    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handleInput(e.clientX, e.clientY);
    });
  }

  /**
   * Register a callback invoked with (boardRow, boardCol) on cell click/tap.
   * @param {Function} cb
   */
  onCellClick(cb) {
    this.clickCallback = cb;
  }

  /* ─────────── state mutators ─────────── */

  setState(board, currentPlayer, myPlayer, mustCapture) {
    this.board = board;
    this.currentPlayer = currentPlayer;
    this.myPlayer = myPlayer;
    this.mustCapture = mustCapture;
    this.clearSelection();
  }

  setSelected(row, col) {
    this.selectedCell = [row, col];
    this.render();
  }

  setValidMoves(moves) {
    this.validMoves = moves;
    this.render();
  }

  clearSelection() {
    this.selectedCell = null;
    this.validMoves = [];
    this.render();
  }

  setLastMove(from, to) {
    this.lastMove = { from, to };
  }

  /* ─────────── rendering ─────────── */

  render() {
    if (!this.board) return;

    const ctx = this.ctx;
    const cs = this.cellSize;
    const boardPx = cs * 8;

    // 1. Clear
    ctx.fillStyle = this.LIGHT_SQ;
    ctx.fillRect(0, 0, boardPx, boardPx);

    // 2. Draw squares
    for (let dr = 0; dr < 8; dr++) {
      for (let dc = 0; dc < 8; dc++) {
        ctx.fillStyle = (dr + dc) % 2 === 0 ? this.LIGHT_SQ : this.DARK_SQ;
        ctx.fillRect(dc * cs, dr * cs, cs, cs);
      }
    }

    // 3. Last-move highlights
    if (this.lastMove) {
      ctx.fillStyle = this.LAST_MOVE;
      const [fr, fc] = this.toDisplay(this.lastMove.from[0], this.lastMove.from[1]);
      ctx.fillRect(fc * cs, fr * cs, cs, cs);
      const [tr, tc] = this.toDisplay(this.lastMove.to[0], this.lastMove.to[1]);
      ctx.fillRect(tc * cs, tr * cs, cs, cs);
    }

    // 4. Selected cell highlight
    if (this.selectedCell) {
      ctx.fillStyle = this.SELECTED_HIGHLIGHT;
      const [sr, sc] = this.toDisplay(this.selectedCell[0], this.selectedCell[1]);
      ctx.fillRect(sc * cs, sr * cs, cs, cs);
    }

    // 5. Valid move indicators
    for (const move of this.validMoves) {
      const [mr, mc] = this.toDisplay(move.to[0], move.to[1]);
      const cx = mc * cs + cs / 2;
      const cy = mr * cs + cs / 2;
      const dotRadius = cs * 0.15;

      ctx.beginPath();
      ctx.arc(cx, cy, dotRadius, 0, Math.PI * 2);
      ctx.fillStyle = move.captures && move.captures.length > 0
        ? this.CAPTURE_DOT
        : this.VALID_DOT;
      ctx.fill();
    }

    // 6. Pieces
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const val = this.board[r][c];
        if (val === 0) continue;

        const [dr, dc] = this.toDisplay(r, c);
        const cx = dc * cs + cs / 2;
        const cy = dr * cs + cs / 2;
        const radius = cs * 0.38;

        // Determine colours
        const isP1 = val === 1 || val === 3;
        const fill = isP1 ? this.P1_COLOR : this.P2_COLOR;
        const stroke = isP1 ? this.P1_STROKE : this.P2_STROKE;

        // Main disc
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.stroke();

        // King badge
        if (val === 3 || val === 4) {
          ctx.fillStyle = this.KING_ACCENT;
          ctx.font = `bold ${Math.round(cs * 0.36)}px serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('♛', cx, cy + 1);
        }
      }
    }
  }
}

window.Board = Board;
