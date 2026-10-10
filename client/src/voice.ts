// Squad voice: WebRTC between teammates (up to 4, a full mesh), signalled through the game server.
// Push to talk (hold V); U mutes your squad. The mic is only asked for the first time you press V.
// Audio goes peer to peer; the server only relays the handshake, and only between teammates.
type Send = (to: number, data: unknown) => void;
interface Sig { k: 'offer' | 'answer' | 'ice'; sdp?: RTCSessionDescriptionInit; cand?: RTCIceCandidateInit }

const ICE: RTCConfiguration = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

class Voice {
  private pcs = new Map<number, { pc: RTCPeerConnection; audio: HTMLAudioElement; level: () => number }>();
  private me = 0;
  private send: Send | null = null;
  private mic: MediaStreamTrack | null = null;
  private asking = false;
  talking = false;
  deaf = false;
  private ctx: AudioContext | null = null;

  get active() { return this.pcs.size > 0; }

  start(me: number, mates: number[], send: Send) {
    this.stop();
    if (typeof RTCPeerConnection === 'undefined' || !mates.length) return;
    this.me = me; this.send = send;
    for (const id of mates) this.peer(id);
  }
  stop() {
    for (const { pc, audio } of this.pcs.values()) { pc.close(); audio.srcObject = null; audio.remove(); }
    this.pcs.clear();
    this.talking = false; this.want = false;
    this.mic?.stop(); this.mic = null; // hand the microphone back (the browser's recording light goes off)
  }

  private peer(id: number) {
    let p = this.pcs.get(id);
    if (p) return p;
    const pc = new RTCPeerConnection(ICE);
    const audio = document.createElement('audio'); audio.autoplay = true; document.body.appendChild(audio);
    let analyser: AnalyserNode | null = null;
    const buf = new Uint8Array(256);
    const level = () => { if (!analyser) return 0; analyser.getByteTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v - 128)); return m / 128; };
    const tr = pc.addTransceiver('audio', { direction: 'sendrecv' });
    if (this.mic) void tr.sender.replaceTrack(this.mic);
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      audio.srcObject = stream; audio.muted = this.deaf; void audio.play().catch(() => {});
      try { this.ctx ??= new AudioContext(); analyser = this.ctx.createAnalyser(); this.ctx.createMediaStreamSource(stream).connect(analyser); } catch { /* no meter */ }
    };
    pc.onicecandidate = (e) => { if (e.candidate) this.send?.(id, { k: 'ice', cand: e.candidate.toJSON() } satisfies Sig); };
    p = { pc, audio, level };
    this.pcs.set(id, p);
    // the lower id calls; the other answers
    if (this.me < id) void (async () => { const o = await pc.createOffer(); await pc.setLocalDescription(o); this.send?.(id, { k: 'offer', sdp: o } satisfies Sig); })();
    return p;
  }

  async onSignal(from: number, data: unknown) {
    const s = data as Sig;
    if (!s || typeof s !== 'object' || !this.send) return;
    const { pc } = this.peer(from);
    try {
      if (s.k === 'offer' && s.sdp) {
        await pc.setRemoteDescription(s.sdp);
        const a = await pc.createAnswer(); await pc.setLocalDescription(a);
        this.send(from, { k: 'answer', sdp: a } satisfies Sig);
      } else if (s.k === 'answer' && s.sdp) await pc.setRemoteDescription(s.sdp);
      else if (s.k === 'ice' && s.cand) await pc.addIceCandidate(s.cand);
    } catch (e) { console.warn('[voice]', (e as Error).message); }
  }

  // push to talk: the first press asks for the microphone
  // (V let go while the permission prompt was open must not leave the mic open once it is granted)
  private want = false;
  async talk(on: boolean) {
    this.want = on;
    if (!this.active) return;
    if (on && !this.mic && !this.asking) {
      this.asking = true;
      try {
        const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        const track = st.getAudioTracks()[0];
        if (!this.active) { track?.stop(); return; } // the match ended while we asked
        this.mic = track;
        for (const { pc } of this.pcs.values()) for (const t of pc.getTransceivers()) void t.sender.replaceTrack(this.mic);
      } catch { /* no mic or refused */ } finally { this.asking = false; }
    }
    if (this.mic) this.mic.enabled = this.want;
    this.talking = this.want && !!this.mic;
  }
  setDeaf(d: boolean) { this.deaf = d; for (const { audio } of this.pcs.values()) audio.muted = d; }
  // who is talking right now (a quick level meter on each teammate's stream)
  speaking(id: number) { return (this.pcs.get(id)?.level() ?? 0) > 0.06; }
}

export const voice = new Voice();
