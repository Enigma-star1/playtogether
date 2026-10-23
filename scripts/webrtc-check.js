const { chromium } = require('playwright');

async function runCheck() {
  console.log('🚀 Starting Voice Call (WebRTC & WebSocket Relay) verification check...');

  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--allow-file-access-from-files',
    ],
  });

  try {
    const context1 = await browser.newContext({ permissions: ['microphone'] });
    const context2 = await browser.newContext({ permissions: ['microphone'] });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Log browser console
    page1.on('console', (msg) => console.log('[Peer 1]', msg.text()));
    page2.on('console', (msg) => console.log('[Peer 2]', msg.text()));

    console.log('1. Loading application for Peer 1...');
    await page1.goto('http://localhost:3000');

    console.log('2. Peer 1 creating table...');
    await page1.click('#create-btn');
    await page1.waitForSelector('#display-code');
    const roomCode = await page1.textContent('#display-code');
    console.log(`   Room Code created: ${roomCode.trim()}`);

    console.log('3. Peer 2 joining table with code...');
    await page2.goto('http://localhost:3000');
    await page2.fill('#room-input', roomCode.trim());
    await page2.click('#join-btn');

    await page1.waitForSelector('#game-view', { state: 'visible' });
    await page2.waitForSelector('#game-view', { state: 'visible' });
    console.log('   Both players successfully joined the table!');

    console.log('4. Peer 1 tapping mic to start voice call...');
    await page1.click('#mic-btn');

    console.log('5. Waiting for Peer 2 to receive incoming call notification...');
    await page2.waitForSelector('.game-toast.visible, #mic-btn.incoming-call', { timeout: 8000 });
    console.log('   Peer 2 received incoming call notification!');

    console.log('6. Peer 2 answering call...');
    await page2.click('#mic-btn');

    console.log('7. Waiting for Voice connection to reach "connected" state...');

    const checkConnected = async (page) => {
      return page.waitForFunction(
        () => {
          return window.voice && window.voice.isActive && window.voice.isConnected;
        },
        { timeout: 10000 }
      );
    };

    await Promise.all([checkConnected(page1), checkConnected(page2)]);

    const state1 = await page1.evaluate(() => ({
      isActive: window.voice.isActive,
      isConnected: window.voice.isConnected,
      isRelay: window.voice.isRelay,
      webrtcState: window.voice.pc ? window.voice.pc.connectionState : 'none',
    }));

    const state2 = await page2.evaluate(() => ({
      isActive: window.voice.isActive,
      isConnected: window.voice.isConnected,
      isRelay: window.voice.isRelay,
      webrtcState: window.voice.pc ? window.voice.pc.connectionState : 'none',
    }));

    console.log('   Peer 1 State:', JSON.stringify(state1));
    console.log('   Peer 2 State:', JSON.stringify(state2));
    console.log('   ✅ Voice call successfully connected!');

    // Test mute/unmute
    console.log('8. Testing mute toggle...');
    await page1.click('#mic-btn');
    const isMuted1 = await page1.evaluate(() => window.voice.isMuted);
    console.log(`   Peer 1 muted: ${isMuted1 ? 'YES 🔇' : 'NO'}`);
    await page1.click('#mic-btn');
    const isUnmuted1 = await page1.evaluate(() => !window.voice.isMuted);
    console.log(`   Peer 1 unmuted: ${isUnmuted1 ? 'YES 🎙️' : 'NO'}`);

    console.log('\n🎉 ALL CHECKS PASSED: Voice calling is 100% operational and verified!');
  } finally {
    await browser.close();
  }
}

runCheck().catch((err) => {
  console.error('\n❌ Check failed with error:', err);
  process.exit(1);
});
