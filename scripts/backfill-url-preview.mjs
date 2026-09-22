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
 * 依存を増やさないため素の .mjs（Node 20 でも動く）。
 *
 * ⚠️ 二重実装の注意:
 *   以前は URL 抽出と Spotify 判定をこのファイルにコピーしていたが、
 *   正規表現が posts.ts / urlpreview.ts と食い違って
 *   「括弧付きリンクを取りこぼす」「/intl-ja/ を見落とす」バグになった
 *   （PEレビュー検出）。現在は **候補の絞り込みを SQL の緩い条件だけ**に
 *   とどめ、判定は下の extractSpotify() に一本化している。
 *   firstUrl / extractSpotify / fetchSpotifyEmbed を変更するときは、
 *   必ず src/lib/posts.ts と src/lib/urlpreview.ts の対応する関数と
 *   規則を揃えること。
 */
import { Pool } from "pg";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ONLY_SPOTIFY = args.includes("--only-spotify");

/**
 * 投稿本文から最初の URL を取り出す。
 * ⚠️ src/lib/posts.ts の firstUrl() と同一の規則にすること。
 * 末尾の `)` を除外するのが要点（括弧で囲まれたリンクを取りこぼさない）。
 * 以前ここが食い違っていて、`(https://...)` 形式の投稿を
 * 「Spotify 以外」と誤判定してスキップしていた（PEレビュー検出）。
 */
function firstUrl(text) {
  const m = (text || "").match(/https?:\/\/[^\s)"'<>]+/);
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
    if (typeof d.iframe_url !== "string") return null;

    // ⚠️ 外部データなので iframe の src に流す前に検証する
    let parsed;
    try {
      parsed = new URL(d.iframe_url);
    } catch {
      return null;
    }
    if (parsed.protocol !== "https:") return null;
    if (!/(^|\.)spotify\.com$/.test(parsed.hostname)) return null;

    // 正規表現だと「utm_source=oembedX」のような別パラメータの接頭辞に
    // 誤マッチして URL を壊すため、URL API で正確に削除する。
    parsed.searchParams.delete("utm_source");

    // height も外部データ。数値化して妥当な範囲にクランプする。
    const h = Number(d.height);
    const height = Number.isFinite(h) && h > 0 && h <= 1000 ? Math.round(h) : 352;

    return { embedUrl: parsed.toString(), height, kind };
  } catch {
    return null;
  }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  // ⚠️ SQL で種別まで判定しない。以前は
  //   'open\.spotify\.com/(album|track|...)/' で絞っていたため、
  //   /intl-ja/album/... のようなロケール付き URL を**すべて取りこぼして**
  //   いた（Spotify の共有 UI は日本語環境で /intl-ja/ を出す）。
  //   候補は緩く絞り、判定は extractSpotify() に一本化する。
  // --only-spotify は「spotify キーが無い」で判定するので、oEmbed が
  //   投稿時に失敗して OGP だけ保存された投稿も拾える。
  const where = ONLY_SPOTIFY
    ? `text ~* 'spotify\\.com'
       AND NOT (COALESCE(url_preview, '{}')::jsonb ? 'spotify')`
    : `text ~* 'https?://'
       AND (url_preview IS NULL OR url_preview = 'null')`;

  const { rows } = await pool.query(
    `SELECT id, text, url_preview FROM posts WHERE ${where} ORDER BY id`
  );

  console.log(`候補: ${rows.length} 件${DRY_RUN ? " (dry-run)" : ""}`);
  if (!rows.length) {
    await pool.end();
    return;
  }

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    const url = firstUrl(row.text);
    if (!url) {
      console.log(`  #${row.id}: URL なし → スキップ`);
      skipped++;
      continue;
    }
    const sp = extractSpotify(url);
    if (!sp) {
      // 既定モードでは Spotify 以外も候補になるため、理由を明示する
      console.log(`  #${row.id}: Spotify 以外 → スキップ（${url.slice(0, 50)}）`);
      skipped++;
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

  console.log(
    `完了: 成功 ${ok} / スキップ ${skipped} / 失敗 ${failed}` +
      (DRY_RUN ? " (dry-run のため未保存)" : "")
  );
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
