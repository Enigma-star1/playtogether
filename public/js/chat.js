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

    if (this.sendCallback) this.sendCallback(text);

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

    this.scrollToBottom();

    // Unread badge when panel is collapsed and the message isn't ours
    if (this.collapsed && !isSelf) {
      this.incrementUnread();
    }
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
    this.scrollToBottom();
  }

  /* ─────────── unread badge ─────────── */

  incrementUnread() {
    this.unreadCount++;
    if (this.badge) {
      this.badge.textContent = this.unreadCount;
      this.badge.style.display = 'inline-flex';
    }
  }

  clearUnread() {
    this.unreadCount = 0;
    if (this.badge) {
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
