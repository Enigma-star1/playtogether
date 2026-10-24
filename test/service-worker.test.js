const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('push displays a notification and tapping it focuses an existing table or opens the resume link', async () => {
  const handlers = {}, shown = [], messages = [], opened = [];
  let windows = [], focused = false;
  const self = {
    addEventListener: (name, handler) => { handlers[name] = handler; },
    location: { origin: 'https://game.example' },
    registration: { showNotification: async (...args) => shown.push(args) },
    clients: { matchAll: async () => windows, openWindow: async url => opened.push(url) }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8'), { self, URL });
  let work;
  handlers.push({ data: { json: () => ({ code: 'ABCD', body: 'Your turn', tag: 'turn' }) }, waitUntil: p => { work = p; } });
  await work; assert.equal(shown[0][1].body, 'Your turn');
  const click = { notification: { data: { code: 'ABCD' }, close() {} }, waitUntil: p => { work = p; } };
  handlers.notificationclick(click); await work; assert.equal(opened[0], '/?room=ABCD&resume=1');
  windows = [{ url: 'https://game.example/', focus: async () => { focused = true; }, postMessage: value => messages.push(value) }];
  handlers.notificationclick(click); await work;
  assert.equal(focused, true); assert.equal(messages[0].type, 'resume_table');
  assert.equal(messages[0].code, 'ABCD'); assert.equal(opened.length, 1);
  handlers.push({ data: { json: () => ({ code: '../bad' }) }, waitUntil() { throw Error('Invalid code accepted'); } });
});
