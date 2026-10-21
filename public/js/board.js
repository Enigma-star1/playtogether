/**
 * Board — Canvas-rendered checkers board with touch/click input,
 * drag-and-drop piece sliding, and automatic board flipping.
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
    this.LIGHT_SQ           = '#F4DEC1';
    this.DARK_SQ            = '#AD846D';
    this.P1_COLOR           = '#F17C69';
    this.P1_STROKE          = '#cc4444';
    this.P2_COLOR           = '#483B62';
    this.P2_STROKE          = '#5a5a72';
    this.KING_ACCENT        = '#FFD700';
    this.SELECTED_HIGHLIGHT = 'rgba(187,134,252,0.45)';
    this.VALID_DOT          = 'rgba(187,134,252,0.85)';
    this.CAPTURE_DOT        = 'rgba(255,107,107,0.9)';
    this.LAST_MOVE          = 'rgba(187,134,252,0.2)';
    this.DRAG_HOVER         = 'rgba(63,185,80,0.4)';

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
    /** @type {Function|null} */
    this.moveCallback = null;

    /* ── drag and drop state ── */
    this.dragged = null; // { boardRow, boardCol, displayRow, displayCol, piece, x, y, startX, startY, isDragging }
    this.hoverCell = null; // [displayRow, displayCol] under drag pointer

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
    const size = Math.max(1, availableWidth);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

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
    const size = Math.max(1, availableWidth);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    this.canvas.width = size * dpr;
    this.canvas.height = size * dpr;
    this.canvas.style.width = size + 'px';
    this.canvas.style.height = size + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.cellSize = size / 8;
    this.render();
  }

  /* ─────────── input & drag handling ─────────── */

  addEventListeners() {
    const getPos = (clientX, clientY) => {
      const rect = this.canvas.getBoundingClientRect();
      const cs = rect.width / 8;
      if (cs <= 0) return null;
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const displayCol = Math.floor(x / cs);
      const displayRow = Math.floor(y / cs);
      if (displayRow < 0 || displayRow > 7 || displayCol < 0 || displayCol > 7) return null;
      return {
        x, y, cs,
        displayRow, displayCol,
        boardCell: this.toBoard(displayRow, displayCol),
      };
    };

    // Pointer down: initiate drag or selection
    this.canvas.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}

      const pos = getPos(e.clientX, e.clientY);
      if (!pos || !this.board) return;

      const [br, bc] = pos.boardCell;
      const piece = this.board[br][bc];

      this.dragged = {
        boardRow: br,
        boardCol: bc,
        displayRow: pos.displayRow,
        displayCol: pos.displayCol,
        piece: piece,
        x: pos.x,
        y: pos.y,
        startX: pos.x,
        startY: pos.y,
        isDragging: false,
        pointerId: e.pointerId,
      };

      // Notify click handler immediately so piece is selected & valid moves show up
      if (this.clickCallback) {
        this.clickCallback(br, bc);
      }
    });

    // Pointer move: update dragging piece position
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragged || this.dragged.pointerId !== e.pointerId) return;
      e.preventDefault();

      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const dx = x - this.dragged.startX;
      const dy = y - this.dragged.startY;

      // Only treat as drag if finger/mouse moved more than 8 pixels
      if (!this.dragged.isDragging && Math.hypot(dx, dy) > 8) {
        this.dragged.isDragging = true;
      }

      this.dragged.x = x;
      this.dragged.y = y;

      const cs = rect.width / 8;
      const dCol = Math.floor(x / cs);
      const dRow = Math.floor(y / cs);
      if (dRow >= 0 && dRow < 8 && dCol >= 0 && dCol < 8) {
        this.hoverCell = [dRow, dCol];
      } else {
        this.hoverCell = null;
      }

      if (this.dragged.isDragging) {
        this.render();
      }
    });

    // Pointer up: complete move or finish tap
    const handlePointerUp = (e) => {
      if (!this.dragged || this.dragged.pointerId !== e.pointerId) return;
      e.preventDefault();

      try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}

      const wasDragging = this.dragged.isDragging;
      const startBRow = this.dragged.boardRow;
      const startBCol = this.dragged.boardCol;

      const pos = getPos(e.clientX, e.clientY);
      this.dragged = null;
      this.hoverCell = null;

      if (wasDragging && pos) {
        const [targetRow, targetCol] = pos.boardCell;
        // If dropped onto a different tile, attempt the move
        if (targetRow !== startBRow || targetCol !== startBCol) {
          if (this.moveCallback) {
            this.moveCallback(startBRow, startBCol, targetRow, targetCol);
          } else if (this.clickCallback) {
            this.clickCallback(targetRow, targetCol);
          }
        }
      }

      this.render();
    };

    this.canvas.addEventListener('pointerup', handlePointerUp);
    this.canvas.addEventListener('pointercancel', () => { this.dragged = null; this.hoverCell = null; this.render(); });
  }

  /** Register callback for tap on tile (row, col) */
  onCellClick(cb) {
    this.clickCallback = cb;
  }

  /** Register callback for drag move attempt (fromRow, fromCol, toRow, toCol) */
  onMoveAttempt(cb) {
    this.moveCallback = cb;
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
    this.validMoves = moves || [];
    this.render();
  }

  clearSelection() {
    this.selectedCell = null;
    this.validMoves = [];
    this.render();
  }

  setLastMove(from, to) {
    this.lastMove = { from, to };
    this.render();
  }

  /* ─────────── rendering ─────────── */

  render() {
    if (!this.board) return;

    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const cs = (rect.width > 0 ? rect.width : this.cellSize * 8) / 8;
    this.cellSize = cs;
    const boardPx = cs * 8;

    // 1. Clear board
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

    // 5. Valid move indicators & hover snap
    for (const move of this.validMoves) {
      const [mr, mc] = this.toDisplay(move.to[0], move.to[1]);
      const cx = mc * cs + cs / 2;
      const cy = mr * cs + cs / 2;

      // If dragging and hovering over this valid tile, highlight tile
      if (this.hoverCell && this.hoverCell[0] === mr && this.hoverCell[1] === mc) {
        ctx.fillStyle = this.DRAG_HOVER;
        ctx.fillRect(mc * cs, mr * cs, cs, cs);
      }

      // Draw dot/ring indicator
      const isCapture = move.captures && move.captures.length > 0;
      ctx.beginPath();
      ctx.arc(cx, cy, cs * (isCapture ? 0.22 : 0.16), 0, Math.PI * 2);
      ctx.fillStyle = isCapture ? this.CAPTURE_DOT : this.VALID_DOT;
      ctx.fill();

      // Outer pulsing ring for captures
      if (isCapture) {
        ctx.beginPath();
        ctx.arc(cx, cy, cs * 0.32, 0, Math.PI * 2);
        ctx.strokeStyle = this.CAPTURE_DOT;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // 6. Draw stationary pieces
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const val = this.board[r][c];
        if (val === 0) continue;

        // If piece is currently being actively dragged, draw it as a ghost on origin square
        const isBeingDragged = this.dragged && this.dragged.isDragging &&
                               this.dragged.boardRow === r && this.dragged.boardCol === c;

        const [dr, dc] = this.toDisplay(r, c);
        const cx = dc * cs + cs / 2;
        const cy = dr * cs + cs / 2;
        const radius = cs * 0.38;

        this.drawPiece(ctx, cx, cy, radius, val, isBeingDragged ? 0.35 : 1.0);
      }
    }

    // 7. Draw floating dragged piece above all other pieces
    if (this.dragged && this.dragged.isDragging && this.dragged.piece > 0) {
      const radius = cs * 0.42; // slightly larger while lifted
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 6;
      this.drawPiece(ctx, this.dragged.x, this.dragged.y, radius, this.dragged.piece, 1.0);
      ctx.restore();
    }
  }

  drawPiece(ctx, cx, cy, radius, val, opacity = 1.0) {
    const isP1 = val === 1 || val === 3;
    const fill = isP1 ? this.P1_COLOR : this.P2_COLOR;
    const stroke = isP1 ? this.P1_STROKE : this.P2_STROKE;

    ctx.save();
    ctx.globalAlpha = opacity;

    // Piece body
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 3;
    ctx.stroke();

    // Inner bevel circle for a premium physical checker feel
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.68, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // King crown
    if (val === 3 || val === 4) {
      ctx.fillStyle = this.KING_ACCENT;
      ctx.font = `bold ${Math.round(radius * 1.1)}px serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('♛', cx, cy + 1);
    }

    ctx.restore();
  }
}

window.Board = Board;
