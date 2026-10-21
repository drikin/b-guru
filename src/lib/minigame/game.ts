/* 🎮 散財ダッシュ — ゲームの部品（canvas ＋ 文字は DOM の重ね）。Web 版は直接、アプリは WebView（bridge.ts）で使う。
 *
 *   画面: title（キャラ選び・今日のチャレンジ／自由・自分のベスト・今日の 1 位）→ loading → playing ⇄ choosing（500m ごと）
 *         → dead（結果: 距離・自己ベスト・今日の順位・前回より +m・もう一回・死因）／board（ランキング）／paused
 *   更新は 60Hz の固定刻み（sim.ts）、描画は rAF（120Hz の画面でも刻みは 60）。画面に出ていない・pause のときは rAF を止める。
 *   入力: タップ・クリック（押す／離す）、スペース・↑（押す／離す）。刻み番号つきで記録（InputRecorder）。
 *   サーバとのやりとりは GameHost（Web は fetch、アプリは橋渡しで中継）。トークンはこの部品に入らない。 */
import {
  CHARACTERS,
  E_AIRJUMP,
  E_DIVE,
  E_FALL,
  E_STAGE,
  E_BILLHIT,
  E_CHOOSE,
  E_COFFEE,
  E_DEAD,
  E_HIT,
  E_JUMP,
  E_LAMP,
  E_MONEY,
  E_REVIVE,
  E_SD,
  E_SLOW,
  ENGINE_VERSION,
  InputRecorder,
  P_BILLHALF,
  P_DOUBLE,
  P_MAGNET,
  P_REVIVE,
  START_HEARTS,
  distanceM,
  newSim,
  scoreOf,
  simInput,
  simStep,
  type Character,
  type SimState,
} from "./sim";
import { Renderer, fitView, spriteDataUrl, type Fit } from "./render";
import { Sfx, type SfxName } from "./audio";
import type { FinishResultDto, LeaderboardDto, LeaderEntry, MinigameInfo, MinigameMode, MinigamePeriod, PlayTicket } from "./types";
import { HostError, type GameHost } from "./host";

export { HostError, type FinishPayload, type GameHost, type HapticKind } from "./host";

export type GameOptions = { theme?: "light" | "dark" | "auto"; maxHeight?: number; focused?: boolean };

type Phase = "title" | "loading" | "playing" | "choosing" | "paused" | "dead" | "board";

type Run = {
  mode: MinigameMode;
  character: Character;
  seed: number;
  sim: SimState;
  rec: InputRecorder;
  ticket: PlayTicket | null;
  ticketP: Promise<PlayTicket | null> | null;
  unrecorded: string | null;
};

const STEP_MS = 1000 / 60;
const RETRY_DELAY_MS = 600;
const CHAR_KEY = "bguru-minigame-character";

export const CHARACTER_INFO: Record<Character, { name: string; trait: string }> = {
  drikin: { name: "ドリキン", trait: "散財でコンボが伸びる（請求書もやや多い）" },
  matsuo: { name: "松尾", trait: "空中の 1 回目のタップで小さく跳べる（2 回目で急降下）" },
  zenji: { name: "善司", trait: "障害物の手前で一瞬スロー（10 秒に 1 回）" },
};

export const POWERUP_INFO: Record<number, { name: string; desc: string; icon: [string, string?] }> = {
  [P_DOUBLE]: { name: "二段ジャンプ", desc: "空中でもう 1 回跳べる", icon: ["beagle", "run1"] },
  [P_BILLHALF]: { name: "請求書が半分", desc: "降ってくる請求書が半分に", icon: ["bill"] },
  [P_REVIVE]: { name: "1 回だけ復活", desc: "やられても 1 度だけ立ち直る", icon: ["reclamp"] },
  [P_MAGNET]: { name: "SD カード吸い寄せ", desc: "近くの SD カードが寄ってくる", icon: ["sdcard"] },
};

/** 区間（500m ごと。sim.ts の stage）。 */
export const STAGE_INFO: { name: string; hint: string }[] = [
  { name: "収録スタジオ", hint: "タップでジャンプ・長押しで高く・空中でもう一度タップで急降下" },
  { name: "秋葉原", hint: "ドローンとブームマイクは跳ばずにくぐる" },
  { name: "締め切り前夜", hint: "床の穴は長押しで飛び越える" },
  { name: "散財ナイト", hint: "請求書の雨が降ってくる" },
  { name: "機材の山", hint: "組み合わせが速くなる" },
];

const CAUSE_LABEL: Record<string, string> = {
  drone: "ドローンにぶつかった",
  boom: "ブームマイクに頭をぶつけた",
  pit: "穴に落ちた",
  xlr: "XLR ケーブルに引っかかった",
  micstand: "マイクスタンドにぶつかった",
  box: "段ボールの山にぶつかった",
  deadline: "締め切りに追いつかれた",
};

const PERIOD_LABEL: Record<MinigamePeriod, string> = { today: "今日", week: "今週", all: "通算" };

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
const num = (n: number | null | undefined) => (typeof n === "number" ? n.toLocaleString("ja-JP") : "—");

const STYLE = `
.mg-root{position:relative;width:100%;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:manipulation;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;color:#fdf0d2;line-height:1.25}
.mg-stage{position:relative;margin:0 auto;overflow:hidden;background:#120e14;border-radius:6px}
.mg-canvas{position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;image-rendering:crisp-edges;display:block}
.mg-hud,.mg-ui{position:absolute;inset:0;font-size:var(--fs);pointer-events:none}
.mg-hud{display:flex;justify-content:space-between;align-items:flex-start;padding:4px 6px;text-shadow:0 1px 0 #120e14,1px 0 0 #120e14}
.mg-hud b{font-variant-numeric:tabular-nums}
.mg-hud .mg-l,.mg-hud .mg-r{display:flex;gap:.6em;align-items:center;white-space:nowrap}
.mg-ui button{pointer-events:auto;font:inherit;color:inherit;cursor:pointer;border:0;border-radius:6px;padding:.35em .8em;background:#5b3f7a;box-shadow:0 2px 0 #2b1d3a}
.mg-ui button:disabled{opacity:.45;cursor:default}
.mg-ui button.mg-primary{background:#dc4a3f;box-shadow:0 2px 0 #8c2f39;font-weight:700}
.mg-ui button.mg-ghost{background:rgba(29,24,32,.75);box-shadow:none}
.mg-hud button{pointer-events:auto;font:inherit;color:inherit;background:rgba(29,24,32,.6);border:0;border-radius:5px;padding:.1em .45em;cursor:pointer}
.mg-panel{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.35em;padding:.3em .5em;background:rgba(18,14,20,.55);pointer-events:auto;text-align:center}
.mg-row{display:flex;gap:.45em;align-items:center;justify-content:center;flex-wrap:wrap}
.mg-title{font-weight:800;letter-spacing:.04em;font-size:1.15em}
.mg-dim{opacity:.8;font-size:.9em}
.mg-chars{display:flex;gap:.4em}
.mg-char{display:flex;flex-direction:column;align-items:center;padding:.15em .35em !important;background:rgba(43,29,58,.85) !important;box-shadow:none !important;border:2px solid transparent !important}
.mg-char[aria-pressed="true"]{border-color:#f2b24c !important;background:rgba(91,63,122,.95) !important}
.mg-char img,.mg-ico{image-rendering:pixelated;display:block}
.mg-big{font-size:1.5em;font-weight:800;font-variant-numeric:tabular-nums}
.mg-new{color:#f2b24c;font-weight:800}
.mg-cards{display:flex;gap:.5em}
.mg-card{display:flex;flex-direction:column;align-items:center;gap:.15em;max-width:11em;background:#2b1d3a !important;border:2px solid #f2b24c !important}
.mg-list{width:min(100%,26em);overflow:auto;flex:1 1 auto;min-height:0;text-align:left;font-size:.95em}
.mg-list div{display:flex;gap:.5em;padding:.1em .3em}
.mg-list div.me{background:rgba(242,178,76,.25);border-radius:4px}
.mg-list span.r{width:2.2em;text-align:right;opacity:.8}
.mg-list span.n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mg-list span.s{font-variant-numeric:tabular-nums}
.mg-tabs button{padding:.15em .6em}
.mg-tabs button[aria-pressed="true"]{background:#f2b24c;color:#120e14}
.mg-note{position:absolute;left:0;right:0;bottom:4px;text-align:center;font-size:.9em;pointer-events:none}
.mg-note span{background:rgba(18,14,20,.85);padding:.15em .6em;border-radius:5px}
.mg-banner{position:absolute;left:0;right:0;top:38%;text-align:center;font-size:.95em;text-shadow:0 1px 0 #120e14,1px 0 0 #120e14,-1px 0 0 #120e14,0 -1px 0 #120e14}
.mg-banner b{color:#f2b24c}
.mg-bubble{background:#fdf0d2;color:#120e14;border-radius:8px;padding:.15em .6em;font-weight:700}
`;

function injectStyle(): void {
  if (typeof document === "undefined" || document.getElementById("bguru-minigame-style")) return;
  const st = document.createElement("style");
  st.id = "bguru-minigame-style";
  st.textContent = STYLE;
  document.head.appendChild(st);
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

export class DashGame {
  private root: HTMLDivElement;
  private stage: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private hud: HTMLDivElement;
  private ui: HTMLDivElement;
  private renderer: Renderer;
  private sfx = new Sfx();
  private host: GameHost;

  private phase: Phase = "title";
  private before: Phase = "title"; // ランキングを閉じたら戻る画面
  private character: Character = "drikin";
  private info: Partial<MinigameInfo> = {};
  private run: Run | null = null;
  private lastResult: FinishResultDto | null = null;
  private finishing = false;
  private finishError: string | null = null;
  private lastDistance: Partial<Record<MinigameMode, number>> = {};
  private prefetch: { ticket: PlayTicket; at: number } | null = null;
  private deadAt = 0;
  private restShown = false;
  /** 区間が替わったときの帯（刻みで消える）。 */
  private stageBanner: { stage: number; until: number } | null = null;
  private board: { period: MinigamePeriod; data: LeaderboardDto | null; loading: boolean; error: string | null } = {
    period: "today",
    data: null,
    loading: false,
    error: null,
  };

  private queue: number[] = [];
  private pressed = false;
  private focused: boolean;
  private raf = 0;
  private lastFrame = 0;
  private acc = 0;
  private frameT = 0;
  private hostPaused = false;
  private hidden = false;
  private offscreen = false;
  private fit: Fit = { k: 1, w: 256, cssW: 256, cssH: 144, dpr: 1 };
  private maxHeight: number;
  private hudText: string | null = null;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private ro: ResizeObserver | null = null;
  private io: IntersectionObserver | null = null;
  private destroyed = false;

  constructor(el: HTMLElement, host: GameHost, opts: GameOptions = {}) {
    injectStyle();
    this.host = host;
    this.maxHeight = opts.maxHeight && opts.maxHeight > 0 ? opts.maxHeight : 320;
    this.focused = opts.focused ?? false;
    try {
      const c = localStorage.getItem(CHAR_KEY);
      if (c && (CHARACTERS as string[]).includes(c)) this.character = c as Character;
    } catch {
      /* no storage */
    }
    this.root = document.createElement("div");
    this.root.className = "mg-root";
    this.root.setAttribute("data-cx", "minigame");
    this.stage = document.createElement("div");
    this.stage.className = "mg-stage";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "mg-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    this.hud = document.createElement("div");
    this.hud.className = "mg-hud";
    this.ui = document.createElement("div");
    this.ui.className = "mg-ui";
    this.stage.append(this.canvas, this.hud, this.ui);
    this.root.append(this.stage);
    el.appendChild(this.root);
    this.renderer = new Renderer(this.canvas);
    this.setTheme(opts.theme ?? "auto");

    this.root.addEventListener("pointerdown", this.onPointerDown);
    this.root.addEventListener("click", this.onClick);
    this.root.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("pointercancel", this.onPointerUp);
    window.addEventListener("pointerdown", this.onWindowPointerDown, true);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.hidden = document.visibilityState === "hidden";
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.layout());
      this.ro.observe(el);
    }
    if (typeof IntersectionObserver !== "undefined") {
      this.io = new IntersectionObserver((es) => {
        const vis = es.some((e) => e.isIntersecting);
        this.offscreen = !vis;
        if (!vis) this.pauseRun();
        this.updateLoop();
      });
      this.io.observe(this.root);
    }
    this.layout();
    this.renderUi();
    this.updateLoop();
  }

  // ───────────────────────────── 外から

  setInfo(info: Partial<MinigameInfo>): void {
    this.info = { ...this.info, ...info };
    if (this.phase === "title") this.renderUi();
  }

  /** 配信: 今日の上位が変わった。 */
  setTopToday(top: LeaderEntry[]): void {
    this.info = { ...this.info, top_today: top[0] ?? null };
    if (this.phase === "board" && this.board.period === "today" && this.board.data) {
      this.board.data = { ...this.board.data, entries: top.length >= this.board.data.entries.length ? top : [...top, ...this.board.data.entries.slice(top.length)] };
    }
    if (this.phase === "title" || this.phase === "board") this.renderUi();
  }

  setTheme(theme: "light" | "dark" | "auto"): void {
    this.root.dataset.theme = theme;
  }

  setMaxHeight(h: number): void {
    if (h > 0 && h !== this.maxHeight) {
      this.maxHeight = h;
      this.layout();
    }
  }

  /** アプリが画面を離れた・WebView を隠した。 */
  pause(): void {
    this.hostPaused = true;
    this.pauseRun();
    this.updateLoop();
  }

  resume(): void {
    this.hostPaused = false;
    this.updateLoop();
  }

  destroy(): void {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.removeEventListener("pointerup", this.onPointerUp);
    window.removeEventListener("pointercancel", this.onPointerUp);
    window.removeEventListener("pointerdown", this.onWindowPointerDown, true);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.ro?.disconnect();
    this.io?.disconnect();
    this.sfx.close();
    this.root.remove();
  }

  /** テスト・確認用: 今の画面と数字。 */
  debugState(): { phase: Phase; tick: number; distance: number; score: number; character: Character; h: number; stage: number; inputs: number[] } {
    const s = this.run?.sim;
    return {
      phase: this.phase,
      tick: s?.tick ?? 0,
      distance: s ? distanceM(s) : 0,
      score: s ? scoreOf(s) : 0,
      character: this.character,
      h: s ? s.h : 0,
      stage: s ? s.stage : 0,
      inputs: this.run ? this.run.rec.packed.slice() : [],
    };
  }

  // ───────────────────────────── 大きさ

  private layout(): void {
    const width = this.root.parentElement?.clientWidth || this.root.clientWidth || 320;
    this.fit = fitView(width, this.maxHeight, typeof devicePixelRatio === "number" ? devicePixelRatio : 1);
    this.renderer.resize(this.fit.w);
    this.stage.style.width = `${this.fit.cssW}px`;
    this.stage.style.height = `${this.fit.cssH}px`;
    const u = this.fit.cssH / 144;
    const fs = Math.max(10, Math.min(15, Math.round(u * 8)));
    this.stage.style.setProperty("--fs", `${fs}px`);
    this.stage.style.setProperty("--u", `${u}`);
    this.draw();
    this.host.resized?.(Math.ceil(this.fit.cssH));
  }

  // ───────────────────────────── 繰り返し

  private wantsLoop(): boolean {
    return !this.destroyed && !this.hidden && !this.hostPaused && !this.offscreen && this.phase !== "paused" && this.phase !== "board";
  }

  private updateLoop(): void {
    if (this.wantsLoop()) {
      if (!this.raf) {
        this.lastFrame = performance.now();
        this.acc = 0;
        this.raf = requestAnimationFrame(this.frame);
      }
    } else if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  private frame = (now: number): void => {
    this.raf = 0;
    if (!this.wantsLoop()) return;
    const dt = Math.min(250, Math.max(0, now - this.lastFrame));
    this.lastFrame = now;
    this.frameT++;
    if (this.phase === "playing") {
      this.acc += dt;
      let n = 0;
      while (this.acc >= STEP_MS && n < 8 && this.phase === "playing") {
        this.step();
        this.acc -= STEP_MS;
        n++;
      }
      if (n >= 8) this.acc = 0;
    }
    this.draw();
    if (this.phase === "dead" && this.frameT % 6 === 0) this.updateRetryButton();
    this.raf = requestAnimationFrame(this.frame);
  };

  private draw(): void {
    const r = this.run;
    if (r && (this.phase === "playing" || this.phase === "choosing" || this.phase === "paused" || this.phase === "dead")) {
      this.renderer.scene(r.sim, r.character, this.frameT);
    } else {
      this.renderer.idle(this.character, this.frameT);
    }
    this.renderHud();
  }

  /** 1 刻み（溜まった操作を当ててから進める）。 */
  private step(): void {
    const r = this.run;
    if (!r) return;
    const s = r.sim;
    // 同じ刻みの中で押して離した（ごく短いタップ）ときは、離すのを次の刻みに回す
    // （押した刻みで「押した」を記録し、最低 1 刻みは押したことにする。記録には両方が残り、再生でも同じ）。
    const q = this.queue;
    this.queue = [];
    let pressedNow = false;
    for (let i = 0; i < q.length; i++) {
      const code = q[i];
      if (code === 0 && pressedNow) {
        this.queue = q.slice(i);
        break;
      }
      r.rec.push(s.tick, code);
      simInput(s, code);
      if (code === 1) pressedNow = true;
    }
    simStep(s);
    const ev = s.ev;
    if (!ev) return;
    if (ev & E_JUMP) this.play("jump");
    if (ev & E_AIRJUMP) this.play("jump2");
    if (ev & E_SD) this.play("sd");
    if (ev & E_COFFEE) this.play("coffee");
    if (ev & E_LAMP) this.play("lamp");
    if (ev & E_MONEY) this.play("money");
    if (ev & E_SLOW) this.play("slow");
    if (ev & E_REVIVE) this.play("revive");
    if (ev & E_DIVE) this.play("dive");
    if (ev & E_STAGE) this.stageBanner = { stage: s.stage, until: s.tick + 150 };
    if (ev & (E_HIT | E_BILLHIT | E_FALL) && !(ev & E_DEAD)) {
      this.play("hit");
      this.host.haptic?.("hit");
    }
    if (ev & E_DEAD) {
      this.play("dead");
      this.host.haptic?.("dead");
      this.onDead();
    } else if (ev & E_CHOOSE) {
      this.play("choose");
      this.host.haptic?.("select");
      this.pressed = false;
      this.phase = "choosing";
      this.renderUi();
    }
  }

  private play(n: SfxName): void {
    this.sfx.play(n);
  }

  // ───────────────────────────── 遊ぶ

  private async startRun(mode: MinigameMode): Promise<void> {
    if (this.phase === "loading") return;
    this.sfx.unlock();
    this.focused = true;
    const character = this.character;
    let ticket: PlayTicket | null = null;
    let ticketP: Promise<PlayTicket | null> | null = null;
    let seed: number | null = null;
    let unrecorded: string | null = null;
    if (this.info.engine_version && this.info.engine_version !== ENGINE_VERSION) {
      unrecorded = "ゲームが更新されました。読み込み直すと記録できます";
    }
    const pf = this.prefetch;
    this.prefetch = null;
    if (!unrecorded && pf && pf.ticket.mode === mode && pf.ticket.character === character && Date.now() - pf.at < 25 * 60_000) {
      ticket = pf.ticket;
      seed = ticket.seed;
    } else if (!unrecorded && mode === "daily" && this.info.daily) {
      // 今日の種は分かっている: すぐ走り出し、発行は助走の間に受け取る。
      seed = this.info.daily.seed;
      ticketP = this.host.requestPlay(mode, character).catch((e: unknown) => {
        if (this.run && this.run.ticketP === ticketP) this.run.unrecorded = errText(e);
        return null;
      });
    } else if (!unrecorded) {
      this.phase = "loading";
      this.renderUi();
      try {
        ticket = await withTimeout(this.host.requestPlay(mode, character), 8000);
        seed = ticket.seed;
      } catch (e) {
        unrecorded = errText(e);
      }
      if (this.destroyed) return;
    }
    if (seed === null) seed = (Math.random() * 0x7fffffff) | 0;
    this.run = { mode, character, seed, sim: newSim(seed, character), rec: new InputRecorder(), ticket, ticketP, unrecorded };
    this.lastResult = null;
    this.finishError = null;
    this.stageBanner = null;
    this.queue = [];
    this.pressed = false;
    this.phase = "playing";
    this.acc = 0;
    this.renderUi();
    if (unrecorded) this.note(unrecorded);
    if (ticketP) {
      const run = this.run;
      void ticketP.then((t) => {
        if (!t || this.run !== run) return;
        if (t.seed !== run.seed) {
          run.unrecorded = "今日のチャレンジが替わりました（この回は記録されません）";
          this.host.refresh?.();
          return;
        }
        run.ticket = t;
      });
    }
    this.updateLoop();
  }

  private onDead(): void {
    const r = this.run;
    if (!r) return;
    this.phase = "dead";
    this.deadAt = performance.now();
    this.pressed = false;
    this.renderUi();
    void this.finishRun(r);
    // 自由プレイの「もう一回」をすぐ始められるよう、次の 1 回を先にもらっておく。
    if (r.mode === "free" && !r.unrecorded) {
      const ch = r.character;
      this.host
        .requestPlay("free", ch)
        .then((t) => {
          if (!this.destroyed) this.prefetch = { ticket: t, at: Date.now() };
        })
        .catch(() => {});
    }
  }

  private async finishRun(r: Run): Promise<void> {
    const s = r.sim;
    const prev = this.lastDistance[r.mode];
    this.lastDistance[r.mode] = distanceM(s);
    (r as Run & { prevDistance?: number }).prevDistance = prev;
    if (!r.ticket && r.ticketP) {
      this.finishing = true;
      this.renderUi();
      await Promise.race([r.ticketP, new Promise((res) => setTimeout(res, 6000))]);
    }
    if (!r.ticket || r.unrecorded) {
      this.finishing = false;
      if (!r.unrecorded) r.unrecorded = "記録できませんでした（通信）";
      if (this.run === r) this.renderUi();
      return;
    }
    this.finishing = true;
    this.renderUi();
    try {
      const res = await this.host.finish({
        play_id: r.ticket.play_id,
        inputs: r.rec.packed,
        engine_version: ENGINE_VERSION,
        mode: r.mode,
        character: r.character,
        score: scoreOf(s),
        ticks: s.tick,
        distance: distanceM(s),
        sd: s.sd,
      });
      if (this.run !== r) return;
      this.lastResult = res;
      if (res.new_best) {
        this.play("highscore");
        this.host.haptic?.("highscore");
      }
      // タイトルの「自己ベスト」「今日の 1 位」も更新
      this.host.refresh?.();
    } catch (e) {
      if (this.run === r) this.finishError = errText(e);
    } finally {
      this.finishing = false;
      if (this.run === r) this.renderUi();
    }
  }

  private retry(): void {
    if (!this.run || performance.now() - this.deadAt < RETRY_DELAY_MS) return;
    void this.startRun(this.run.mode);
  }

  private choose(i: number): void {
    const r = this.run;
    if (!r || this.phase !== "choosing") return;
    const s = r.sim;
    if (i >= s.options.length) return;
    r.rec.push(s.tick, 2 + i);
    simInput(s, 2 + i);
    this.play("powerup");
    this.host.haptic?.("powerup");
    this.phase = "playing";
    this.acc = 0;
    this.renderUi();
  }

  private pauseRun(): void {
    if (this.phase === "playing") {
      if (this.pressed) this.release();
      this.phase = "paused";
      this.renderUi();
    }
  }

  private press(): void {
    if (this.pressed) return;
    this.pressed = true;
    this.queue.push(1);
  }

  private release(): void {
    if (!this.pressed) return;
    this.pressed = false;
    this.queue.push(0);
  }

  private async openBoard(period: MinigamePeriod): Promise<void> {
    if (this.phase !== "board") this.before = this.phase === "dead" ? "dead" : "title";
    this.phase = "board";
    this.board = { period, data: this.board.period === period ? this.board.data : null, loading: true, error: null };
    this.renderUi();
    this.updateLoop();
    try {
      const d = await this.host.leaderboard(period);
      if (this.board.period === period) this.board.data = d;
    } catch (e) {
      if (this.board.period === period) this.board.error = errText(e);
    } finally {
      if (this.board.period === period) this.board.loading = false;
      if (this.phase === "board") this.renderUi();
    }
  }

  private closeBoard(): void {
    this.phase = this.before === "dead" && this.run ? "dead" : "title";
    this.renderUi();
    this.updateLoop();
  }

  // ───────────────────────────── 入力

  private onWindowPointerDown = (e: PointerEvent): void => {
    this.focused = this.root.contains(e.target as Node);
  };

  private onPointerDown = (e: PointerEvent): void => {
    this.focused = true;
    this.sfx.unlock();
    const t = e.target as HTMLElement;
    if (t.closest("button,[data-act]")) return;
    if (e.button !== undefined && e.button > 0) return;
    if (this.phase === "playing") {
      e.preventDefault();
      this.press();
    } else if (this.phase === "paused") {
      this.phase = "playing";
      this.acc = 0;
      this.renderUi();
      this.updateLoop();
    } else if (this.phase === "dead") {
      this.retry();
    }
  };

  private onPointerUp = (): void => {
    if (this.phase === "playing") this.release();
    else this.pressed = false;
  };

  private onClick = (e: MouseEvent): void => {
    const b = (e.target as HTMLElement).closest("[data-act]") as HTMLElement | null;
    if (!b || (b as HTMLButtonElement).disabled) return;
    this.sfx.unlock();
    const act = b.dataset.act ?? "";
    const arg = b.dataset.arg ?? "";
    switch (act) {
      case "char":
        if ((CHARACTERS as string[]).includes(arg)) {
          this.character = arg as Character;
          try {
            localStorage.setItem(CHAR_KEY, arg);
          } catch {
            /* no storage */
          }
          this.play("select");
          this.renderUi();
        }
        break;
      case "start":
        void this.startRun(arg === "free" ? "free" : "daily");
        break;
      case "retry":
        this.retry();
        break;
      case "title":
        this.phase = "title";
        this.run = null;
        this.renderUi();
        this.updateLoop();
        break;
      case "board":
        void this.openBoard((arg as MinigamePeriod) || (this.run?.mode === "free" ? "week" : "today"));
        break;
      case "close-board":
        this.closeBoard();
        break;
      case "choose":
        this.choose(Number(arg) || 0);
        break;
      case "pause":
        this.pauseRun();
        this.updateLoop();
        break;
      case "resume":
        if (this.phase === "paused") {
          this.phase = "playing";
          this.acc = 0;
          this.renderUi();
          this.updateLoop();
        }
        break;
      case "mute":
        this.sfx.setMuted(!this.sfx.muted);
        if (!this.sfx.muted) this.sfx.unlock();
        this.renderUi();
        break;
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (!this.focused || isEditable(e.target) || e.metaKey || e.ctrlKey || e.altKey || this.destroyed) return;
    const k = e.key;
    const jump = k === " " || k === "Spacebar" || k === "ArrowUp" || k === "w" || k === "W";
    if (this.phase === "playing") {
      if (jump) {
        e.preventDefault();
        if (!e.repeat) {
          this.sfx.unlock();
          this.press();
        }
      } else if (k === "Escape" || k === "p") {
        this.pauseRun();
        this.updateLoop();
      }
    } else if (this.phase === "choosing") {
      if (k === "1" || k === "ArrowLeft") this.choose(0);
      else if (k === "2" || k === "ArrowRight") this.choose(1);
    } else if (this.phase === "paused" && (jump || k === "Enter")) {
      e.preventDefault();
      this.phase = "playing";
      this.acc = 0;
      this.renderUi();
      this.updateLoop();
    } else if (this.phase === "dead" && (jump || k === "Enter") && !e.repeat) {
      e.preventDefault();
      this.retry();
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    const k = e.key;
    if (k === " " || k === "Spacebar" || k === "ArrowUp" || k === "w" || k === "W") {
      if (this.phase === "playing") this.release();
      else this.pressed = false;
    }
  };

  private onVisibility = (): void => {
    this.hidden = document.visibilityState === "hidden";
    if (this.hidden) this.pauseRun();
    this.updateLoop();
  };

  // ───────────────────────────── 文字（DOM）

  private note(text: string): void {
    let n = this.stage.querySelector(".mg-note") as HTMLDivElement | null;
    if (!n) {
      n = document.createElement("div");
      n.className = "mg-note";
      this.stage.appendChild(n);
    }
    n.innerHTML = `<span>${esc(text)}</span>`;
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.noteTimer = setTimeout(() => n?.remove(), 4000);
  }

  private renderHud(): void {
    const r = this.run;
    let html = "";
    if (r && (this.phase === "playing" || this.phase === "choosing" || this.phase === "paused")) {
      const s = r.sim;
      const hearts = "♥".repeat(Math.min(5, Math.max(0, s.hearts))) + "♡".repeat(Math.max(0, START_HEARTS - s.hearts));
      const fx = [s.coffee > 0 ? "☕" : "", s.lamp > 0 ? "🔴" : "", s.money > 0 ? "💸" : "", s.pw[P_REVIVE] > 0 ? "✚" : ""].join("");
      const label = r.mode === "daily" ? "今日" : "自由";
      html =
        `<div class="mg-l"><span style="color:#dc4a3f">${hearts}</span><b>${num(distanceM(s))}m</b>` +
        `<span>💾<b>${s.sd}</b></span>${s.combo > 1 ? `<b style="color:#f2b24c">x${s.combo}${s.money > 0 ? "×2" : ""}</b>` : ""}</div>` +
        `<div class="mg-r"><span>${fx}</span><span class="mg-dim">${label}・${esc(STAGE_INFO[s.stage]?.name ?? "")}</span>` +
        (this.phase === "playing" ? `<button data-act="pause" aria-label="一時停止">⏸</button>` : "") +
        `</div>`;
      // 走り出し（操作の説明）と区間の切り替え（名前と新しい要素）の帯
      let banner: { name: string; hint: string } | null = null;
      if (s.tick < 240 && s.stage === 0) banner = { name: "", hint: STAGE_INFO[0].hint };
      else if (this.stageBanner && s.tick < this.stageBanner.until) {
        const i = STAGE_INFO[this.stageBanner.stage];
        banner = i ? { name: `区間 ${this.stageBanner.stage + 1}: ${i.name}`, hint: i.hint } : null;
      }
      if (banner && this.phase === "playing") {
        html += `<div class="mg-banner">${banner.name ? `<b>${esc(banner.name)}</b> ` : ""}<span>${esc(banner.hint)}</span></div>`;
      }
    }
    if (html !== this.hudText) {
      this.hudText = html;
      this.hud.innerHTML = html;
    }
  }

  private updateRetryButton(): void {
    const b = this.ui.querySelector('[data-act="retry"]') as HTMLButtonElement | null;
    if (b && b.disabled && performance.now() - this.deadAt >= RETRY_DELAY_MS) b.disabled = false;
  }

  private renderUi(): void {
    const u = this.fit.cssH / 144;
    const px = (n: number) => `${Math.round(n * u)}px`;
    let html = "";
    switch (this.phase) {
      case "title": {
        const best = this.info.best;
        const top = this.info.top_today;
        const chars = CHARACTERS.map((c) => {
          const on = c === this.character;
          const size = Math.min(56, Math.round(28 * u));
          return `<button class="mg-char" data-act="char" data-arg="${c}" aria-pressed="${on}" aria-label="${CHARACTER_INFO[c].name}">` +
            `<img src="${spriteDataUrl(`${c}_big`)}" width="${size}" height="${size}" alt="">` +
            `<span>${CHARACTER_INFO[c].name}</span></button>`;
        }).join("");
        const bestLine = [
          best?.today ? `今日のベスト <b>${num(best.today.score)}</b>${best.today.rank ? `（${best.today.rank} 位）` : ""}` : "",
          top ? `🏆 今日の 1 位 ${esc(top.name)} <b>${num(top.score)}</b>` : "今日の 1 位はまだいません",
        ]
          .filter(Boolean)
          .join(" ・ ");
        html =
          `<div class="mg-panel">` +
          `<div class="mg-row"><span class="mg-title">散財ダッシュ</span><span class="mg-dim">${bestLine}</span></div>` +
          `<div class="mg-chars">${chars}</div>` +
          `<div class="mg-dim">${esc(CHARACTER_INFO[this.character].trait)}</div>` +
          `<div class="mg-row">` +
          `<button class="mg-primary" data-act="start" data-arg="daily">▶ 今日のチャレンジ</button>` +
          `<button data-act="start" data-arg="free">自由プレイ</button>` +
          `<button class="mg-ghost" data-act="board" data-arg="today" aria-label="ランキング">🏆</button>` +
          `<button class="mg-ghost" data-act="mute" aria-label="${this.sfx.muted ? "音を出す" : "消音"}">${this.sfx.muted ? "🔇" : "🔈"}</button>` +
          `</div></div>`;
        break;
      }
      case "loading":
        html = `<div class="mg-panel"><div>準備中…</div></div>`;
        break;
      case "paused":
        html = `<div class="mg-panel"><div class="mg-big">⏸</div><button class="mg-primary" data-act="resume">続ける</button><button class="mg-ghost" data-act="title">やめる</button></div>`;
        break;
      case "choosing": {
        const s = this.run?.sim;
        const cards = (s?.options ?? [])
          .map((p, i) => {
            const info = POWERUP_INFO[p];
            return `<button class="mg-card" data-act="choose" data-arg="${i}"><img class="mg-ico" src="${spriteDataUrl(info.icon[0], info.icon[1])}" width="${px(16)}" height="${px(16)}" alt=""><b>${esc(info.name)}</b><span class="mg-dim">${esc(info.desc)}</span></button>`;
          })
          .join("");
        html =
          `<div class="mg-panel">` +
          `<div class="mg-row"><img class="mg-ico" src="${spriteDataUrl("beagle", "sit")}" width="${px(16)}" height="${px(16)}" alt=""><span class="mg-bubble">${num(s ? distanceM(s) : 0)}m！ どっちにする？わん</span></div>` +
          (s && STAGE_INFO[s.stage] ? `<div class="mg-dim">ここから 区間 ${s.stage + 1}「${esc(STAGE_INFO[s.stage].name)}」: ${esc(STAGE_INFO[s.stage].hint)}</div>` : "") +
          `<div class="mg-cards">${cards}</div></div>`;
        break;
      }
      case "dead": {
        const r = this.run;
        if (!r) break;
        const s = r.sim;
        const res = this.lastResult;
        const prev = (r as Run & { prevDistance?: number }).prevDistance;
        const d = distanceM(s);
        const diff = typeof prev === "number" ? d - prev : null;
        const causeImg = spriteDataUrl(({ boom: "boommic", pit: "floor", deadline: "deadline" } as Record<string, string>)[s.cause] ?? (s.cause || "deadline"));
        const lines: string[] = [];
        if (res) {
          lines.push(
            `${res.new_best ? `<span class="mg-new">自己ベスト更新！</span> ` : `${r.mode === "daily" ? "今日の" : "今週の"}ベスト <b>${num(res.best)}</b> ・ `}` +
              (res.rank ? `${r.mode === "daily" ? "今日" : "今週"} <b>${res.rank}</b> 位` : "")
          );
        } else if (this.finishing) lines.push(`<span class="mg-dim">記録中…</span>`);
        else if (this.finishError) lines.push(`<span class="mg-dim">${esc(this.finishError)}</span>`);
        else if (r.unrecorded) lines.push(`<span class="mg-dim">${esc(r.unrecorded)}</span>`);
        if (diff !== null) lines.push(`<span class="mg-dim">前回より ${diff >= 0 ? "+" : ""}${num(diff)}m</span>`);
        let bubble = "";
        if (res?.rest_hint && !this.restShown) {
          this.restShown = true;
          bubble = `<div class="mg-row"><img class="mg-ico" src="${spriteDataUrl("beagle", "sit")}" width="${px(16)}" height="${px(16)}" alt=""><span class="mg-bubble">ちょっと休憩するわん</span></div>`;
        }
        const ready = performance.now() - this.deadAt >= RETRY_DELAY_MS;
        html =
          `<div class="mg-panel">` +
          `<div class="mg-row"><img class="mg-ico" src="${causeImg}" height="${px(16)}" alt="" title="${esc(CAUSE_LABEL[s.cause] ?? "")}">` +
          `<span class="mg-big">${num(d)}m</span><span>スコア <b>${num(scoreOf(s))}</b></span></div>` +
          `<div class="mg-dim">${esc(CAUSE_LABEL[s.cause] ?? "")}</div>` +
          lines.map((l) => `<div>${l}</div>`).join("") +
          bubble +
          `<div class="mg-row"><button class="mg-primary" data-act="retry" ${ready ? "" : "disabled"}>もう一回</button>` +
          `<button data-act="title">タイトル</button>` +
          `<button class="mg-ghost" data-act="board" data-arg="${r.mode === "free" ? "week" : "today"}" aria-label="ランキング">🏆</button></div>` +
          `</div>`;
        break;
      }
      case "board": {
        const b = this.board;
        const tabs = (["today", "week", "all"] as MinigamePeriod[])
          .map((p) => `<button data-act="board" data-arg="${p}" aria-pressed="${b.period === p}">${PERIOD_LABEL[p]}</button>`)
          .join("");
        let list = "";
        if (b.data) {
          const myId = this.info.me?.user_id;
          list = b.data.entries.length
            ? b.data.entries
                .map(
                  (e) =>
                    `<div class="${e.user_id === myId ? "me" : ""}"><span class="r">${e.rank}</span><span class="n">${esc(e.name)}</span><span class="s">${num(e.score)}</span><span class="mg-dim">${num(e.distance)}m</span></div>`
                )
                .join("")
            : `<div class="mg-dim">まだ記録がありません</div>`;
          if (b.data.me && !b.data.entries.some((e) => e.user_id === myId)) {
            list += `<div class="me"><span class="r">${b.data.me.rank}</span><span class="n">あなた</span><span class="s">${num(b.data.me.score)}</span><span class="mg-dim">${num(b.data.me.distance)}m</span></div>`;
          }
        } else if (b.error) list = `<div class="mg-dim">${esc(b.error)}</div>`;
        else list = `<div class="mg-dim">読み込み中…</div>`;
        const sub = b.period === "today" ? "今日のチャレンジ" : b.period === "week" ? "自由プレイ（月曜から）" : "通算";
        html =
          `<div class="mg-panel" style="justify-content:flex-start">` +
          `<div class="mg-row mg-tabs">${tabs}<span class="mg-dim">${sub}</span><button class="mg-ghost" data-act="close-board" aria-label="閉じる">✕</button></div>` +
          `<div class="mg-list">${list}</div></div>`;
        break;
      }
      case "playing":
        html = "";
        break;
    }
    this.ui.innerHTML = html;
    this.hudText = null;
    this.renderHud();
  }
}

function errText(e: unknown): string {
  if (e instanceof HostError) return e.message;
  if (e instanceof Error && e.message) return e.message.length < 80 ? e.message : "記録できませんでした";
  return "記録できませんでした";
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new HostError("通信に時間がかかっています（この回は記録されません）", "timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}
