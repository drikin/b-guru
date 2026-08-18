/* ビーグルエージェント: パイプライン実行（/api/beagle/tick・/check から呼ばれる） */
import { loadAgentMd, loadMemoryMd, memoryBytes } from "./files";
import { collectNewNews } from "./sources";
import { buildTimelineSignal, getRecentTimeline } from "./observe";
import { normalizeNextActivityAt } from "./schedule";
import { decide } from "./decide";
import { applyActions, newsUrlFromText, replyBudget } from "./act";
import { applyLearnings, extractLearningRequests } from "./learn";
import {
  appendBeagleLog,
  countBeaglePostsToday,
  getState,
  lastBeaglePostAgoMs,
  markResponded,
  resolveRoot,
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
  const respondedSet = new Set(state.respondedPosts);
  const [signal, recent] = await Promise.all([
    buildTimelineSignal(respondedSet),
    getRecentTimeline(),
  ]);
  const news = await collectNewNews(state.lastTickAt);

  const postsToday = await countBeaglePostsToday();
  const overCap = postsToday >= DAILY_POST_CAP;
  // 明示的 @ビーグル メンションの有無（日次cap到達時でも返信を許可する対象）
  const hasExplicitMention = signal.mentions.some((m) => m.explicit);

  // 頻度抑制: 直近15分以内に投稿済みなら、新しい言及への返信以外は控える
  const agoMin = Math.round((await lastBeaglePostAgoMs()) / 60000);
  let guidance: string | undefined;
  if (agoMin < 15) {
    guidance =
      `直近${Math.max(agoMin, 1)}分以内に投稿済み。新しいメンションへの返信だけを優先し、` +
      `追加のニュース投稿・孤立/ホットスレッドへの新規コメントは行わない。` +
      `次回まで控えめに間隔を空け、next_activity_at は30〜50分先に設定する。`;
  }
  // 日次ルート投稿上限到達でも、明示的 @ビーグル には返信する（返信はカウントしない）
  if (overCap && hasExplicitMention) {
    guidance =
      `本日のルート投稿上限(${DAILY_POST_CAP})に達しています。` +
      `明示的 @ビーグル メンションへの返信のみを行い、` +
      `ニュース投稿・孤立/ホットスレッドへの新規コメントは行わない。` +
      `next_activity_at は30〜50分先に設定する。`;
  }

  let decision: BeagleDecision;
  if (overCap && !hasExplicitMention) {
    decision = {
      intent: "none",
      actions: [],
      learnings: [],
      next_activity_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      note: `本日の投稿上限(${DAILY_POST_CAP})到達`,
    };
  } else {
    decision = await decide({ agentMd, memoryMd, signal, news, recent, now, guidance });
  }

  const next = normalizeNextActivityAt(decision.next_activity_at);

  // 明示 @ビーグル メンション数に応じて返信予算を拡張（同一スレッド内の複数コメントにも必ず反応）
  const explicitMentionCount = signal.mentions.filter((m) => m.explicit).length;
  const budget = replyBudget(explicitMentionCount);

  // 実行（dry なら投稿しない）
  const execute = !opts.dry;
  const { postedIds, repliedTo } = await applyActions(
    decision,
    !execute,
    respondedSet,
    budget
  );

  // 返信した投稿（とそのルート）を記録 → 次回から同一投稿/スレッドへの再返信を防止
  if (execute && repliedTo.length > 0) {
    const roots = await Promise.all(repliedTo.map(resolveRoot));
    await markResponded([...repliedTo, ...roots]);
  }

  // 学習（dry ならメモリ書き込みはしない）
  let memoryAfter = memoryBefore;
  if (execute) {
    // メンション本文に明示的な学習指示があれば、LLM の learnings と合算して必ず学習する
    const explicitRequests: string[] = [];
    for (const m of signal.mentions) {
      for (const req of extractLearningRequests(m.text)) {
        if (!explicitRequests.includes(req)) explicitRequests.push(req);
      }
    }
    const allLearnings = [...decision.learnings, ...explicitRequests];
    if (allLearnings.length > 0) {
      const l = await applyLearnings(allLearnings);
      memoryAfter = l.bytesAfter;
    }
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
