// 친구 목소리 재생(웹 오디오). 서버가 주는 PCM 16비트 24kHz를 차례로 이어 튼다.
// 아이폰 Safari는 사용자가 누른 뒤에만 소리를 낼 수 있어서, '대화 시작'을 누를 때 unlock()을 부른다.
export class Player {
  constructor() {
    this.ctx = null; this.gain = null; this.volume = 1;
    this.current = null; this.queue = []; this.playing = false; this.gen = 0;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.gain = this.ctx.createGain(); this.gain.gain.value = this.volume; this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    // 아주 짧은 무음을 한 번 틀어 두면 iOS에서 이후 재생이 막히지 않는다
    const b = this.ctx.createBuffer(1, 1, 22050); const s = this.ctx.createBufferSource(); s.buffer = b; s.connect(this.gain); s.start();
  }

  setVolume(v) { this.volume = v; if (this.gain) this.gain.gain.value = v; }
  duck(on) { if (this.gain) this.gain.gain.setTargetAtTime(on ? this.volume * 0.25 : this.volume, this.ctx.currentTime, 0.05); }

  /** PCM 한 덩어리를 틀고, 다 끝나면 resolve(true). 중간에 stop()하면 resolve(false). */
  play(pcm, rate) {
    this.unlock(); this.jingleStop();
    const gen = this.gen;
    return new Promise((resolve) => {
      if (!pcm || pcm.length === 0) return resolve(true);
      const buf = this.ctx.createBuffer(1, pcm.length, rate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
      const src = this.ctx.createBufferSource(); src.buffer = buf; src.connect(this.gain);
      this.current = { src, resolve };
      src.onended = () => { if (this.current?.src === src) this.current = null; resolve(gen === this.gen); };
      src.start();
    });
  }

  get isPlaying() { return !!this.current; }

  stop() {
    this.gen++; this.jingleStop();
    const c = this.current; this.current = null;
    if (c) { try { c.src.onended = null; c.src.stop(); } catch { /* 이미 끝남 */ } c.resolve(false); }
  }

  /** 브랜드 징글(앱과 같은 BILODY 3음, 11/13 14:45). 대화를 여는 동안 틀고, 친구 첫 대답이 나오면 부드럽게 끈다. */
  async jingle() {
    this.unlock(); this.jingleStop();
    const my = (this.jingleGen = (this.jingleGen ?? 0) + 1);
    try {
      if (!this.jingleBuf) this.jingleBuf = await fetch("jingle.mp3?v=1").then((r) => r.arrayBuffer()).then((b) => new Promise((ok, no) => this.ctx.decodeAudioData(b, ok, no)));
      if (my !== this.jingleGen) return;   // 그사이 첫 대답이 나왔거나 멈춤
      const src = this.ctx.createBufferSource(); const g = this.ctx.createGain();
      src.buffer = this.jingleBuf; g.gain.value = 0.8; src.connect(g); g.connect(this.gain);
      src.onended = () => { if (this.jingleNode?.src === src) this.jingleNode = null; };
      this.jingleNode = { src, g }; src.start();
    } catch { this.chime(); }   // 징글을 못 받으면 예전 띵 소리
  }
  /** 징글 끄기(0.25초에 걸쳐 작게). */
  jingleStop() {
    this.jingleGen = (this.jingleGen ?? 0) + 1;
    const n = this.jingleNode; this.jingleNode = null; if (!n || !this.ctx) return;
    const t = this.ctx.currentTime;
    try { n.g.gain.setValueAtTime(n.g.gain.value, t); n.g.gain.linearRampToValueAtTime(0, t + 0.25); n.src.stop(t + 0.3); } catch { /* 이미 끝남 */ }
  }

  /** 띵 소리(징글을 못 틀 때). */
  chime() {
    this.unlock();
    const t = this.ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const o = this.ctx.createOscillator(); const g = this.ctx.createGain();
      o.type = "sine"; o.frequency.value = f; o.connect(g); g.connect(this.gain);
      g.gain.setValueAtTime(0, t + i * 0.12); g.gain.linearRampToValueAtTime(0.15, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.5);
      o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.55);
    });
  }
}
