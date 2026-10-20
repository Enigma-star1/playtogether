/**
 * VoiceCall — WebRTC peer-to-peer audio calling.
 *
 * Uses a single RTCPeerConnection with audio-only streams.
 * Signalling is relayed through the existing WebSocket connection.
 * ICE candidates use Google's free STUN servers — no TURN needed for
 * most residential connections.
 */
class VoiceCall {
  constructor() {
    /** @type {RTCPeerConnection|null} */
    this.pc = null;
    /** @type {MediaStream|null} */
    this.localStream = null;
    this.isMuted = false;
    this.isActive = false;
    /** @type {WS|null} */
    this.ws = null;
    this.isInitiator = false;
    /** @type {Function|null} */
    this.stateCallback = null;

    // Remote audio element (hidden, autoplay)
    this.remoteAudio = document.createElement('audio');
    this.remoteAudio.autoplay = true;
    this.remoteAudio.style.display = 'none';
    document.body.appendChild(this.remoteAudio);

    this.ICE_SERVERS = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];

    // Queue ICE candidates that arrive before remote description is set
    this._pendingCandidates = [];
  }

  /* ─────────── initialise call ─────────── */

  /**
   * Start or accept a voice call.
   * @param {WS}      wsInstance   The shared WebSocket wrapper
   * @param {boolean} initiator   true = this peer creates the offer
   */
  async init(wsInstance, initiator) {
    this.ws = wsInstance;
    this.isInitiator = initiator;

    try {
      // Request microphone access
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      console.warn('[Voice] Mic access denied or unavailable:', err.message);
      // Don't crash the app — just report state
      this.notifyState();
      return;
    }

    // Create peer connection
    this.pc = new RTCPeerConnection({ iceServers: this.ICE_SERVERS });

    // Add local audio tracks
    for (const track of this.localStream.getTracks()) {
      this.pc.addTrack(track, this.localStream);
    }

    // Receive remote audio
    this.pc.ontrack = (event) => {
      this.remoteAudio.srcObject = event.streams[0] || new MediaStream([event.track]);
    };

    // Send ICE candidates to remote peer
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
      console.log('[Voice] Connection state:', state);
      if (state === 'failed' || state === 'closed') {
        this.stop();
      }
    };

    this.isActive = true;
    this.notifyState();

    // Initiator creates the offer
    if (initiator) {
      try {
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        this.ws.send({
          type: 'signal',
          data: { type: 'offer', sdp: this.pc.localDescription },
        });
      } catch (err) {
        console.error('[Voice] Failed to create offer:', err);
      }
    }
  }

  /* ─────────── signalling handler ─────────── */

  /**
   * Handle an incoming signalling message from the remote peer.
   * @param {{ type: string, sdp?: RTCSessionDescription, candidate?: RTCIceCandidate }} data
   */
  async handleSignal(data) {
    try {
      if (data.type === 'offer') {
        // Incoming call — initialise if not already active
        if (!this.pc) {
          await this.init(this.ws, false);
        }
        if (!this.pc) return; // mic denied

        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

        // Flush any queued ICE candidates
        for (const c of this._pendingCandidates) {
          await this.pc.addIceCandidate(new RTCIceCandidate(c));
        }
        this._pendingCandidates = [];

        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.ws.send({
          type: 'signal',
          data: { type: 'answer', sdp: this.pc.localDescription },
        });
      } else if (data.type === 'answer') {
        if (this.pc) {
          await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

          // Flush queued ICE candidates
          for (const c of this._pendingCandidates) {
            await this.pc.addIceCandidate(new RTCIceCandidate(c));
          }
          this._pendingCandidates = [];
        }
      } else if (data.type === 'ice') {
        if (this.pc && this.pc.remoteDescription) {
          await this.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else {
          // Queue until remote description is set
          this._pendingCandidates.push(data.candidate);
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
  stop() {
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    this.remoteAudio.srcObject = null;
    this.isActive = false;
    this.isMuted = false;
    this._pendingCandidates = [];
    this.notifyState();
  }

  /* ─────────── state callback ─────────── */

  /**
   * Register a callback for voice state changes.
   * @param {Function} cb  Receives { isActive: boolean, isMuted: boolean }
   */
  onStateChange(cb) {
    this.stateCallback = cb;
  }

  notifyState() {
    if (this.stateCallback) {
      this.stateCallback({ isActive: this.isActive, isMuted: this.isMuted });
    }
  }
}

window.VoiceCall = VoiceCall;
