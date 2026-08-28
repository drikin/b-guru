/* 部活動ラベル自動付与（さくらのAI Engine）— サーバー専用。
 *
 * ルート投稿の本文を さくらのAI Engine（gpt-oss-120b）で解析し、B-guru の
 * 部活動リスト（club-catalog.ts）から「もっとも当てはまる部活」を 1 つだけ
 * 付与する。当てはまる部活がなければ club=NULL（ラベルなし）にする。
 *
 * - 分類対象はルート投稿のみ（返信は親に従属）。publish 後 fire-and-forget で
 *   呼ばれる（投稿の即時反映をブロックしない）。
 * - 出力の検証は最重要（trends の教訓）: モデルがリストに無い部活名を
 *   ハルシネーションするため、`parseClubOutput` で CLUB_KEYS に一致するもの
 *   だけを採用し、それ以外は NULL 扱いにする。
 * - 手動付け替え（club_manual=TRUE）された投稿は自動分類で上書きしない。
 *
 * 純データ・純関数（CLUB_KEYS / CLUB_LABEL / parseClubOutput 等）はクライアントから
 * も使うため club-catalog.ts に置いてある。ここでは再エクスポートする。
 */

import { pool } from "./db";
import { sakuraChat } from "./sakura";
import { emitLive } from "./live";
import {
  CLUBS,
  CLUB_KEYS,
  CLUB_UNSET,
  clubLabel,
  parseClubOutput,
  buildClubFewShot,
  type ClubDef,
  type ClubExample,
} from "./club-catalog";
import { listClubs } from "./club-store";

export type { ClubDef } from "./club-catalog";
export { CLUBS, CLUB_KEYS, clubLabel, parseClubOutput } from "./club-catalog";

/** 新規部活の「AI判定定義」を さくらのAI Engine で自動生成する（admin の追加フォーム用）。
 *  既存部活の判定定義（例: 「撮影・被写体・構図・写真作品そのものの話」）と同じ流儀で、
 *  その部活に当てはまる話題のキーワードを1文で返す。name は必須。 */
export async function generateClubDefinition(input: {
  key: string;
  name: string;
  category: string;
}): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new Error("NAME_REQUIRED");
  const key = input.key.trim() || "(未定)";
  const category = input.category.trim() || "その他";

  const sys = `あなたは B-guru（backspace.fm の有料会員コミュニティ）の部活動ラベル設計エージェントです。
ある部活動をAI分類するための「判定定義」を1文だけ作ってください。判定定義は、その部活に当てはまる投稿の話題・キーワードを簡潔に列挙した日本語の1文（例: 「撮影・被写体・構図・写真作品そのものの話」）にしてください。

既存部活の判定定義の例（この流儀に合わせる）:
- 写真部: 撮影・被写体・構図・写真作品そのものの話
- カメラ部: カメラ/レンズの機材・ボディ・スペックの話（写真部とは別）
- 車部: 車そのもの・運転・所有・購入・整備の話
- モータースポーツ部: レース・サーキット・モータースポーツ観戦の話（車部とは別）
- 音楽部: 楽曲・アーティスト・演奏・音楽鑑賞の話
- 音響部: オーディオ機器・試聴・セッティング・音質の話（音楽部とは別）
- バグ報告: 不具合・バグ・エラー・動作不良・再接続等の問題の報告・相談・再現の話

出力は判定定義の1文だけ（「◯◯・◯◯・◯◯の話」の形式）で返してください。箇条書き・説明・引用符は不要です。`;

  const user = `新しく作る部活:
- key: ${key}
- 名前: ${name}
- カテゴリ: ${category}`;

  const res = await sakuraChat({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: user },
    ],
    // gpt-oss-120b は先に reasoning（思考）を出力するため、最終文まで出せるだけの余裕を持つ。
    max_tokens: 500,
    temperature: 0.3,
  });

  let def = res.content
    .replace(/^[\s"'`*•·-]+|[\s"'`*]+$/g, "")
    .split(/\r?\n/)[0]
    .trim();
  // 1文として妥当な最低限を保証（名前に依存しない場合でも空にしない）
  if (!def) def = `${name}の話`;
  return def;
}

/** 分類プロンプトを、DB の active 部活一覧から動的構築する（admin が追加/編集した部活も反映）。 */
function buildClubSystemPrompt(clubs: ClubDef[]): string {
  return `あなたは B-guru（backspace.fm の有料会員コミュニティ）の部活動分類エージェントです。
ユーザーの投稿を読み、もっとも当てはまる部活動を 1 つだけ選んでください。当てはまる部活がなければ none と答えてください。

部活一覧（key = 日本語名: 分類定義）:
${clubs.map((c) => `${c.key} = ${c.name}: ${c.def}`).join("\n")}

重要:
- 出力は「key だけ」の1語で返してください。key は必ず上記一覧に存在する英字キーにする。
- 必ず1つだけ。複数候補があってももっとも強い1つに絞る。
${clubs.filter((c) => ["photo, camera", "car, motorsport", "music, audio"].some((p) => p.split(", ").includes(c.key))).length ? "- 写真部(photo/撮影)とカメラ部(camera/機材)、車部(car)とモータースポーツ部(motorsport)、音楽部(music)と音響部(audio)は定義に従って区別する。\n" : ""}- 一般的な雑談・日常・近況・仕事・健康など、どの部活にも属さない話題は 雑談(chat) に誘導する。
- どの部活にも当てはまらず、雑談(chat)にも含めにくい場合のみ none。
- 本文に出てこない部活を決して選ばないこと。
- 参考例（最近の正解ラベル）が与えられたら、その分類の流儀・語彙に合わせて分類すること。「人力で設定された正解ラベル」の例は最優先で参考にする。`;
}

/** 学習に使う直近のラベル付き投稿を取得する。自己推測の増幅(ドリフト)を防ぐため、
 *  人間が設定した正解ラベル(club_manual=TRUE)のみを学習根拠にする。未設定は除外。 */
export async function recentLabeledExamples(limit = 60): Promise<ClubExample[]> {
  const { rows } = await pool.query(
    `SELECT text, club, (club_manual AND club IS NOT NULL) AS manual
       FROM posts
      WHERE club IS NOT NULL
        AND club <> $2 -- 未設定は学習例にしない（AI に未設定を出力させない）
        AND club_manual = TRUE -- 人間の正解ラベルのみ（自動推測の増幅を防ぐ）
        AND text IS NOT NULL AND length(btrim(text)) > 8
      ORDER BY id DESC
      LIMIT $1`,
    [limit, CLUB_UNSET]
  );
  return rows.map((r) => ({
    text: typeof r.text === "string" ? r.text : "",
    club: r.club as string,
    manual: !!r.manual,
  }));
}

/** 指定ルート投稿を自動分類する。fire-and-forget で呼ばれる。
 *  成功（該当なし含む）で classified_at を更新、失敗時は更新しない（再試行可能）。
 *  手動付け替え済み（club_manual）の投稿は上書きしない。 */
export async function classifyPost(postId: number): Promise<string | null> {
  try {
    const { rows } = await pool.query(
      `SELECT text, parent_id, club_manual FROM posts WHERE id = $1`,
      [postId]
    );
    const row = rows[0];
    if (!row) return null; // 存在しない
    if (row.parent_id != null) return null; // ルートのみ
    if (row.club_manual) return row.club ?? null; // 手動が正本 → スキップ

    const text: string = (row.text ?? "").slice(0, 2000);
    // 分類対象は DB の active 部活（admin が追加/編集/削除した部活を反映）
    const dbClubs = await listClubs({ activeOnly: true });
    const activeKeys = new Set<string>(dbClubs.map((c) => c.key));
    // 自己学習: 直近の正解ラベル（特に人力設定）を few-shot 例として注入し、
    // コミュニティの実際の語彙・流儀に合わせて分類精度を上げる。例が無ければ従来どおり。
    // 削除済み(非active)クラブの例は混ぜない（AI が非activeキーを出力しないよう active のみ）。
    const examples = (await recentLabeledExamples()).filter((e) =>
      activeKeys.has(e.club)
    );
    const fewShot = buildClubFewShot(examples);
    const userMsg = fewShot
      ? `投稿内容:\n\n【最近の正解ラベルの例（人力設定の例を優先。同じ考え方・語彙で分類してください）】\n${fewShot}\n\n---\n\n${text || "(テキストなし)"}`
      : `投稿内容:\n${text || "(テキストなし)"}`;
    const res = await sakuraChat({
      messages: [
        { role: "system", content: buildClubSystemPrompt(dbClubs.map((c) => ({ key: c.key, name: c.name, def: c.definition }) as ClubDef)) },
        { role: "user", content: userMsg },
      ],
      temperature: 0.1,
      // gpt-oss-120b は先に reasoning（思考）を出力する。max_tokens が小さいと
      // reasoning 中に token 上限へ達して content:null／空応答になる（実測）。
      // 思考を完了させて最終キーまで出させるため多めに割り当てる。
      max_tokens: 2000,
    });
    const club = parseClubOutput(res.content, activeKeys) ?? CLUB_UNSET;

    // classified_at を更新。該当なし(未設定)も「試行済み」として __unset__ を記録し、
    // 一覧化できるようにする（club=NULL=未分類/手動ラベルなしとは区別）。
    // club_manual ガードで、この間の手動変更を上書きしない。
    await pool.query(
      `UPDATE posts SET club = $1, classified_at = now()
         WHERE id = $2 AND club_manual IS NOT TRUE`,
      [club, postId]
    );
    emitLive({ type: "club", postId, club });
    return club;
  } catch (e) {
    console.error("classifyPost error:", (e as any)?.message);
    return null;
  }
}
