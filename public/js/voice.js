/**
 * VoiceCall — WebRTC peer-to-peer audio calling with STUN + TURN NAT traversal.
 *
 * Designed to work across different cellular carriers (MTN, Airtel, etc.),
 * Carrier-Grade NAT (CGNAT), and residential Wi-Fi networks worldwide.
 */
class VoiceCall {
  constructor() {
    /** @type {RTCPeerConnection|null} */
    this.pc = null;
    /** @type {MediaStream|null} */
    this.localStream = null;
    this.isMuted = false;
    this.isActive = false;
    this.isConnected = false;
    /** @type {WS|null} */
    this.ws = null;
    this.isInitiator = false;
    /** @type {Function|null} */
    this.stateCallback = null;
    /** @type {Function|null} */
    this.incomingCallCallback = null;

    // Remote audio element (hidden, autoplay, playsinline for iOS/Android)
    this.remoteAudio = document.createElement('audio');
    this.remoteAudio.autoplay = true;
    this.remoteAudio.setAttribute('playsinline', '');
    this.remoteAudio.setAttribute('webkit-playsinline', '');
    this.remoteAudio.style.display = 'none';
    document.body.appendChild(this.remoteAudio);

    // Global STUN and TURN relay servers to punch through Symmetric NAT & cellular firewalls
    this.ICE_SERVERS = [
      // Primary STUN servers
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.relay.metered.ca:80' },
      // OpenRelay TURN servers (UDP 80 & 443 + TCP 443 fallback for strict carrier firewalls)
      {
        urls: [
          'turn:standard.relay.metered.ca:80',
          'turn:standard.relay.metered.ca:443',
          'turn:standard.relay.metered.ca:443?transport=tcp',
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject',
      },
    ];

    // Internal state queues
    this._pendingCandidates = [];
    this._starting = false;
    this._remoteReady = false;
    this._offering = false;
    this._pendingOffer = null;
    this._generation = 0;
  }

  /* ─────────── audio unlock (mobile autoplay workaround) ─────────── */

  unlockAudio() {
    if (this.remoteAudio) {
      try {
        this.remoteAudio.play().catch(() => {});
      } catch (_) {}
    }
  }

  /* ─────────── initialise call ─────────── */

  /**
   * Start or accept a voice call.
   * @param {WS}      wsInstance   The shared WebSocket wrapper
   * @param {boolean} initiator   true = this peer creates the offer
   */
  async init(wsInstance, initiator) {
    if (this.isActive || this._starting || !wsInstance?.connected) return;
    this._starting = true;
    const generation = this._generation;
    this.ws = wsInstance;
    this.isInitiator = initiator;

    // Unlock audio context inside user click gesture
    this.unlockAudio();

    try {
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      if (generation !== this._generation) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.localStream = stream;
    } catch (err) {
      console.warn('[Voice] Mic access denied or unavailable:', err.message);
      this._starting = false;
      this.notifyState();
      return;
    }

    // Create peer connection with full STUN + TURN pool
    try {
      const config = {
        iceServers: window.PLAYTOGETHER_ICE_SERVERS || this.ICE_SERVERS,
        iceCandidatePoolSize: 4,
      };
      this.pc = new RTCPeerConnection(config);
    } catch (err) {
      console.error('[Voice] Failed to create RTCPeerConnection:', err);
      this.stop();
      return;
    }

    // Add local audio tracks
    for (const track of this.localStream.getTracks()) {
      this.pc.addTrack(track, this.localStream);
    }

    // Receive remote audio
    this.pc.ontrack = (event) => {
      console.log('[Voice] Received remote audio stream');
      if (this.remoteAudio) {
        this.remoteAudio.srcObject = event.streams[0] || new MediaStream([event.track]);
        this.remoteAudio.play().catch((e) => {
          console.warn('[Voice] Remote audio play prevented:', e);
        });
      }
    };

    // Send ICE candidates to remote peer via WebSocket signaling
    this.pc.onicecandidate = (event) => {
      if (event.candidate && this.ws) {
        this.ws.send({
          type: 'signal',
          data: { type: 'ice', candidate: event.candidate },
        });
      }
    };

    // Monitor connection state
    this.pc.onconnectionstatechange = () => {
      const state = this.pc ? this.pc.connectionState : 'closed';
      console.log('[Voice] WebRTC Connection state:', state);

      if (state === 'connected') {
        this.isConnected = true;
        this.notifyState();
      } else if (state === 'disconnected') {
        this.isConnected = false;
        this.notifyState();
      } else if (state === 'failed') {
        this.isConnected = false;
        console.warn('[Voice] Connection failed, attempting ICE restart...');
        try {
          this.pc.restartIce();
        } catch (_) {
          this.stop();
        }
      } else if (state === 'closed') {
        this.stop(false);
      }
    };

    this.isActive = true;
    this._starting = false;
    this.notifyState();

    // Broadcast that call has started so remote partner gets notified to join
    this.ws.send({ type: 'signal', data: { type: 'call_started' } });
    this.ws.send({ type: 'signal', data: { type: 'ready' } });

    // If an offer was pending while waiting for local mic permission, process it now
    if (this._pendingOffer) {
      const offer = this._pendingOffer;
      this._pendingOffer = null;
      await this.handleSignal(offer);
    }

    await this.maybeOffer();
  }

  async maybeOffer() {
    if (this.isActive && this.isInitiator && this._remoteReady && !this._offering && this.pc?.signalingState === 'stable') {
      this._offering = true;
      try {
        const offer = await this.pc.createOffer({
          offerToReceiveAudio: true,
        });
        await this.pc.setLocalDescription(offer);
        this.ws.send({
          type: 'signal',
          data: { type: 'offer', sdp: this.pc.localDescription },
        });
      } catch (err) {
        console.error('[Voice] Failed to create offer:', err);
        this._offering = false;
      }
    }
  }

  /* ─────────── signalling handler ─────────── */

  /**
   * Handle an incoming signalling message from the remote peer.
   */
  async handleSignal(data) {
    if (!data || typeof data !== 'object') return;

    try {
      if (data.type === 'call_started') {
        // Partner started a call; notify UI to show incoming prompt if we aren't active yet
        if (!this.isActive && !this._starting) {
          if (this.incomingCallCallback) {
            this.incomingCallCallback(true);
          }
        }
        return;
      }

      if (data.type === 'hangup') {
        if (this.incomingCallCallback) {
          this.incomingCallCallback(false);
        }
        this.stop(false);
        return;
      }

      if (data.type === 'ready') {
        this._remoteReady = true;
        await this.maybeOffer();
        return;
      }

      if (data.type === 'offer') {
        // If local user hasn't joined yet, queue the offer and notify UI
        if (!this.pc) {
          this._pendingOffer = data;
          if (this.incomingCallCallback) {
            this.incomingCallCallback(true);
          }
          return;
        }

        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

        // Flush any queued ICE candidates
        for (const c of this._pendingCandidates) {
          try {
            await this.pc.addIceCandidate(c);
          } catch (_) {}
        }
        this._pendingCandidates = [];

        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);

        this.ws.send({
          type: 'signal',
          data: { type: 'answer', sdp: this.pc.localDescription },
        });
      } else if (data.type === 'answer') {
        if (this.pc && this.pc.signalingState !== 'closed') {
          await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

          // Flush queued ICE candidates
          for (const c of this._pendingCandidates) {
            try {
              await this.pc.addIceCandidate(c);
            } catch (_) {}
          }
          this._pendingCandidates = [];
        }
      } else if (data.type === 'ice') {
        if (data.candidate) {
          if (this.pc && this.pc.remoteDescription) {
            try {
              await this.pc.addIceCandidate(data.candidate);
            } catch (e) {
              console.warn('[Voice] Error adding ICE candidate:', e);
            }
          } else {
            // Queue until remote description is set
            if (this._pendingCandidates.length < 64) {
              this._pendingCandidates.push(data.candidate);
            }
          }
        }
      }
    } catch (err) {
      console.error('[Voice] Signal handling error:', err);
    }
  }

  /* ─────────── controls ─────────── */

  /** Toggle microphone mute. */
  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        track.enabled = !this.isMuted;
      }
    }
    this.notifyState();
  }

  /** End the call and release all resources. */
  stop(notify = true) {
    if (notify && (this.isActive || this._starting)) {
      this.ws?.send({ type: 'signal', data: { type: 'hangup' } });
    }

    this._generation++;
    this._starting = false;
    this._remoteReady = false;
    this._offering = false;
    this._pendingOffer = null;

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }

    if (this.pc) {
      this.pc.onconnectionstatechange = null;
      this.pc.onicecandidate = null;
      this.pc.ontrack = null;
      this.pc.close();
      this.pc = null;
    }

    if (this.remoteAudio) {
      this.remoteAudio.srcObject = null;
    }

    this.isActive = false;
    this.isConnected = false;
    this.isMuted = false;
    this._pendingCandidates = [];
    this.notifyState();
  }

  /* ─────────── callbacks ─────────── */

  /**
   * Register a callback for voice state changes.
   * @param {Function} cb Receives { isActive: boolean, isConnected: boolean, isMuted: boolean }
   */
  onStateChange(cb) {
    this.stateCallback = cb;
  }

  /**
   * Register a callback when partner initiates a call.
   * @param {Function} cb Receives boolean (hasIncomingCall)
   */
  onIncomingCall(cb) {
    this.incomingCallCallback = cb;
  }

  notifyState() {
    if (this.stateCallback) {
      this.stateCallback({
        isActive: this.isActive,
        isConnected: this.isConnected,
        isMuted: this.isMuted,
      });
    }
  }
}

window.VoiceCall = VoiceCall;
