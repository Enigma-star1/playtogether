const { test } = require('node:test');
const assert = require('node:assert/strict');
const Game = require('../server/game');
test('invalid coordinates fail without changing or crashing the game', () => {
  const game = new Game(), before = game.getState();
  for (const args of [[99, 0, 0, 0], [null, 0, 0, 0], [5, 0, 4.2, 1], ['5', 0, 4, 1]]) assert.equal(game.makeMove(...args).valid, false);
  assert.deepEqual(game.getState(), before);
});
test('forced capture continues with the same piece, then changes turn', () => {
  const game = new Game(); game.board = Array.from({ length: 8 }, () => Array(8).fill(0));
  game.board[5][0] = 1; game.board[4][1] = 2; game.board[2][3] = 2; game.board[5][4] = 1; game.board[0][7] = 2;
  assert.equal(game.makeMove(5, 4, 4, 5).valid, false);
  assert.equal(game.makeMove(5, 0, 3, 2).continueCapture, true);
  assert.deepEqual(game.getValidMoves(5, 4), []);
  assert.equal(game.makeMove(5, 4, 4, 5).valid, false);
  assert.equal(game.makeMove(3, 2, 1, 4).valid, true);
  assert.equal(game.currentPlayer, 2);
});
test('promotion ends a capture turn under English rules', () => {
  const game = new Game(); game.board = Array.from({ length: 8 }, () => Array(8).fill(0));
  game.board[2][1] = 1; game.board[1][2] = 2; game.board[1][4] = 2;
  const move = game.makeMove(2, 1, 0, 3);
  assert.equal(move.promoted, true); assert.equal(move.continueCapture, false); assert.equal(game.currentPlayer, 2);
});
