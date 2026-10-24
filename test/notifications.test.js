const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validSubscription, createNotifier } = require('../server/notifications');

test('push destinations reject arbitrary URLs and credentials', () => {
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } };
  assert.equal(validSubscription(subscription), true);
  for (const endpoint of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.test/x', 'https://127.0.0.1/x', 'https://user:pass@fcm.googleapis.com/x', 'https://fcm.googleapis.com:444/x']) {
    assert.equal(validSubscription({ ...subscription, endpoint }), false);
  }
});

test('push targets away players, bounds chat alerts, and drops expired subscriptions', async () => {
  const sent = [];
  const notify = createNotifier(async (...args) => sent.push(args));
  const subscription = { endpoint: 'test' };
  const room = { subscriptions: { 2: subscription }, players: { 2: {} }, hidden: { 2: false } };
  await notify(room, 'ABCD', 2, 'turn', 'Your turn'); assert.equal(sent.length, 0);
  room.hidden[2] = true;
  await notify(room, 'ABCD', 2, 'turn', 'Your turn'); assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0][1]).code, 'ABCD');
  room.players[2] = null; room.hidden[2] = false;
  await notify(room, 'ABCD', 2, 'chat', 'New message');
  await notify(room, 'ABCD', 2, 'chat', 'New message'); assert.equal(sent.length, 2);
  const expired = createNotifier(async () => { throw { statusCode: 410 }; });
  await expired(room, 'ABCD', 2, 'turn', 'Your turn'); assert.equal(room.subscriptions[2], undefined);
});
