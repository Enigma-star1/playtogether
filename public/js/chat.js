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
    if (!text) return;

    if (this.sendCallback && this.sendCallback(text) === false) return;

    this.input.value = '';
    this.input.focus();
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
  addMessage(text, fromPlayer, isSelf, timestamp) {
    if (!this.messages) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'message ' + (isSelf ? 'self' : 'other');

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
    wrapper.appendChild(timeSpan);
    this.messages.appendChild(wrapper);
    while (this.messages.children.length > 200) this.messages.firstElementChild.remove();

    this.scrollToBottom();

    // Unread badge, sound chime & toast when panel is collapsed and message is from partner
    if (!isSelf) {
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

  playChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = this.audioContext || (this.audioContext = new AudioCtx());
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});

      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.setValueAtTime(659.25, now);        // E5
      osc2.frequency.setValueAtTime(880.00, now + 0.08); // A5

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.25, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc1.stop(now + 0.12);
      osc2.start(now + 0.08);
      osc2.stop(now + 0.35);
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
    while (this.messages.children.length > 200) this.messages.firstElementChild.remove();
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
      this.messages.scrollTo({ top: this.messages.scrollHeight, behavior: 'smooth' });
    }
  }
}

window.Chat = Chat;
