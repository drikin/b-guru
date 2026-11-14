/**
 * 📝 ネタ帳の管理（lib/neta-admin.ts・lib/neta-script.ts）: 台本の差し替え、週・採用・削除、タイトル案の読み取り。
 * DB を使う部分は DM_TEST_DATABASE_URL があるときだけ（使い捨ての DB を指すこと）。
 *   DM_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/postgres npx vitest run neta-admin --exclude '.claude/**'
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

const URL_ = process.env.DM_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

let aiReply = "";
const sentMails: { to: string; subject: string; text: string }[] = [];
vi.mock("../mailgun", () => ({
  sendEmail: async (m: { to: string; subject: string; text: string }) => {
    sentMails.push(m);
    return { message: "ok" };
  },
}));
const aiPrompts: string[] = [];
vi.mock("../sakura", () => ({
  sakuraChat: async (o: { messages: { content: string }[] }) => {
    aiPrompts.push(o.messages.map((m) => m.content).join("\n"));
    return { content: aiReply, model: "test" };
  },
}));
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (k: string) => (jar.has(k) ? { value: jar.get(k)! } : undefined),
    set: (k: string, v: string) => void jar.set(k, v),
    delete: (k: string) => void jar.delete(k),
  }),
}));

describe("📝 台本の小物", async () => {
  const sc = await import("../neta-script");

  it("回の番号は ep か 第N回 から", () => {
    expect(sc.extractEpisodeNumber("ep680")).toBe(680);
    expect(sc.extractEpisodeNumber("第 12 回")).toBe(12);
    expect(sc.extractEpisodeNumber("特別回")).toBeUndefined();
  });

  it("ひな形から: 第XXX回 が回の番号に、採用ネタが一覧に入る", () => {
    const s = sc.buildScript(null, "ep681", [{ title: "A", url: "https://a.example/$1", submitter: "ねこ" }]);
    expect(s).toContain("# backspace.fm 第681回 台本");
    expect(s).not.toContain("第XXX回");
    expect(s).toContain("### 採用ネタ一覧\n- [A](https://a.example/$1) by ねこ");
  });

  it("前の週の台本から: 番号を替え、採用ネタの欄を次の --- まで差し替える", () => {
    const prev = "# backspace.fm 第680回 台本\nep680 です\n### 採用ネタ一覧\n- [古い](https://o) by x\n- [古い2](https://o2) by y\n---\nおわり";
    const s = sc.buildScript(prev, "ep681", []);
    expect(s).toBe("# backspace.fm 第681回 台本\n第681回 です\n### 採用ネタ一覧\n（まだ採用されたネタはありません）\n---\nおわり");
  });
});

describe("📝 タイトル案の読み取り", async () => {
  const a = await import("../neta-admin");
  it("前後に文があっても JSON の配列を読む、壊れていれば空", () => {
    expect(a.parseTitles('はい\n```json\n[{"title":" 案1 ","reasoning":"理由"},{"title":""},{"x":1}]\n```')).toEqual([{ title: "案1", reasoning: "理由" }]);
    expect(a.parseTitles("ごめんなさい")).toEqual([]);
    expect(a.parseTitles("[{oops}]")).toEqual([]);
  });

  it("週の入力: 日付の形・前後・URL を確かめる", () => {
    expect(a.parseWeek({ title: " ep1 ", startDate: "2026-11-15", endDate: "2026-11-22", liveUrl: "", liveRecordingDate: "2026-11-20T13:00" })).toEqual({
      title: "ep1",
      start_date: "2026-11-15",
      end_date: "2026-11-22",
      live_recording_date: "2026-11-20T13:00",
      live_url: null,
    });
    expect(() => a.parseWeek({ title: "x", startDate: "2026-11-22", endDate: "2026-11-15" })).toThrow(/前/);
    expect(() => a.parseWeek({ title: "x", startDate: "11/15", endDate: "2026-11-22" })).toThrow();
    expect(() => a.parseWeek({ title: "x", startDate: "2026-11-15", endDate: "2026-11-22", liveUrl: "javascript:alert(1)" })).toThrow();
    expect(a.parseWeek({ liveUrl: "https://youtube.com/live/x" }, true)).toEqual({ live_url: "https://youtube.com/live/x" });
  });
});

d("📝 ネタ帳の管理（DB）", () => {
  let db: typeof import("../db");
  let a: typeof import("../neta-admin");
  const base = 700000 + (Date.now() % 50000);

  beforeAll(async () => {
    db = await import("../db");
    await db.pool.query(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await db.initSchema();
    a = await import("../neta-admin");
    await db.pool.query(`UPDATE neta_weeks SET is_active = false WHERE is_active`);
    await db.pool.query(`INSERT INTO neta_weeks (id, title, start_date, end_date, is_active) VALUES ($1, 'ep9000', '2026-11-08', '2026-11-15', true)`, [base]);
    await db.pool.query(`INSERT INTO neta_scripts (week_id, content) VALUES ($1, $2)`, [
      base,
      "# backspace.fm 第9000回 台本\n### 採用ネタ一覧\n（まだ採用されたネタはありません）\n---\n",
    ]);
    await db.pool.query(
      `INSERT INTO neta_topics (id, week_id, title, url, submitter, legacy_stars) VALUES
       ($1, $3, 'ネタA', 'https://a.example', 'ねこ', 3), ($2, $3, 'ネタB', 'https://b.example', 'みけ', 9)`,
      [base, base + 1, base]
    );
    await db.pool.query(`INSERT INTO neta_comments (id, topic_id, commenter, body) VALUES ($1, $2, 'たま', 'x')`, [base, base]);
  });

  it("管理者は B-guru の有料会員のログイン + 管理者の一覧", async () => {
    jar.clear();
    expect(await a.netaAdminEmail()).toBeNull();
    await db.pool.query(`INSERT INTO sessions (token, email, expires_at) VALUES ($1, 'drikin@gmail.com', now() + interval '1 hour'), ($2, 'someone@test.local', now() + interval '1 hour')`, [
      `adm-${base}`,
      `usr-${base}`,
    ]);
    jar.set("bsm_session", `usr-${base}`);
    expect(await a.netaAdminEmail()).toBeNull();
    jar.set("bsm_session", `adm-${base}`);
    expect(await a.netaAdminEmail()).toBe("drikin@gmail.com");
    // ネタ帳だけのログインでは管理者にならない
    jar.delete("bsm_session");
    jar.set("neta_session", "x".repeat(64));
    expect(await a.netaAdminEmail()).toBeNull();
  });

  it("採用すると featured_at が入り、台本を作り直すと採用ネタが入る。戻すと消える", async () => {
    await a.setTopicFeatured(base + 1, true);
    const row = (await db.pool.query(`SELECT status, featured_at FROM neta_topics WHERE id = $1`, [base + 1])).rows[0];
    expect(row.status).toBe("featured");
    expect(row.featured_at).not.toBeNull();
    expect(await a.regenerateScript(base)).toContain("### 採用ネタ一覧\n- [ネタB](https://b.example) by みけ\n---");
    await a.setTopicFeatured(base + 1, false);
    expect((await db.pool.query(`SELECT featured_at FROM neta_topics WHERE id = $1`, [base + 1])).rows[0].featured_at).toBeNull();
    await expect(a.setTopicFeatured(2_000_000_000, true)).rejects.toMatchObject({ status: 404 });
  });

  it("新しい週は前の台本から台本ができ、今週の切り替えは 1 つだけ、ネタのある週と今週は消せない", async () => {
    // 使い捨ての DB に前の回の台本が残っていると「いちばん新しい台本」がそれになるので、この週のもの以外は片付ける。
    await db.pool.query(`DELETE FROM neta_scripts WHERE week_id <> $1`, [base]);
    await db.pool.query(`UPDATE neta_scripts SET content = $2 WHERE week_id = $1`, [base, "# backspace.fm 第9000回 台本\n### 採用ネタ一覧\n（まだ採用されたネタはありません）\n---\n"]);
    const { id } = await a.createWeek({ title: "ep9001", startDate: "2026-11-15", endDate: "2026-11-22" }, "drikin");
    expect((await a.getScript(id))?.content).toContain("# backspace.fm 第9001回 台本");
    await a.setActiveWeek(id);
    const act = (await db.pool.query(`SELECT id FROM neta_weeks WHERE is_active`)).rows.map((r) => Number(r.id));
    expect(act).toEqual([id]);
    await expect(a.deleteWeek(id)).rejects.toMatchObject({ status: 400 });
    await expect(a.deleteWeek(base)).rejects.toThrow(/ネタが 2 件/);
    await a.updateWeek(id, { liveUrl: "https://youtube.com/live/abc" });
    await expect(a.updateWeek(id, { endDate: "2026-11-01" })).rejects.toThrow(/前/);
    await a.setActiveWeek(base);
    await a.deleteWeek(id);
    expect(await a.getScript(id)).toBeNull();
  });

  it("台本の保存、空は断る", async () => {
    await a.saveScript(base, "新しい台本", "drikin");
    expect((await a.getScript(base))?.content).toBe("新しい台本");
    await expect(a.saveScript(base, "  ", "x")).rejects.toMatchObject({ status: 400 });
    await expect(a.saveScript(2_000_000_000, "x", "x")).rejects.toMatchObject({ status: 404 });
  });

  it("タイトル案: 採用と聞きたいの数を渡し、ep を付ける", async () => {
    await a.setTopicFeatured(base, true);
    aiReply = '[{"title":"ネタAの話 ep12","reasoning":"採用"}]';
    const t = await a.suggestTitles(base);
    expect(t).toEqual([{ title: "ネタAの話 ep9000", reasoning: "採用" }]);
    expect(aiPrompts.at(-1)).toContain("1. [★採用済み] ネタA");
    expect(aiPrompts.at(-1)).toContain("[☆9] ネタB");
  });

  it("コメントとネタの削除（ネタを消すと聞きたいとコメントも消える）、書き出しにメールアドレスは入らない", async () => {
    const ex = JSON.stringify(await a.exportAll());
    expect(ex).not.toMatch(/@test\.local|drikin@gmail\.com/);
    await a.deleteComment(base);
    await expect(a.deleteComment(base)).rejects.toMatchObject({ status: 404 });
    await db.pool.query(`INSERT INTO neta_votes (topic_id, voter) VALUES ($1, 'm:1')`, [base]);
    await a.deleteTopic(base);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM neta_votes WHERE topic_id = $1`, [base])).rows[0].n).toBe(0);
  });

  it("初めて採用したら、ネタ帳にログインして投稿した人にだけメール（1 回だけ）", async () => {
    const mem = (await db.pool.query(`INSERT INTO neta_members (email) VALUES ($1) RETURNING id`, [`feat-${base}@test.local`])).rows[0].id;
    const t = (await db.pool.query(
      `INSERT INTO neta_topics (week_id, title, url, submitter, member_id) VALUES ($1, '採用されるネタ', 'https://f.example', 'ぽち', $2) RETURNING id`,
      [base, mem]
    )).rows[0].id;
    sentMails.length = 0;
    expect(await a.setTopicFeatured(t, true)).toEqual({ notified: true });
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0].to).toBe(`feat-${base}@test.local`);
    expect(sentMails[0].subject).toContain("ep9000");
    expect(sentMails[0].text).toContain(`/neta/t/${t}`);
    expect(await a.setTopicFeatured(t, true)).toEqual({ notified: false });
    await a.setTopicFeatured(t, false);
    expect(await a.setTopicFeatured(t, true)).toEqual({ notified: false });
    expect(sentMails).toHaveLength(1);
    // 拡張からのネタ（人に紐付かない）は送らない
    expect(await a.setTopicFeatured(base + 1, true)).toEqual({ notified: false });
  });
});
