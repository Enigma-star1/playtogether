# PlayTogether

Lightweight two-player checkers, chat and optional voice. Run `npm install`, then `npm start`. The default local address is `http://localhost:3000`.

## Room flow

- Create a table, copy its invite link, and wait in the lobby. Chat and voice are available before the match. Both players tap **I'm ready** to start.
- Closing a tab reserves the seat. Open the same site in the same browser and choose **Resume your game**. The private seat token stays in browser storage; it is never included in the invite link.
- **Leave** asks for confirmation and ends the room for both players. A departure made offline is saved and delivered when the browser next connects.
- Returning in another tab transfers the seat to that tab. The old tab stops reconnecting and cannot clear the new tab's saved seat.
- A player can make their turn while their partner is temporarily away. The server keeps the board and validates every move; the partner receives the latest state on return.
- Empty rooms expire 30 minutes after both players disconnect. Rooms and recent chat are held in server memory, so a server restart or hosting shutdown ends them. Clearing browser storage or using a different browser loses the saved seat.

## Chat and alerts

Swipe a message to the right or press **Reply** to quote it. The server supplies the quote from the original message, retains the last 40 messages, and deduplicates retries against this recent history. Chat text is rendered as text, never HTML. Replying to a message outside the retained history shows an explanation and preserves the draft.

**Sound on/off** controls chat and turn chimes and is remembered on the device. A restored board does not replay a turn chime. Sound playback still follows browser audio rules.

**Enable alerts** is an explicit opt-in for web push. Alerts contain generic turn/message notices rather than private message text. The service worker displays notifications and returns to the saved table when tapped. Production requires HTTPS, browser notification permission, and outbound HTTPS access to the browser's push service. Delivery while Chrome is force-stopped or under device battery restrictions is not guaranteed.

The server generates VAPID keys for its lifetime by default, matching the lifetime of its in-memory rooms. On return, the browser renews a subscription if the key has changed. For stable production keys, generate a pair with `npx web-push generate-vapid-keys --json` and configure these hosting environment variables:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY` (secret; never commit it)
- `VAPID_SUBJECT` (a contact `mailto:` address or HTTPS site URL)

`RENDER_EXTERNAL_URL` is used as the subject when present; local development falls back to `https://localhost`. No push provider credentials or keys are shipped in client source except the public subscription key. Current supported push endpoints cover Chrome/FCM, Firefox, Microsoft and Apple.

## Optional floating turn card

During a game, browsers with video Picture-in-Picture support show **Float turn**. This opens a view-only 320 × 180 status card. It redraws on status changes, uses no animation loop, and sends no video over the network. Closing it or leaving the room stops the stream. Expand the floating window to return and play.

This is experimental on mobile. Desktop PiP opening and stream cleanup have been checked; actual Tecno Spark 4 multitasking performance, background updates and voice quality require a real-device check. Unsupported browsers keep the normal game and alerts.

## Checks

- `npm test` — game rules, room access and readiness, reconnect/departure, bounded chat and replies, binary voice relay, push routing and service-worker notification handling.
- `npm run test:browser` — two isolated mobile-sized browser contexts, tab closure/reopening, multiple tabs, offline leave, lobby, quoted replies and swipe handling, turn chime and mute. Browser push enrollment and PiP lifecycle are additionally checked with mocks. Uses installed Microsoft Edge by default; set `PLAYWRIGHT_CHANNEL` for another installed Playwright-supported channel.
- With the server running, `node scripts/webrtc-check.js` — local synthetic microphone check through lobby, game, mute/unmute and leaving. Set `BASE_URL` if the server is not at `http://localhost:3000`. This does not measure real-phone call quality.

Set `BASE_URL` to a deployed site to run the browser smoke check against that host instead of starting a local server. It creates private test rooms and closes them on success.

When deploying these protocol changes, refresh both players' pages before starting a new table. No deployment is performed by the test commands.
