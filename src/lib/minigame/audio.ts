/* 🎮 散財ダッシュ — 効果音と BGM。効果音は WebAudio で短い矩形波・ノイズを合成する（音源ファイルなし）。
 * BGM（オーナー提供、65.52 秒のループ）は public/minigame/bgm-*.m4a を走っているあいだだけ鳴らす。最初の
 * 操作のあとに初めて取りに行き（1 MB）、AudioBuffer のループで継ぎ目なく回す。
 * ジュークボックス・ボイスルームの音を止めないよう、使えるなら navigator.audioSession.type = "ambient"
 * （他の音と混ぜる）にし、音量は控えめ。消音（効果音と BGM の両方）は設定（localStorage）。 */

export type SfxName = "jump" | "jump2" | "sd" | "coffee" | "lamp" | "money" | "hit" | "choose" | "powerup" | "dead" | "revive" | "slow" | "highscore" | "select" | "dive";

const MUTE_KEY = "bguru-minigame-mute";
const MASTER = 0.16;
/** BGM の音量（効果音とは別の系統。効果音が埋もれない大きさ）。 */
const BGM_GAIN = 0.32;
export const BGM_URL = "/minigame/bgm-02f03e10e6.m4a";
/** 元の WAV の長さ（48 kHz で 3,144,960 フレーム）。AAC の先頭の詰め物をデコーダが残したときはその分ずらす。 */
const BGM_LOOP_SEC = 65.52;
const BGM_FADE_SEC = 0.6;

type Nav = Navigator & { audioSession?: { type?: string } };
type W = Window & { webkitAudioContext?: typeof AudioContext };

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private bgmGain: GainNode | null = null;
  private bgmBuf: AudioBuffer | null = null;
  private bgmLoading = false;
  private bgmSrc: AudioBufferSourceNode | null = null;
  /** 鳴らしたい（走っている）か。読み込みが後から終わったときにも見る。 */
  private bgmWanted = false;
  /** 次に鳴らすときの位置（秒）。一時停止は位置を残し、やられた・タイトルでは 0 に戻す。 */
  private bgmOffset = 0;
  private bgmStartedAt = 0;
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
    if (m) this.stopBgmNow(true);
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
    this.loadBgm();
    if (this.bgmWanted) this.startBgm();
  }

  /** 走っているあいだ true。false で止める（reset なら次は頭から、でなければ続きから）。 */
  bgm(on: boolean, reset = false): void {
    this.bgmWanted = on;
    if (on) this.startBgm();
    else this.stopBgm(reset);
  }

  private loadBgm(): void {
    const c = this.ctx;
    if (!c || this.bgmBuf || this.bgmLoading || typeof fetch === "undefined") return;
    this.bgmLoading = true;
    fetch(BGM_URL)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((ab) => new Promise<AudioBuffer>((res, rej) => c.decodeAudioData(ab, res, rej)))
      .then((buf) => {
        this.bgmBuf = buf;
        if (this.bgmWanted) this.startBgm();
      })
      .catch(() => {
        /* BGM なしで遊べる */
      })
      .finally(() => {
        this.bgmLoading = false;
      });
  }

  private startBgm(): void {
    const c = this.ctx;
    if (this.muted || !c || !this.master || !this.bgmBuf || this.bgmSrc) return;
    if (!this.bgmGain) {
      this.bgmGain = c.createGain();
      this.bgmGain.connect(c.destination);
    }
    const buf = this.bgmBuf;
    // デコーダが AAC の先頭の詰め物（2112 フレーム）を残したときは、その分あとからループする。
    const lead = Math.max(0, Math.min(0.1, buf.duration - BGM_LOOP_SEC - 704 / 48000));
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = lead;
    src.loopEnd = Math.min(buf.duration, lead + BGM_LOOP_SEC);
    src.connect(this.bgmGain);
    const t0 = c.currentTime;
    this.bgmGain.gain.cancelScheduledValues(t0);
    this.bgmGain.gain.setValueAtTime(0.0001, t0);
    this.bgmGain.gain.exponentialRampToValueAtTime(BGM_GAIN, t0 + 0.25);
    src.start(t0, lead + (this.bgmOffset % BGM_LOOP_SEC));
    this.bgmSrc = src;
    this.bgmStartedAt = t0 - (this.bgmOffset % BGM_LOOP_SEC);
  }

  private stopBgm(reset: boolean): void {
    const c = this.ctx;
    const src = this.bgmSrc;
    if (!src || !c || !this.bgmGain) {
      if (reset) this.bgmOffset = 0;
      return;
    }
    this.bgmOffset = reset ? 0 : (c.currentTime - this.bgmStartedAt) % BGM_LOOP_SEC;
    const t0 = c.currentTime;
    const fade = reset ? BGM_FADE_SEC : 0.12;
    this.bgmGain.gain.cancelScheduledValues(t0);
    this.bgmGain.gain.setValueAtTime(this.bgmGain.gain.value || BGM_GAIN, t0);
    this.bgmGain.gain.exponentialRampToValueAtTime(0.0001, t0 + fade);
    try {
      src.stop(t0 + fade + 0.02);
    } catch {
      /* already stopped */
    }
    this.bgmSrc = null;
  }

  private stopBgmNow(reset: boolean): void {
    try {
      this.bgmSrc?.stop();
    } catch {
      /* already stopped */
    }
    this.bgmSrc = null;
    if (reset) this.bgmOffset = 0;
  }

  close(): void {
    this.stopBgmNow(true);
    this.bgmGain = null;
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
