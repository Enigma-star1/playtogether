/* Optional background alerts and a tiny, event-driven video PiP status card. */
class Away {
  constructor(ws, game) {
    this.ws = ws; this.game = game;
    this.button = document.getElementById('float-btn');
    this.notifyButton = document.getElementById('notify-btn');
    this.video = document.createElement('video');
    this.video.muted = true; this.video.playsInline = true;
    this.video.setAttribute('aria-hidden', 'true');
    this.video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(this.video);
    this.button.hidden = !(document.pictureInPictureEnabled && this.video.requestPictureInPicture && HTMLCanvasElement.prototype.captureStream);
    this.button.addEventListener('click', () => this.toggleFloat());
    this.video.addEventListener('leavepictureinpicture', () => this.releaseStream());
    this.notifyButton.hidden = !('Notification' in window && 'PushManager' in window && 'serviceWorker' in navigator && window.isSecureContext);
    this.notifyButton.addEventListener('click', () => this.toggleNotifications());
    this.enabled = false;
    this.wantsAlerts = false;
    try { this.wantsAlerts = localStorage.getItem('playtogether-alerts') === 'on'; } catch (_) {}
    this.renderNotificationButton();
    ws.on('push_saved', data => {
      this.notifyButton.disabled = false;
      clearTimeout(this.pushTimer);
      this.enabled = this.wantsAlerts = data.enabled; this.renderNotificationButton();
      try { localStorage.setItem('playtogether-alerts', data.enabled ? 'on' : 'off'); } catch (_) {}
    });
    const joined = () => {
      this.presence();
      if (this.wantsAlerts && window.Notification?.permission === 'granted') this.subscribe().catch(() => this.notificationFailed());
    };
    ws.on('room_created', joined); ws.on('room_joined', joined);
    ws.on('error', data => { if (data.pushError) this.notificationFailed(); });
    document.addEventListener('visibilitychange', () => {
      this.presence();
      if (!document.hidden) this.clearNotifications();
    });
    window.addEventListener('pagehide', () => { this.stop(); });
  }

  presence() {
    if (this.game.ready) this.ws.send({ type: 'presence', hidden: document.hidden });
  }

  renderNotificationButton() { this.notifyButton.textContent = this.enabled ? 'Alerts on' : 'Enable alerts'; }

  async toggleNotifications() {
    if (!this.ws.connected || !this.game.ready) return this.game.showToast('Reconnect before changing alerts.');
    if (this.enabled) {
      try { this.sendSubscription(null); } catch (_) { this.notificationFailed(); }
      return;
    }
    // Permission is requested only following this explicit button press.
    let permission;
    try { permission = await Notification.requestPermission(); } catch (_) { return this.notificationFailed(); }
    if (permission !== 'granted') return this.game.showToast('Alerts are off. You can allow them in Chrome’s site settings.');
    this.notifyButton.disabled = true;
    try { await this.subscribe(); } catch (_) { this.notificationFailed(); }
  }

  async subscribe() {
    if (this.subscribing) return;
    this.subscribing = true;
    this.notifyButton.disabled = true;
    const token = this.ws.token;
    try {
      let readyTimer;
      let registration;
      try { registration = await Promise.race([navigator.serviceWorker.ready, new Promise((_, reject) => { readyTimer = setTimeout(() => reject(Error('Service worker unavailable')), 8000); })]); }
      finally { clearTimeout(readyTimer); }
      const url = new URL(this.ws.url); url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'; url.pathname = '/api/push-key'; url.search = '';
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      let publicKey;
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw Error('Push unavailable');
        ({ publicKey } = await response.json());
      } finally { clearTimeout(timer); }
      const key = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
      let subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        const old = new Uint8Array(subscription.options.applicationServerKey || []);
        if (old.length !== key.length || old.some((n, i) => n !== key[i])) { await subscription.unsubscribe(); subscription = null; }
      }
      subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      if (this.ws.token !== token || !this.game.ready) return;
      this.sendSubscription(subscription.toJSON());
    } finally { this.subscribing = false; }
  }

  sendSubscription(subscription) {
    if (!this.ws.send({ type: 'push_subscribe', subscription })) throw Error('Disconnected');
    this.notifyButton.disabled = true;
    clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => this.notificationFailed(), 8000);
  }

  notificationFailed() {
    clearTimeout(this.pushTimer); this.notifyButton.disabled = false;
    this.enabled = false; this.renderNotificationButton();
    this.game.showToast('Couldn’t update alerts. Tap to retry when connected.');
  }

  async clearNotifications() {
    try {
      const registration = await navigator.serviceWorker?.getRegistration();
      const notifications = await registration?.getNotifications();
      for (const notification of notifications || []) if (notification.data?.code === this.game.roomCode) notification.close();
    } catch (_) {}
  }

  status() {
    if (!this.game.ready || !this.ws.connected) return 'Reconnecting…';
    if (!this.game.gameActive) return this.game.boardState ? 'Game finished' : 'In the lobby';
    return this.game.isMyTurn ? 'Your turn' : 'Their turn';
  }

  render() {
    if (!this.canvas) return;
    const label = this.status();
    const detail = !this.ws.connected ? 'Return to reconnect' : 'Expand to return to your table';
    const signature = `${this.game.roomCode}-${label}-${detail}`;
    if (this.signature === signature) return;
    this.signature = signature;
    const ctx = this.canvas.getContext('2d');
    ctx.fillStyle = '#faf3e9'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#716576'; ctx.font = '14px sans-serif'; ctx.fillText(`PlayTogether · ${this.game.roomCode || ''}`, 20, 32);
    ctx.fillStyle = label === 'Your turn' ? '#75508e' : '#342b3d'; ctx.font = 'bold 30px sans-serif'; ctx.fillText(label, 20, 95);
    ctx.fillStyle = '#716576'; ctx.font = '13px sans-serif'; ctx.fillText(detail, 20, 146);
    this.stream?.getVideoTracks()[0]?.requestFrame?.();
  }

  async toggleFloat() {
    if (this.opening) return;
    if (document.pictureInPictureElement === this.video) { await this.stop(); return; }
    this.opening = true; this.button.disabled = true;
    const request = this.floatRequest = (this.floatRequest || 0) + 1;
    try {
      this.canvas = document.createElement('canvas'); this.canvas.width = 320; this.canvas.height = 180;
      // captureStream with no rate captures only when this small canvas changes.
      this.stream = this.canvas.captureStream();
      this.video.srcObject = this.stream; this.signature = null; this.render();
      await this.video.play();
      if (request !== this.floatRequest || !this.game.ready) throw Error('Room closed');
      await this.video.requestPictureInPicture();
      if (request !== this.floatRequest || !this.game.ready) { await this.stop(); return; }
      this.button.textContent = 'Close float';
    } catch (_) {
      this.releaseStream();
      this.game.showToast('Floating view isn’t available here. Alerts still work.');
    } finally { this.opening = false; this.button.disabled = false; }
  }

  releaseStream() {
    this.video.pause(); this.video.srcObject = null;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null; this.canvas = null; this.signature = null;
    this.button.textContent = 'Float turn ↗';
  }

  async stop() {
    this.floatRequest = (this.floatRequest || 0) + 1;
    try { if (document.pictureInPictureElement === this.video) await document.exitPictureInPicture(); } catch (_) {}
    this.releaseStream();
  }
}
window.Away = Away;
