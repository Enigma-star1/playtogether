const webpush = require('web-push');

// Stable keys can be supplied by the host. Otherwise keys, like rooms, live for this process.
const keys = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
  ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
  : webpush.generateVAPIDKeys();

function validSubscription(subscription) {
  try {
    if (!subscription || typeof subscription.endpoint !== 'string' || subscription.endpoint.length > 2048) return false;
    const url = new URL(subscription.endpoint);
    const host = url.hostname;
    const allowed = host === 'fcm.googleapis.com' || host.endsWith('.push.services.mozilla.com') ||
      host === 'updates.push.services.mozilla.com' || host.endsWith('.notify.windows.com') || host.endsWith('.push.apple.com');
    return allowed && url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      /^[A-Za-z0-9_-]{87}=?$/.test(subscription.keys?.p256dh) && /^[A-Za-z0-9_-]{22}={0,2}$/.test(subscription.keys?.auth);
  } catch (_) { return false; }
}

function createNotifier(send = webpush.sendNotification.bind(webpush)) {
  return function notify(room, code, player, kind, body) {
    const subscription = room.subscriptions[player];
    if (!subscription || (room.players[player] && !room.hidden[player])) return;
    room.lastPush ||= {};
    const slot = `${player}-${kind}`;
    if (kind === 'chat' && Date.now() - (room.lastPush[slot] || 0) < 10000) return;
    room.lastPush[slot] = Date.now();
    // Generic text keeps private chat content out of the lock screen.
    const payload = JSON.stringify({ title: 'PlayTogether', body, code, tag: `table-${code}-${kind}` });
    return Promise.resolve().then(() => send(subscription, payload, {
      TTL: 300, urgency: 'normal', timeout: 5000, topic: `table-${code}-${kind}`,
      vapidDetails: { subject: process.env.VAPID_SUBJECT || process.env.RENDER_EXTERNAL_URL || 'https://localhost', publicKey: keys.publicKey, privateKey: keys.privateKey }
    })).catch(error => {
      if ((error.statusCode === 404 || error.statusCode === 410) && room.subscriptions[player] === subscription) delete room.subscriptions[player];
    });
  };
}

module.exports = { publicKey: keys.publicKey, validSubscription, createNotifier };
