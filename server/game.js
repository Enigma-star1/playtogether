/**
 * CheckersGame — Full American/English checkers rules.
 *
 * Board encoding:
 *   0 = empty
 *   1 = Player 1 man  (Red,  starts rows 5-7, moves UP)
 *   2 = Player 2 man  (Dark, starts rows 0-2, moves DOWN)
 *   3 = Player 1 king
 *   4 = Player 2 king
 *
 * Playable (dark) squares satisfy (row + col) % 2 === 1.
 */

class CheckersGame {
  constructor() {
    this.board = [];
    this.currentPlayer = 1;
    this.mustCapture = null;   // [row, col] when a multi-jump is in progress
    this.gameOver = false;
    this.winner = null;
    this.moveHistory = [];
    this.createBoard();
  }

  /* ------------------------------------------------------------------ */
  /*  Board setup                                                       */
  /* ------------------------------------------------------------------ */

  /** Place 12 pieces per player on the dark squares. */
  createBoard() {
    this.board = Array.from({ length: 8 }, () => Array(8).fill(0));

    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if ((r + c) % 2 !== 1) continue; // skip light squares
        if (r <= 2) this.board[r][c] = 2; // Player 2 (Dark) top
        if (r >= 5) this.board[r][c] = 1; // Player 1 (Red)  bottom
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Helpers                                                           */
  /* ------------------------------------------------------------------ */

  /** Which player owns this piece? (1 or 2, or 0 if empty) */
  ownerOf(piece) {
    if (piece === 1 || piece === 3) return 1;
    if (piece === 2 || piece === 4) return 2;
    return 0;
  }

  /** Is this piece a king? */
  isKing(piece) {
    return piece === 3 || piece === 4;
  }

  /** Forward direction(s) for a given piece. */
  directions(piece) {
    if (this.isKing(piece)) return [-1, 1]; // kings move both ways
    return piece === 1 ? [-1] : [1];        // men: P1 up, P2 down
  }

  /** In-bounds check. */
  inBounds(r, c) {
    return r >= 0 && r < 8 && c >= 0 && c < 8;
  }

  /* ------------------------------------------------------------------ */
  /*  Move generation                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * All valid moves for the piece at (row, col).
   * Enforces FORCED CAPTURE: if any piece of the current player can capture,
   * only capture moves are returned for every piece.
   *
   * @returns {Array<{ to: [number, number], captures: Array<[number, number]> }>}
   */
  getValidMoves(row, col) {
    const piece = this.board[row][col];
    if (!piece || this.ownerOf(piece) !== this.currentPlayer) return [];

    const anyCaptures = this.hasAnyCaptures(this.currentPlayer);

    if (anyCaptures) {
      // Forced capture — only return captures for THIS piece (may be empty)
      return this.getCaptures(row, col);
    }

    // No captures available anywhere — return simple slides
    return this.getSimpleMoves(row, col);
  }

  /**
   * Non-capturing diagonal slides.
   * Men: forward only. Kings: forward and backward.
   */
  getSimpleMoves(row, col) {
    const piece = this.board[row][col];
    if (!piece) return [];

    const moves = [];
    const dirs = this.directions(piece);

    for (const dr of dirs) {
      for (const dc of [-1, 1]) {
        const nr = row + dr;
        const nc = col + dc;
        if (this.inBounds(nr, nc) && this.board[nr][nc] === 0) {
          moves.push({ to: [nr, nc], captures: [] });
        }
      }
    }
    return moves;
  }

  /**
   * Single-step jump captures for the piece at (row, col).
   * Men: forward only. Kings: both directions.
   *
   * @returns {Array<{ to: [number, number], captures: Array<[number, number]> }>}
   */
  getCaptures(row, col) {
    const piece = this.board[row][col];
    if (!piece) return [];

    const captures = [];
    const dirs = this.directions(piece);
    const player = this.ownerOf(piece);

    for (const dr of dirs) {
      for (const dc of [-1, 1]) {
        const mr = row + dr;       // midpoint (captured piece)
        const mc = col + dc;
        const lr = row + dr * 2;   // landing square
        const lc = col + dc * 2;

        if (!this.inBounds(lr, lc)) continue;

        const mid = this.board[mr][mc];
        if (mid === 0 || this.ownerOf(mid) === player) continue; // no enemy
        if (this.board[lr][lc] !== 0) continue;                  // landing occupied

        captures.push({ to: [lr, lc], captures: [[mr, mc]] });
      }
    }
    return captures;
  }

  /**
   * Does the given player have at least one capture available?
   */
  hasAnyCaptures(player) {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (this.ownerOf(this.board[r][c]) !== player) continue;
        if (this.getCaptures(r, c).length > 0) return true;
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /*  Move execution                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Validate and execute a move.
   *
   * @returns {{ valid: boolean, captured: Array|null, promoted: boolean,
   *             continueCapture: boolean, state: object, error?: string }}
   */
  makeMove(fromRow, fromCol, toRow, toCol) {
    const fail = (error) => ({
      valid: false, captured: null, promoted: false,
      continueCapture: false, state: this.getState(), error,
    });

    if (this.gameOver) return fail('Game is over');

    const piece = this.board[fromRow][fromCol];
    if (!piece) return fail('No piece at source');
    if (this.ownerOf(piece) !== this.currentPlayer) return fail('Not your piece');

    // Multi-jump constraint: must continue with the same piece
    if (this.mustCapture) {
      const [mr, mc] = this.mustCapture;
      if (fromRow !== mr || fromCol !== mc) {
        return fail('Must continue capturing with the same piece');
      }
    }

    // Validate move against legal moves
    const validMoves = this.getValidMoves(fromRow, fromCol);
    const match = validMoves.find(
      (m) => m.to[0] === toRow && m.to[1] === toCol
    );
    if (!match) return fail('Invalid move');

    // --- Execute ---
    const captured = match.captures;    // [[r,c], ...]
    let promoted = false;

    // Move the piece
    this.board[toRow][toCol] = piece;
    this.board[fromRow][fromCol] = 0;

    // Remove captured pieces
    for (const [cr, cc] of captured) {
      this.board[cr][cc] = 0;
    }

    // King promotion
    const promoRow = this.currentPlayer === 1 ? 0 : 7;
    if (!this.isKing(piece) && toRow === promoRow) {
      this.board[toRow][toCol] = this.currentPlayer + 2; // 1→3, 2→4
      promoted = true;
    }

    // Record history
    this.moveHistory.push({
      from: [fromRow, fromCol],
      to: [toRow, toCol],
      captured,
      promoted,
    });

    // --- Post-move: multi-jump or turn switch ---
    let continueCapture = false;

    if (captured.length > 0 && !promoted) {
      // Check if the same piece can capture again
      const moreCaps = this.getCaptures(toRow, toCol);
      if (moreCaps.length > 0) {
        this.mustCapture = [toRow, toCol];
        continueCapture = true;
      }
    }

    if (!continueCapture) {
      // Turn is over — switch players
      this.mustCapture = null;
      this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;
      this.checkGameOver();
    }

    return {
      valid: true,
      captured,
      promoted,
      continueCapture,
      state: this.getState(),
    };
  }

  /* ------------------------------------------------------------------ */
  /*  End-of-game detection                                             */
  /* ------------------------------------------------------------------ */

  /** If the current player has no pieces or no legal moves, opponent wins. */
  checkGameOver() {
    const counts = this.getPieceCounts();

    // No pieces left?
    if (counts[this.currentPlayer] === 0) {
      this.gameOver = true;
      this.winner = this.currentPlayer === 1 ? 2 : 1;
      return;
    }

    // No legal moves?
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        if (this.ownerOf(this.board[r][c]) !== this.currentPlayer) continue;
        if (this.getValidMoves(r, c).length > 0) return; // at least one move
      }
    }

    // Stalemate → opponent wins (American rules)
    this.gameOver = true;
    this.winner = this.currentPlayer === 1 ? 2 : 1;
  }

  /* ------------------------------------------------------------------ */
  /*  State accessors                                                   */
  /* ------------------------------------------------------------------ */

  /** Deep copy of current game state. */
  getState() {
    return {
      board: this.board.map((row) => [...row]),
      currentPlayer: this.currentPlayer,
      mustCapture: this.mustCapture ? [...this.mustCapture] : null,
      gameOver: this.gameOver,
      winner: this.winner,
    };
  }

  /** Piece counts per player. */
  getPieceCounts() {
    const counts = { 1: 0, 2: 0 };
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const owner = this.ownerOf(this.board[r][c]);
        if (owner) counts[owner]++;
      }
    }
    return counts;
  }

  /** Full reset to initial state. */
  reset() {
    this.currentPlayer = 1;
    this.mustCapture = null;
    this.gameOver = false;
    this.winner = null;
    this.moveHistory = [];
    this.createBoard();
  }
}

module.exports = CheckersGame;
