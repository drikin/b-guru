/* 🎮 散財ダッシュ — 効果音（BGM なし）。WebAudio で短い矩形波・ノイズを合成する（音源ファイルなし）。
 * ジュークボックス・ボイスルームの音を止めないよう、使えるなら navigator.audioSession.type = "ambient"
 * （他の音と混ぜる）にし、音量は控えめ。消音は設定（localStorage）。 */

export type SfxName = "jump" | "jump2" | "sd" | "coffee" | "lamp" | "money" | "hit" | "choose" | "powerup" | "dead" | "revive" | "slow" | "highscore" | "select" | "dive";

const MUTE_KEY = "bguru-minigame-mute";
const MASTER = 0.16;

type Nav = Navigator & { audioSession?: { type?: string } };
type W = Window & { webkitAudioContext?: typeof AudioContext };

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  muted: boolean;

  constructor() {
    let m = false;
    try {
      m = localStorage.getItem(MUTE_KEY) === "1";
    } catch {
      /* no storage */
    }
    this.muted = m;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    try {
      localStorage.setItem(MUTE_KEY, m ? "1" : "0");
    } catch {
      /* no storage */
    }
  }

  /** 最初の操作（タップ・キー）の中で呼ぶ（自動再生の制限）。 */
  unlock(): void {
    if (this.muted) return;
    try {
      const nav = navigator as Nav;
      if (nav.audioSession && nav.audioSession.type !== "ambient") nav.audioSession.type = "ambient";
    } catch {
      /* not supported */
    }
    if (!this.ctx) {
      const AC = (typeof window !== "undefined" && (window.AudioContext || (window as W).webkitAudioContext)) || null;
      if (!AC) return;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = MASTER;
        this.master.connect(this.ctx.destination);
      } catch {
        this.ctx = null;
        return;
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  close(): void {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
  }

  private tone(freq: number, start: number, dur: number, opts: { type?: OscillatorType; to?: number; vol?: number } = {}): void {
    const c = this.ctx;
    if (!c || !this.master) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = opts.type ?? "square";
    const t0 = c.currentTime + start;
    o.frequency.setValueAtTime(freq, t0);
    if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t0 + dur);
    const v = opts.vol ?? 0.5;
    g.gain.setValueAtTime(v, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  private noise(start: number, dur: number, vol = 0.5): void {
    const c = this.ctx;
    if (!c || !this.master) return;
    if (!this.noiseBuf) {
      const n = Math.floor(c.sampleRate * 0.3);
      this.noiseBuf = c.createBuffer(1, n, c.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      let x = 12345;
      for (let i = 0; i < n; i++) {
        x = (Math.imul(x, 1103515245) + 12345) | 0;
        d[i] = ((x >>> 16) & 0x7fff) / 16384 - 1;
      }
    }
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const g = c.createGain();
    const t0 = c.currentTime + start;
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  play(name: SfxName): void {
    if (this.muted || !this.ctx || this.ctx.state !== "running") return;
    switch (name) {
      case "jump":
        this.tone(330, 0, 0.09, { to: 660, vol: 0.35 });
        break;
      case "jump2":
        this.tone(520, 0, 0.08, { to: 900, vol: 0.3 });
        break;
      case "sd":
        this.tone(988, 0, 0.05, { vol: 0.3 });
        this.tone(1319, 0.05, 0.08, { vol: 0.3 });
        break;
      case "coffee":
        [523, 659, 784].forEach((f, i) => this.tone(f, i * 0.05, 0.07, { vol: 0.3 }));
        break;
      case "lamp":
        for (let i = 0; i < 4; i++) this.tone(i % 2 ? 880 : 660, i * 0.05, 0.05, { type: "triangle", vol: 0.45 });
        break;
      case "money":
        this.tone(1568, 0, 0.05, { vol: 0.25 });
        this.tone(2093, 0.06, 0.12, { vol: 0.25 });
        break;
      case "hit":
        this.noise(0, 0.14, 0.5);
        this.tone(140, 0, 0.14, { to: 70, vol: 0.4 });
        break;
      case "choose":
        this.tone(784, 0, 0.08, { type: "triangle", vol: 0.4 });
        this.tone(1047, 0.09, 0.1, { type: "triangle", vol: 0.4 });
        break;
      case "powerup":
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, i * 0.06, 0.08, { vol: 0.3 }));
        break;
      case "dead":
        this.noise(0, 0.2, 0.4);
        [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.05 + i * 0.09, 0.1, { vol: 0.3 }));
        break;
      case "revive":
        [262, 392, 523, 784].forEach((f, i) => this.tone(f, i * 0.05, 0.08, { type: "triangle", vol: 0.45 }));
        break;
      case "slow":
        this.tone(600, 0, 0.25, { type: "triangle", to: 300, vol: 0.3 });
        break;
      case "highscore":
        [523, 659, 784, 1047, 784, 1047].forEach((f, i) => this.tone(f, i * 0.08, i === 5 ? 0.25 : 0.08, { vol: 0.3 }));
        break;
      case "dive":
        this.tone(900, 0, 0.08, { to: 220, vol: 0.3 });
        break;
      case "select":
        this.tone(660, 0, 0.04, { vol: 0.2 });
        break;
    }
  }
}
