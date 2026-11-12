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
    this.unlock();
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
    this.gen++;
    const c = this.current; this.current = null;
    if (c) { try { c.src.onended = null; c.src.stop(); } catch { /* 이미 끝남 */ } c.resolve(false); }
  }

  /** 띵 소리(대화 연결 중 알림). */
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
