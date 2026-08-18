/* ビーグルエージェント: パイプライン実行（/api/beagle/tick・/check から呼ばれる） */
import { loadAgentMd, loadMemoryMd, memoryBytes } from "./files";
import { collectNewNews } from "./sources";
import { buildTimelineSignal, getRecentTimeline } from "./observe";
import { normalizeNextActivityAt } from "./schedule";
import { decide } from "./decide";
import { applyActions, newsUrlFromText } from "./act";
import { applyLearnings } from "./learn";
import {
  appendBeagleLog,
  countBeaglePostsToday,
  getState,
  updateState,
} from "./store";
import type { BeagleDecision, BeagleTickResult } from "./types";

const DAILY_POST_CAP = 8;

/** 外部 cron が叩くメイン処理。dry なら投稿・メモリ書き込みは行わず決定のみ記録。 */
export async function runBeagleTick(opts: {
  dry: boolean;
}): Promise<BeagleTickResult> {
  const state = await getState();
  const now = new Date();

  if (!state.enabled) {
    const logId = await appendBeagleLog({
      mode: "dry",
      intent: "none",
      error: "disabled",
    });
    return { mode: "dry", decision: null, postedIds: [], logId, disabled: true };
  }

  const memoryBefore = await memoryBytes();
  const [agentMd, memoryMd] = await Promise.all([loadAgentMd(), loadMemoryMd()]);
  const [signal, recent] = await Promise.all([buildTimelineSignal(), getRecentTimeline()]);
  const news = await collectNewNews(state.lastTickAt);

  const postsToday = await countBeaglePostsToday();
  const overCap = postsToday >= DAILY_POST_CAP;

  let decision: BeagleDecision;
  if (overCap) {
    decision = {
      intent: "none",
      actions: [],
      learnings: [],
      next_activity_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      note: `本日の投稿上限(${DAILY_POST_CAP})到達`,
    };
  } else {
    decision = await decide({ agentMd, memoryMd, signal, news, recent, now });
  }

  const next = normalizeNextActivityAt(decision.next_activity_at);

  // 実行（dry なら投稿しない）
  const execute = !opts.dry;
  const { postedIds } = await applyActions(decision, !execute);

  // 学習（dry ならメモリ書き込みはしない）
  let memoryAfter = memoryBefore;
  if (execute && decision.learnings.length > 0) {
    const l = await applyLearnings(decision.learnings);
    memoryAfter = l.bytesAfter;
  }

  // ニュース重複防止: 実際に投稿された本文のURLを記録（live のみ）
  let postedNews = state.postedNews;
  if (execute && postedIds.length > 0) {
    for (const a of decision.actions) {
      const url = newsUrlFromText(a.text);
      if (url && !postedNews.includes(url)) {
        postedNews = [...postedNews, url].slice(-200);
      }
    }
  }

  await updateState({
    lastTickAtRaw: now,
    nextActivityAtRaw: next,
    memoryBytes: memoryAfter,
    postedNews,
  });

  const logId = await appendBeagleLog({
    mode: execute ? "live" : "dry",
    intent: decision.intent,
    decision,
    actions: decision.actions,
    postedIds,
    nextActivityAt: next.toISOString(),
    memoryBytesBefore: memoryBefore,
    memoryBytesAfter: memoryAfter,
  });

  return { mode: execute ? "live" : "dry", decision, postedIds, logId };
}
