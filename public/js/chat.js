/**
 * Chat — Collapsible chat panel with message display, unread badge,
 * and system messages.
 */
class Chat {
  constructor() {
    /* ── DOM refs ── */
    this.section   = document.getElementById('chat-section');
    this.toggle    = document.getElementById('chat-toggle');
    this.messages  = document.getElementById('chat-messages');
    this.input     = document.getElementById('chat-input');
    this.sendBtn   = document.getElementById('send-chat-btn');
    this.badge     = document.getElementById('unread-badge');
    this.chevron   = this.toggle ? this.toggle.querySelector('span.chevron') : null;

    /* ── state ── */
    this.collapsed = true;
    this.unreadCount = 0;
    /** @type {Function|null} */
    this.sendCallback = null;
    this.records = new Map();
    this.replyTo = null;
    this.pending = null;
    this.myPlayer = null;
    this.soundEnabled = true;
    try { this.soundEnabled = localStorage.getItem('playtogether-sound') !== 'off'; } catch (_) {}
    document.getElementById('cancel-reply-btn').addEventListener('click', () => this.selectReply(null));
    const unlock = () => this.unlockAudio();
    document.addEventListener('pointerdown', unlock, { passive: true });
    document.addEventListener('keydown', unlock);

    /* ── wire events ── */
    if (this.toggle) {
      this.toggle.addEventListener('click', () => this.togglePanel());
    }
    if (this.sendBtn) {
      this.sendBtn.addEventListener('click', () => this.sendMessage());
    }
    if (this.input) {
      this.input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.sendMessage();
        }
      });
    }
  }

  /* ─────────── panel toggle ─────────── */

  togglePanel() {
    this.collapsed = !this.collapsed;
    this.toggle?.setAttribute('aria-expanded', String(!this.collapsed));
    if (this.section) {
      this.section.classList.toggle('collapsed', this.collapsed);
    }
    if (!this.collapsed) {
      this.clearUnread();
      this.scrollToBottom();
      // Focus the input when opening
      if (this.input) this.input.focus();
    }
  }

  /* ─────────── sending ─────────── */

  sendMessage() {
    if (!this.input) return;
    const text = this.input.value.trim();
    if (!text || this.pending) return;
    const clientId = window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const message = { text, replyTo: this.replyTo?.id || null, clientId };
    if (this.sendCallback && this.sendCallback(message) === false) return;
    this.pending = message;
    this.setStatus('Sending…');
    this.sendBtn.disabled = true;
    this.input.readOnly = true;
  }

  /**
   * Register a callback invoked with the message text on send.
   * @param {Function} cb
   */
  onSend(cb) {
    this.sendCallback = cb;
  }

  /* ─────────── message display ─────────── */

  /**
   * Append a player message to the chat log.
   * @param {string}  text
   * @param {number}  fromPlayer   1 or 2
   * @param {boolean} isSelf       true if the message is from this client
   * @param {string|number} timestamp  ISO string or epoch ms
   */
  addMessage(data, silent = false) {
    if (!this.messages) return;
    const { text, from: fromPlayer, timestamp } = data;
    const isSelf = fromPlayer === this.myPlayer;
    if (isSelf && this.pending?.clientId === data.clientId) {
      this.pending = null; this.input.value = ''; this.input.readOnly = false;
      this.sendBtn.disabled = false; this.selectReply(null); this.setStatus('');
    }
    if (this.records.has(data.id)) return;
    this.records.set(data.id, data);

    const wrapper = document.createElement('div');
    wrapper.className = 'message ' + (isSelf ? 'self' : 'other');
    wrapper.dataset.messageId = data.id;
    if (data.reply) {
      const quote = document.createElement('span');
      quote.className = 'msg-quote';
      quote.textContent = `${data.reply.from === this.myPlayer ? 'You' : 'Partner'}: ${data.reply.text}`;
      wrapper.appendChild(quote);
    }

    const textSpan = document.createElement('span');
    textSpan.className = 'msg-text';
    textSpan.textContent = text;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    const date = timestamp ? new Date(timestamp) : new Date();
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    timeSpan.textContent = `${hh}:${mm}`;

    wrapper.appendChild(textSpan);
    const meta = document.createElement('span');
    meta.className = 'msg-meta';
    meta.appendChild(timeSpan);
    const reply = document.createElement('button');
    reply.type = 'button'; reply.className = 'msg-reply'; reply.textContent = 'Reply ↩';
    reply.setAttribute('aria-label', 'Reply to ' + text.slice(0, 60));
    reply.addEventListener('click', () => this.selectReply(data));
    meta.appendChild(reply); wrapper.appendChild(meta);
    let swipe;
    wrapper.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' || e.target.closest('button')) return;
      swipe = { x: e.clientX, y: e.clientY, id: e.pointerId, dx: 0 };
    });
    wrapper.addEventListener('pointermove', e => {
      if (!swipe || e.pointerId !== swipe.id) return;
      if (Math.abs(e.clientY - swipe.y) > 24) { swipe = null; wrapper.style.transform = ''; return; }
      swipe.dx = Math.max(0, e.clientX - swipe.x);
      wrapper.style.transform = `translateX(${Math.min(60, swipe.dx)}px)`;
    }, { passive: true });
    wrapper.addEventListener('pointerup', () => {
      if (swipe?.dx >= 48) this.selectReply(data);
      swipe = null; wrapper.style.transform = '';
    });
    wrapper.addEventListener('pointercancel', () => { swipe = null; wrapper.style.transform = ''; });
    this.messages.appendChild(wrapper);
    while (this.messages.children.length > 80) {
      this.records.delete(Number(this.messages.firstElementChild.dataset.messageId));
      this.messages.firstElementChild.remove();
    }

    this.scrollToBottom();

    // Unread badge, sound chime & toast when panel is collapsed and message is from partner
    if (!isSelf && !silent) {
      this.playChime();
      if (navigator.vibrate) {
        try { navigator.vibrate([40, 50, 40]); } catch (_) {}
      }

      if (this.collapsed) {
        this.incrementUnread();
        this.showChatToast(text);
      }
    }
  }

  /* ─────────── sound alert (Web Audio API) ─────────── */

  unlockAudio() {
    if (!this.soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      this.audioContext ||= new AudioCtx();
      if (this.audioContext.state === 'suspended') this.audioContext.resume().catch(() => {});
      this.suspendWhenIdle();
    } catch (_) {}
  }

  playChime(kind = 'chat') {
    if (!this.soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = this.audioContext || (this.audioContext = new AudioCtx());
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      this.suspendWhenIdle();

      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.setValueAtTime(kind === 'turn' ? 523.25 : 659.25, now);
      osc2.frequency.setValueAtTime(kind === 'turn' ? 783.99 : 880.00, now + 0.08);

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc1.stop(now + 0.12);
      osc2.start(now + 0.08);
      osc2.stop(now + 0.35);
      osc2.onended = () => { osc1.disconnect(); osc2.disconnect(); gain.disconnect(); };
    } catch (_) {
      // Audio policy safe
    }
  }

  showChatToast(text) {
    let toast = document.getElementById('chat-incoming-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'chat-incoming-toast';
      toast.className = 'chat-incoming-toast';
      document.body.appendChild(toast);
      toast.addEventListener('click', () => {
        if (this.collapsed) this.togglePanel();
        toast.classList.remove('visible');
      });
    }

    const preview = text.length > 35 ? text.substring(0, 35) + '…' : text;
    toast.textContent = '💬 ' + preview;
    toast.classList.add('visible');

    clearTimeout(this._chatToastTimer);
    this._chatToastTimer = setTimeout(() => {
      toast.classList.remove('visible');
    }, 4000);
  }

  suspendWhenIdle() {
    clearTimeout(this._audioIdleTimer);
    this._audioIdleTimer = setTimeout(() => this.audioContext?.suspend().catch(() => {}), 2000);
  }

  /**
   * Append a system / informational message (centred, italic).
   * @param {string} text
   */
  addSystemMessage(text) {
    if (!this.messages) return;

    const div = document.createElement('div');
    div.className = 'message system';
    div.textContent = text;
    this.messages.appendChild(div);
    while (this.messages.children.length > 80) {
      this.records.delete(Number(this.messages.firstElementChild.dataset.messageId));
      this.messages.firstElementChild.remove();
    }
    this.scrollToBottom();
  }

  /* ─────────── unread badge ─────────── */

  incrementUnread() {
    this.unreadCount++;
    if (this.badge) {
      this.badge.hidden = false;
      this.badge.textContent = this.unreadCount;
      this.badge.style.display = 'inline-flex';
    }
  }

  clearUnread() {
    this.unreadCount = 0;
    if (this.badge) {
      this.badge.hidden = true;
      this.badge.textContent = '0';
      this.badge.style.display = 'none';
    }
  }

  /* ─────────── helpers ─────────── */

  scrollToBottom() {
    if (this.messages) {
      this.messages.scrollTop = this.messages.scrollHeight;
    }
  }

  selectReply(message) {
    if (this.pending) return;
    this.replyTo = message;
    document.getElementById('reply-preview').hidden = !message;
    if (message) {
      document.getElementById('reply-author').textContent = message.from === this.myPlayer ? 'Replying to you' : 'Replying to your partner';
      document.getElementById('reply-text').textContent = message.text;
      this.input.focus();
    }
  }

  setStatus(text) {
    const status = document.getElementById('chat-status');
    status.textContent = text; status.hidden = !text;
  }

  restore(history, myPlayer) {
    this.myPlayer = myPlayer;
    this.records.clear(); this.messages.replaceChildren();
    for (const message of history || []) this.addMessage(message, true);
    if (this.pending) {
      if (this.sendCallback(this.pending) !== false) this.setStatus('Sending…');
    }
  }

  sendFailed(error) {
    this.pending = null; this.input.readOnly = false; this.sendBtn.disabled = false;
    this.selectReply(null); this.setStatus(error);
  }

  reset() {
    this.pending = null; this.input.readOnly = false; this.sendBtn.disabled = false;
    this.selectReply(null); this.input.value = ''; this.records.clear();
    this.messages.replaceChildren(); this.clearUnread(); this.setStatus('');
    clearTimeout(this._chatToastTimer);
    document.getElementById('chat-incoming-toast')?.classList.remove('visible');
    this.collapsed = true; this.section.classList.add('collapsed');
    this.toggle.setAttribute('aria-expanded', 'false');
  }
}

window.Chat = Chat;
