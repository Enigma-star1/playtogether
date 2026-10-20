/**
 * WS — WebSocket wrapper with auto-reconnect and event emitter.
 *
 * Manages the connection lifecycle, transparent ping/pong keep-alive,
 * and exponential-backoff reconnection with optional room re-join.
 */
class WS {
  /**
   * @param {string} url  WebSocket endpoint (ws:// or wss://)
   */
  constructor(url) {
    this.url = url;
    /** @type {WebSocket|null} */
    this.ws = null;
    /** @type {Map<string, Function[]>} */
    this.handlers = new Map();
    this.connected = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 20;
    this.reconnectDelay = 1000; // base delay in ms
    this._reconnectTimer = null;

    // Identity for reconnect
    /** @type {string|null} */
    this.roomCode = null;
    /** @type {number|null} */
    this.playerNum = null;
  }

  /* ───────── connection ───────── */

  /** Open a WebSocket connection. */
  connect() {
    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      console.error('[WS] Failed to create WebSocket:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.emit('connected');

      // Rejoin room after a reconnect if identity is set
      if (this.roomCode && this.playerNum) {
        this.send({
          type: 'reconnect',
          code: this.roomCode,
          player: this.playerNum,
        });
      }
    };

    this.ws.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        console.warn('[WS] Non-JSON message:', event.data);
        return;
      }

      // Transparent keep-alive: respond to server pings immediately
      if (data.type === 'ping') {
        this.send({ type: 'pong' });
        return;
      }

      this.emit(data.type, data);
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.emit('disconnected');
      this.scheduleReconnect();
    };

    this.ws.onerror = (err) => {
      console.error('[WS] Error:', err);
    };
  }

  /* ───────── reconnect ───────── */

  /** Schedule a reconnect attempt with exponential back-off. */
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('[WS] Max reconnect attempts reached.');
      return;
    }

    const backoff = Math.min(
      this.reconnectDelay * Math.pow(1.5, this.reconnectAttempts),
      10000,
    );

    console.log(
      `[WS] Reconnecting in ${Math.round(backoff)} ms (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`,
    );

    this._reconnectTimer = setTimeout(() => {
      this.reconnectAttempts++;
      this.connect();
    }, backoff);
  }

  /* ───────── messaging ───────── */

  /**
   * Send a JSON message over the socket.
   * @param {object} data  Serialisable payload
   */
  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /* ───────── event emitter ───────── */

  /**
   * Register a handler for a message type.
   * @param {string}   type
   * @param {Function} callback
   */
  on(type, callback) {
    if (!this.handlers.has(type)) {
      this.handlers.set(type, []);
    }
    this.handlers.get(type).push(callback);
  }

  /**
   * Emit an event to all registered handlers.
   * @param {string} type
   * @param {*}      data
   */
  emit(type, data) {
    const cbs = this.handlers.get(type);
    if (cbs) {
      cbs.forEach((cb) => {
        try {
          cb(data);
        } catch (err) {
          console.error(`[WS] Handler error for "${type}":`, err);
        }
      });
    }
  }

  /* ───────── lifecycle ───────── */

  /** Permanently close the connection (no reconnect). */
  close() {
    clearTimeout(this._reconnectTimer);
    this.reconnectAttempts = this.maxReconnectAttempts; // prevent further attempts
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Store room identity so we can rejoin after a reconnect.
   * @param {string} code       Room code
   * @param {number} playerNum  1 or 2
   */
  setIdentity(code, playerNum) {
    this.roomCode = code;
    this.playerNum = playerNum;
  }
}

window.WS = WS;
