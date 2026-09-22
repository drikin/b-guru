/**
 * 既存投稿の URL プレビューを再取得するバックフィルスクリプト。
 *
 * 背景: `url_preview` は投稿時に JSON で保存される。後から埋め込み対応
 * （Spotify 等）を追加しても、**既存投稿にはそのフィールドが無い**ため
 * 埋め込みが表示されない。このスクリプトで再取得して埋める。
 *
 * 使い方（VPS 上で）:
 *   node scripts/backfill-url-preview.mjs --dry-run        # 対象を確認
 *   node scripts/backfill-url-preview.mjs --only-spotify   # Spotify のみ実行
 *   node scripts/backfill-url-preview.mjs                  # プレビュー未取得を全部
 *
 * ⚠️ 冪等: 既に spotify フィールドを持つ投稿はスキップする。
 * ⚠️ レート制限: 外部サイトを叩くので 1件ずつ間隔を空ける。
 *
 * 依存を増やさないため素の .mjs（Node 20 でも動く）。プレビュー取得ロジックは
 * src/lib/urlpreview.ts と二重管理になるのを避けるため、**同じ規則をここに
 * 最小限だけ再実装**している（Spotify の oEmbed 呼び出しのみ）。
 */
import { Pool } from "pg";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY_SPOTIFY = args.includes("--only-spotify");

/** 投稿本文から最初の URL を取り出す（posts.ts の firstUrl と同じ規則）。 */
function firstUrl(text) {
  const m = (text || "").match(/https?:\/\/[^\s<>"']+/);
  return m ? m[0] : null;
}

/** Spotify の URL から {kind, id} を取り出す（urlpreview.ts と同じ規則）。 */
function extractSpotify(rawUrl) {
  try {
    const u = new URL(rawUrl.trim());
    if (!/(^|\.)spotify\.com$/.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    const i = parts.findIndex((p) => p === "intl-ja" || /^intl-/.test(p));
    const rest = i >= 0 ? parts.slice(i + 1) : parts;
    const kind = rest[0];
    const id = rest[1];
    if (!kind || !id) return null;
    if (!["album", "track", "playlist", "artist", "episode", "show"].includes(kind)) return null;
    if (!/^[A-Za-z0-9]+$/.test(id)) return null;
    return { kind, id };
  } catch {
    return null;
  }
}

/** Spotify oEmbed から埋め込み情報を得る。 */
async function fetchSpotifyEmbed(kind, id) {
  const canonical = `https://open.spotify.com/${kind}/${id}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const r = await fetch(
      `https://open.spotify.com/oembed?url=${encodeURIComponent(canonical)}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.iframe_url) return null;
    return {
      embedUrl: d.iframe_url.replace(/[?&]utm_source=oembed/, ""),
      height: d.height || 352,
      kind,
    };
  } catch {
    return null;
  }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const where = ONLY_SPOTIFY
    ? `text ~* 'open\\.spotify\\.com/(album|track|playlist|artist|episode|show)/'
       AND NOT (COALESCE(url_preview, '{}')::jsonb ? 'spotify')`
    : `text ~* 'https?://'
       AND (url_preview IS NULL OR url_preview = 'null')`;

  const { rows } = await pool.query(
    `SELECT id, text, url_preview FROM posts WHERE ${where} ORDER BY id`
  );

  console.log(`対象: ${rows.length} 件${DRY_RUN ? " (dry-run)" : ""}`);
  if (!rows.length) {
    await pool.end();
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    const url = firstUrl(row.text);
    if (!url) {
      console.log(`  #${row.id}: URL なし → スキップ`);
      continue;
    }
    const sp = extractSpotify(url);
    if (!sp) {
      console.log(`  #${row.id}: Spotify 以外 → スキップ（${url.slice(0, 50)}）`);
      continue;
    }
    const embed = await fetchSpotifyEmbed(sp.kind, sp.id);
    if (!embed) {
      console.error(`  #${row.id}: oEmbed 失敗`);
      failed++;
      continue;
    }
    // 埋め込みが本体なので、余計なメタ情報は持たせない（urlpreview.ts と同じ方針）
    const pv = { url, spotify: embed };
    console.log(`  #${row.id}: ${sp.kind}/${sp.id} → 埋め込み取得 ✓`);
    if (!DRY_RUN) {
      await pool.query(`UPDATE posts SET url_preview = $1 WHERE id = $2`, [
        JSON.stringify(pv),
        row.id,
      ]);
    }
    ok++;
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`完了: 成功 ${ok} / 失敗 ${failed}${DRY_RUN ? " (dry-run のため未保存)" : ""}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
