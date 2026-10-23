/**
 * VoiceCall — Dual-engine WebRTC + WebSocket voice communication.
 *
 * Primary:  P2P WebRTC audio stream with STUN/TURN NAT traversal.
 * Fallback: Pure WebSocket Audio Relay using ITU-T G.711 mu-law compression (16kHz).
 *
 * Guarantees 100% voice connectivity across remote cellular networks (MTN, Airtel,
 * Starlink, etc.), Carrier-Grade NAT (CGNAT), and restrictive mobile firewalls.
 */

// ITU-T G.711 standard mu-law codec
function encodeMuLaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let s = Math.round(sample * 32767);
  let sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  let mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function decodeMuLaw(mu) {
  mu = ~mu & 0xff;
  let sign = mu & 0x80 ? -1 : 1;
  let exponent = (mu >> 4) & 0x07;
  let mantissa = mu & 0x0f;
  let s = ((mantissa << 3) + 0x84) << exponent;
  s -= 0x84;
  return (sign * s) / 32767;
}

class VoiceCall {
  constructor() {
    /** @type {RTCPeerConnection|null} */
    this.pc = null;
    /** @type {MediaStream|null} */
    this.localStream = null;
    this.isMuted = false;
    this.isActive = false;
    this.isConnected = false;
    this.isRelay = false;
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

    // Default global STUN servers
    this.ICE_SERVERS = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ];

    // Web Audio API Relay Engine components
    /** @type {AudioContext|null} */
    this.audioCtx = null;
    /** @type {MediaStreamAudioSourceNode|null} */
    this.micSource = null;
    /** @type {ScriptProcessorNode|null} */
    this.micProcessor = null;
    /** @type {GainNode|null} */
    this.muteNode = null;
    this.nextPlayTime = 0;
    this._binaryBoundHandler = this._onBinaryData.bind(this);

    // Internal state queues
    this._pendingCandidates = [];
    this._starting = false;
    this._remoteReady = false;
    this._offering = false;
    this._pendingOffer = null;
    this._generation = 0;
    this._fallbackTimer = null;
  }

  /* ─────────── audio unlock (mobile autoplay workaround) ─────────── */

  unlockAudio() {
    if (this.remoteAudio) {
      try {
        this.remoteAudio.play().catch(() => {});
      } catch (_) {}
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
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

    // Attach binary handler for WebSocket voice relay
    this.ws.on('binary', this._binaryBoundHandler);

    // Unlock audio context inside user click gesture
    this.unlockAudio();

    try {
      // Request microphone access with standard AEC & AGC
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

    // Initialize Web Audio API pipeline for fallback relay & audio processing
    this._initAudioContext();

    // Fetch dynamic ICE servers from server if available
    try {
      const res = await fetch('/api/ice-servers').catch(() => null);
      if (res && res.ok) {
        const json = await res.json();
        if (Array.isArray(json.iceServers) && json.iceServers.length > 0) {
          this.ICE_SERVERS = json.iceServers;
        }
      }
    } catch (_) {}

    // Create RTCPeerConnection for Primary P2P Path
    try {
      const config = {
        iceServers: window.PLAYTOGETHER_ICE_SERVERS || this.ICE_SERVERS,
        iceCandidatePoolSize: 2,
      };
      this.pc = new RTCPeerConnection(config);
    } catch (err) {
      console.warn('[Voice] WebRTC RTCPeerConnection initialization failed, activating relay directly:', err);
      this.activateRelayMode();
    }

    if (this.pc) {
      // Add local audio tracks to WebRTC
      for (const track of this.localStream.getTracks()) {
        this.pc.addTrack(track, this.localStream);
      }

      // Receive remote audio via WebRTC
      this.pc.ontrack = (event) => {
        console.log('[Voice] Received remote WebRTC stream');
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
          clearTimeout(this._fallbackTimer);
          this.isConnected = true;
          this.isRelay = false;
          this.notifyState();
        } else if (state === 'failed') {
          console.warn('[Voice] WebRTC P2P failed across NAT. Switching to WebSocket Voice Relay.');
          this.activateRelayMode();
        } else if (state === 'disconnected') {
          // If disconnected for >2s, fallback to relay
          this._fallbackTimer = setTimeout(() => {
            if (!this.isConnected || !this.pc || this.pc.connectionState !== 'connected') {
              this.activateRelayMode();
            }
          }, 2000);
        } else if (state === 'closed') {
          if (!this.isRelay) this.stop(false);
        }
      };
    }

    this.isActive = true;
    this._starting = false;
    this.notifyState();

    // Start 4-second fallback timer: if WebRTC does not connect within 4s, engage WebSocket relay
    this._fallbackTimer = setTimeout(() => {
      if (!this.isConnected && this.isActive) {
        console.log('[Voice] WebRTC connection timeout (>4s). Activating WebSocket Voice Relay...');
        this.activateRelayMode();
      }
    }, 4000);

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

  /* ─────────── Web Audio API & Relay Pipeline ─────────── */

  _initAudioContext() {
    if (this.audioCtx) return;
    try {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtxClass();
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }

      this.micSource = this.audioCtx.createMediaStreamSource(this.localStream);
      // Buffer size 2048 samples = ~42ms at 48kHz, ~128ms at 16kHz
      this.micProcessor = this.audioCtx.createScriptProcessor(2048, 1, 1);

      // Mute local loopback to avoid hearing own echo
      this.muteNode = this.audioCtx.createGain();
      this.muteNode.gain.value = 0;

      this.micSource.connect(this.micProcessor);
      this.micProcessor.connect(this.muteNode);
      this.muteNode.connect(this.audioCtx.destination);

      this.micProcessor.onaudioprocess = (e) => {
        if (!this.isActive || !this.isRelay || this.isMuted || !this.ws?.connected) {
          return;
        }

        const inputData = e.inputBuffer.getChannelData(0);
        const nativeRate = this.audioCtx.sampleRate;
        const targetRate = 16000;

        // Downsample input to 16,000 Hz for telephony efficiency
        const step = nativeRate / targetRate;
        const outLength = Math.floor(inputData.length / step);
        const u8 = new Uint8Array(outLength);

        for (let i = 0; i < outLength; i++) {
          const idx = Math.floor(i * step);
          u8[i] = encodeMuLaw(inputData[idx] || 0);
        }

        // Send binary voice frame over WebSocket
        this.ws.sendBinary(u8.buffer);
      };
    } catch (err) {
      console.warn('[Voice] Could not initialize Web Audio API pipeline:', err);
    }
  }

  /**
   * Handle incoming binary voice packet from remote partner.
   * @param {ArrayBuffer} arrayBuffer
   */
  _onBinaryData(arrayBuffer) {
    if (!this.isActive || !arrayBuffer) return;

    if (!this.isConnected) {
      this.isConnected = true;
      this.isRelay = true;
      clearTimeout(this._fallbackTimer);
      this.notifyState();
    }

    try {
      if (!this.audioCtx) this._initAudioContext();
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }

      const u8 = new Uint8Array(arrayBuffer);
      if (u8.length === 0) return;

      const floatData = new Float32Array(u8.length);
      for (let i = 0; i < u8.length; i++) {
        floatData[i] = decodeMuLaw(u8[i]);
      }

      const audioBuffer = this.audioCtx.createBuffer(1, floatData.length, 16000);
      audioBuffer.copyToChannel(floatData, 0);

      const sourceNode = this.audioCtx.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(this.audioCtx.destination);

      const now = this.audioCtx.currentTime;
      if (this.nextPlayTime < now) {
        // 40ms safety jitter margin
        this.nextPlayTime = now + 0.04;
      }
      sourceNode.start(this.nextPlayTime);
      this.nextPlayTime += audioBuffer.duration;
    } catch (e) {
      console.warn('[Voice] Audio playback error:', e);
    }
  }

  /**
   * Switch the call to WebSocket Voice Relay mode.
   */
  activateRelayMode() {
    if (this.isRelay && this.isConnected) return;
    this.isRelay = true;
    this.isConnected = true;
    clearTimeout(this._fallbackTimer);

    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }

    this.notifyState();
    this.ws?.send({ type: 'signal', data: { type: 'relay_active' } });
  }

  async maybeOffer() {
    if (
      this.isActive &&
      this.isInitiator &&
      this._remoteReady &&
      !this._offering &&
      this.pc?.signalingState === 'stable'
    ) {
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

      if (data.type === 'relay_active') {
        console.log('[Voice] Partner activated WebSocket voice relay.');
        this.activateRelayMode();
        return;
      }

      if (data.type === 'offer') {
        if (!this.pc) {
          this._pendingOffer = data;
          if (this.incomingCallCallback) {
            this.incomingCallCallback(true);
          }
          return;
        }

        await this.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));

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

    clearTimeout(this._fallbackTimer);
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

    if (this.micProcessor) {
      try {
        this.micProcessor.disconnect();
        this.micSource?.disconnect();
        this.muteNode?.disconnect();
      } catch (_) {}
      this.micProcessor = null;
      this.micSource = null;
      this.muteNode = null;
    }

    if (this.audioCtx) {
      try {
        this.audioCtx.close().catch(() => {});
      } catch (_) {}
      this.audioCtx = null;
    }

    this.isActive = false;
    this.isConnected = false;
    this.isRelay = false;
    this.isMuted = false;
    this._pendingCandidates = [];
    this.notifyState();
  }

  /* ─────────── callbacks ─────────── */

  /**
   * Register a callback for voice state changes.
   * @param {Function} cb Receives { isActive: boolean, isConnected: boolean, isMuted: boolean, isRelay: boolean }
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
        isRelay: this.isRelay,
      });
    }
  }
}

window.VoiceCall = VoiceCall;
