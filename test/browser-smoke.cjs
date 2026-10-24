// Run with npm run test:browser. Uses installed Edge; no browser download required.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');

(async () => {
  const server = process.env.BASE_URL ? null : spawn(process.execPath, ['server/index.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let browser;
  try {
    let url = process.env.BASE_URL?.replace(/\/$/, '');
    if (server) {
      const [line] = await once(server.stdout, 'data');
      url = 'http://127.0.0.1:' + String(line).match(/:(\d+)/)[1];
    }
    browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'msedge', headless: true });
    const options = { viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true, serviceWorkers: 'allow' };
    const hostContext = await browser.newContext(options), guestContext = await browser.newContext(options);
    const errors = [];
    const watch = page => page.on('pageerror', e => errors.push(e.message));
    let a = await hostContext.newPage(), b = await guestContext.newPage(); watch(a); watch(b);
    const ready = page => page.waitForFunction(() => window.ws?.connected);
    const screen = (page, selector) => page.locator(selector).waitFor({ state: 'visible' });
    const noOverflow = async page => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await Promise.all([a.goto(url), b.goto(url)]); await Promise.all([ready(a), ready(b)]);
    await a.locator('#create-btn').click(); await screen(a, '#waiting-view');
    const code = await a.locator('#display-code').textContent();
    await b.locator('#room-input').fill(code); await b.locator('#join-btn').click(); await screen(b, '#waiting-view');
    assert.equal(await a.locator('#game-view').isVisible(), false); await noOverflow(a); await noOverflow(b);
    await a.locator('#chat-toggle').click(); await a.locator('#chat-input').fill('<img src=x onerror=alert(1)>'); await a.locator('#send-chat-btn').click();
    await b.waitForFunction(() => chat.records.size === 1);
    await b.locator('#chat-toggle').click();
    const message = b.locator('.message.other').first();
    await message.dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', clientX: 20, clientY: 60 });
    await message.dispatchEvent('pointermove', { pointerId: 7, pointerType: 'touch', clientX: 80, clientY: 62 });
    await message.dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', clientX: 80, clientY: 62 });
    await screen(b, '#reply-preview');
    await b.locator('#chat-input').fill('Swipe reply'); await b.locator('#send-chat-btn').click();
    await a.waitForFunction(() => chat.records.size === 2);
    assert.match(await a.locator('.msg-quote').textContent(), /<img/);
    assert.equal(await a.locator('#chat-messages img').count(), 0);
    await a.evaluate(() => {
      const socket = ws.ws, receive = socket.onmessage;
      socket.onmessage = event => {
        if (typeof event.data === 'string') {
          const data = JSON.parse(event.data);
          if (data.type === 'chat' && data.text === 'Retry me once') { socket.close(); return; }
        }
        receive(event);
      };
    });
    await a.locator('#chat-input').fill('Retry me once'); await a.locator('#send-chat-btn').click();
    await a.waitForFunction(() => game.ready && !chat.pending && chat.records.size === 3);
    await b.waitForFunction(() => chat.records.size === 3);
    await b.close(); b = await guestContext.newPage(); watch(b); await b.goto(url); await ready(b);
    await screen(b, '#resume-panel'); await b.locator('#resume-btn').click(); await screen(b, '#waiting-view');
    assert.equal(await b.evaluate(() => chat.records.size), 3);
    await a.locator('#chat-toggle').click();
    await a.locator('#ready-btn').click();
    assert.equal(await a.locator('#game-view').isVisible(), false);
    await b.locator('#ready-btn').click(); await Promise.all([screen(a, '#game-view'), screen(b, '#game-view')]);
    await b.evaluate(() => { window.turnChimes = 0; const original = chat.playChime.bind(chat); chat.playChime = kind => { if (kind === 'turn') turnChimes++; original(kind); }; });
    await a.waitForFunction(() => board.cellSize > 0);
    await a.evaluate(() => game.sendMove([5, 0], [4, 1]));
    await b.waitForFunction(() => game.isMyTurn);
    assert.equal(await b.evaluate(() => turnChimes), 1);
    await b.evaluate(() => ws.send({ type: 'sync' }));
    await b.waitForFunction(() => game.revision === 1); assert.equal(await b.evaluate(() => turnChimes), 1);
    await b.locator('#sound-btn').click(); assert.equal(await b.locator('#sound-btn').textContent(), 'Sound off');
    await noOverflow(a); await noOverflow(b);
    // Browser-level PiP mock verifies stream lifetime and event-driven drawing without claiming device support.
    await a.evaluate(() => {
      const away = game.away;
      Object.defineProperty(document, 'pictureInPictureElement', { configurable: true, get: () => window.fakePiP || null });
      away.video.requestPictureInPicture = async () => { window.fakePiP = away.video; };
      document.exitPictureInPicture = async () => { window.fakePiP = null; away.video.dispatchEvent(new Event('leavepictureinpicture')); };
      document.getElementById('float-btn').hidden = false;
    });
    await a.locator('#float-btn').click();
    await a.waitForFunction(() => game.away.stream?.active && !game.away.opening);
    const floatState = await a.evaluate(() => {
      window.floatTrack = game.away.stream.getVideoTracks()[0];
      return { width: game.away.canvas.width, height: game.away.canvas.height, label: game.away.status() };
    });
    assert.deepEqual(floatState, { width: 320, height: 180, label: 'Their turn' });
    await a.locator('#float-btn').click();
    await a.waitForFunction(() => !game.away.stream);
    assert.equal(await a.evaluate(() => floatTrack.readyState), 'ended');

    // Automatic float on tab leave (visibilitychange to hidden)
    await a.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await a.waitForFunction(() => game.away.stream?.active && window.fakePiP);
    assert.equal(await a.evaluate(() => game.away.isAutoPiP), true);

    // Returning to tab (visibilitychange to visible) closes auto float
    await a.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await a.waitForFunction(() => !window.fakePiP && !game.away.stream);
    // Mock only browser push enrollment/transport; no test message leaves this machine.
    await hostContext.grantPermissions(['notifications'], { origin: url });
    await a.evaluate(() => {
      window.pushRequests = [];
      PushManager.prototype.getSubscription = async () => null;
      PushManager.prototype.subscribe = async () => ({ toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } }) });
      const send = ws.send.bind(ws);
      ws.send = data => {
        if (data.type !== 'push_subscribe') return send(data);
        pushRequests.push(data); setTimeout(() => ws.emit('push_saved', { enabled: !!data.subscription }), 0); return true;
      };
    });
    await a.locator('#notify-btn').click(); await a.waitForFunction(() => game.away.enabled);
    assert.equal(await a.locator('#notify-btn').textContent(), 'Alerts on');
    await a.locator('#notify-btn').click(); await a.waitForFunction(() => !game.away.enabled);
    assert.equal(await a.evaluate(() => pushRequests[1].subscription), null);
    if (process.env.QA_SCREENSHOTS) {
      fs.mkdirSync(process.env.QA_SCREENSHOTS, { recursive: true });
      await a.screenshot({ path: path.join(process.env.QA_SCREENSHOTS, 'game-mobile.png'), fullPage: true, animations: 'disabled' });
    }
    const saved = await b.evaluate(() => localStorage.getItem('playtogether-seat'));
    await b.close();
    b = await guestContext.newPage(); watch(b); await b.goto(url + '/?room=' + code + '&resume=1'); await ready(b);
    await screen(b, '#game-view');
    assert.equal(await b.locator('#landing-error').evaluate(el => el.hidden), true);
    assert.equal(await b.evaluate(() => game.boardState[4][1]), 1);
    assert.equal(await b.locator('#sound-btn').textContent(), 'Sound off');
    const duplicate = await guestContext.newPage(); watch(duplicate); await duplicate.goto(url); await ready(duplicate);
    await duplicate.locator('#resume-btn').click(); await screen(duplicate, '#game-view');
    await b.waitForFunction(() => ws.stopped);
    assert.equal(JSON.parse(await duplicate.evaluate(() => localStorage.getItem('playtogether-seat'))).token, JSON.parse(saved).token);
    await b.close(); b = duplicate;
    await b.locator('#leave-btn').click(); await b.locator('#cancel-leave-btn').click(); assert.equal(await b.locator('#game-view').isVisible(), true);
    // Queue leaving while offline; close that tab before connectivity returns.
    await guestContext.setOffline(true); await b.evaluate(() => ws.ws.close()); await b.waitForFunction(() => !ws.connected);
    await b.locator('#leave-btn').click(); await b.locator('#confirm-leave-btn').click();
    assert.equal(await b.evaluate(() => JSON.parse(localStorage.getItem('playtogether-seat')).leaving), true);
    await b.close(); await guestContext.setOffline(false);
    b = await guestContext.newPage(); watch(b); await b.goto(url);
    await b.waitForFunction(() => window.ws?.connected && !ws.token);
    await a.waitForFunction(() => !ws.token);
    assert.equal(await b.evaluate(() => localStorage.getItem('playtogether-seat')), null);
    assert.equal(await a.locator('#chat-section').isVisible(), false);
    await a.locator('#create-btn').click(); await screen(a, '#waiting-view');
    if (process.env.QA_SCREENSHOTS) await a.screenshot({ path: path.join(process.env.QA_SCREENSHOTS, 'lobby-mobile.png'), fullPage: true, animations: 'disabled' });
    await a.locator('#back-btn').click(); await a.locator('#confirm-leave-btn').click();
    await a.waitForFunction(() => !ws.token);
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: lobby, safe quoted replies, swipe, fresh-tab recovery, turn chime, mute, multiple tabs, offline leave, mobile layout, mocked PiP resource cleanup and mocked push opt-in/out.');
  } finally {
    await browser?.close(); server?.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
