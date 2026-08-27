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
  clubLabel,
  parseClubOutput,
  type ClubDef,
} from "./club-catalog";

export type { ClubDef } from "./club-catalog";
export { CLUBS, CLUB_KEYS, clubLabel, parseClubOutput } from "./club-catalog";

const CLUB_SYSTEM_PROMPT = `あなたは B-guru（backspace.fm の有料会員コミュニティ）の部活動分類エージェントです。
ユーザーの投稿を読み、もっとも当てはまる部活動を 1 つだけ選んでください。当てはまる部活がなければ none と答えてください。

部活一覧（key = 日本語名: 分類定義）:
${CLUBS.map((c) => `${c.key} = ${c.name}: ${c.def}`).join("\n")}

重要:
- 出力は「key だけ」の1語で返してください。key は必ず上記一覧に存在する英字キーにする。
- 必ず1つだけ。複数候補があってももっとも強い1つに絞る。
- 写真部(photo/撮影)とカメラ部(camera/機材)、車部(car)とモータースポーツ部(motorsport)、音楽部(music)と音響部(audio)は定義に従って区別する。
- どの部活にも当てはまらない一般的な雑談・仕事・健康・日常の話は none。
- 本文に出てこない部活を決して選ばないこと。`;

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
    const res = await sakuraChat({
      messages: [
        { role: "system", content: CLUB_SYSTEM_PROMPT },
        { role: "user", content: `投稿内容:\n${text || "(テキストなし)"}` },
      ],
      temperature: 0.1,
      max_tokens: 40,
    });
    const club = parseClubOutput(res.content);

    // classified_at を更新（該当なしでも「試行済み」として記録＝再処理しない）。
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
