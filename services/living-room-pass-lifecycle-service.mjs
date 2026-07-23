import {
  calculateActiveSecondsUsed,
  HomeOrchestrationError
} from "./home-orchestration-service.mjs";

import {
  alignPassEndToRemaining
} from "./activity-clock-service.mjs";


const COUNTED_RUN_STATUSES = [
  "running",
  "completed",
  "silent",
  "failed"
];


async function requireData(
  promise,
  code,
  message
) {
  const { data, error } = await promise;

  if (error) {
    throw new HomeOrchestrationError(
      code,
      message,
      500,
      {
        databaseCode: error.code ?? null,
        databaseMessage: error.message ?? null
      }
    );
  }

  return data;
}


function normalizeText(value, maximum = 10_000) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maximum);
}


function normalizeOptionalInteger(
  value,
  maximum = 10_000
) {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return value === undefined
      ? undefined
      : null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.min(
    maximum,
    Math.max(0, Math.round(parsed))
  );
}


export function resolveSafeModelCallBudget({
  requestedBudget,
  usedCalls
}) {
  const normalized = normalizeOptionalInteger(
    requestedBudget,
    10_000
  );

  if (normalized === undefined) {
    return undefined;
  }

  if (normalized === null) {
    return null;
  }

  return Math.max(
    Math.max(0, Math.round(Number(usedCalls) || 0)),
    normalized
  );
}


export function resolveCurrentBudgetStop({
  progress,
  pass,
  modelCallsUsed = 0
}) {
  if (!progress) {
    return null;
  }

  const checks = [
    {
      reached:
        progress.input_token_budget != null &&
        Number(progress.input_tokens_used || 0) >=
          Number(progress.input_token_budget),
      reason: "input_token_budget_exhausted"
    },
    {
      reached:
        progress.output_token_budget != null &&
        Number(progress.output_tokens_used || 0) >=
          Number(progress.output_token_budget),
      reason: "output_token_budget_exhausted"
    },
    {
      reached:
        progress.max_cost_usd != null &&
        Number(progress.estimated_cost_usd || 0) >=
          Number(progress.max_cost_usd),
      reason: "cost_budget_exhausted"
    },
    {
      reached:
        pass?.max_model_calls != null &&
        Number(modelCallsUsed || 0) >=
          Number(pass.max_model_calls),
      reason: "model_call_budget_exhausted"
    }
  ];

  return checks.find((item) => item.reached)
    ?.reason ?? null;
}


export async function countActivityModelRuns({
  serviceClient,
  userId,
  activityPassId
}) {
  const rows = await requireData(
    serviceClient
      .from("activity_runs")
      .select("id")
      .eq("owner_user_id", userId)
      .eq("activity_pass_id", activityPassId)
      .in("status", COUNTED_RUN_STATUSES)
      .limit(10_000),
    "activity_model_runs_count_failed",
    "无法读取这张通行证已经使用的模型调用次数"
  );

  return rows?.length ?? 0;
}


export async function updateFreeActivitySafely({
  serviceClient,
  livingRoomService,
  orchestrationService,
  userId,
  activityPassId,
  patch,
  source = "living_room_v2",
  now = new Date()
}) {
  const modelCallsUsed =
    await countActivityModelRuns({
      serviceClient,
      userId,
      activityPassId
    });

  const safeMaxModelCalls =
    resolveSafeModelCallBudget({
      requestedBudget:
        patch.maxModelCalls,
      usedCalls: modelCallsUsed
    });

  const result =
    await livingRoomService.updateFreeActivity({
      userId,
      activityPassId,
      addActiveMinutes:
        patch.addActiveMinutes ?? 0,
      inputTokenBudget:
        patch.inputTokenBudget,
      outputTokenBudget:
        patch.outputTokenBudget,
      maxCostUsd:
        patch.maxCostUsd,
      maxModelCalls:
        safeMaxModelCalls,
      currentTask:
        patch.currentTask,
      progressSummary:
        patch.progressSummary,
      resumePolicy:
        patch.resumePolicy,
      now
    });

  const budgetStop =
    resolveCurrentBudgetStop({
      progress: result.progress,
      pass: result.pass,
      modelCallsUsed
    });

  if (
    budgetStop &&
    result.progress?.state === "running"
  ) {
    const paused =
      await orchestrationService.pauseFreeActivity({
        userId,
        state: "paused_by_budget",
        reason: budgetStop,
        resumePolicy:
          result.progress.resume_policy,
        now
      });

    return {
      ...result,
      pass: paused.pass ?? result.pass,
      progress:
        paused.progress ?? result.progress,
      remaining:
        paused.remaining ?? result.remaining,
      modelCallsUsed,
      effectiveMaxModelCalls:
        safeMaxModelCalls,
      pausedByCurrentBudget: budgetStop,
      activityClockAligned: false
    };
  }

  const aligned =
    await alignPassEndToRemaining({
      serviceClient,
      userId,
      pass: result.pass,
      progress: result.progress,
      remaining: result.remaining,
      source,
      now
    });

  return {
    ...result,
    ...aligned,
    modelCallsUsed,
    effectiveMaxModelCalls:
      safeMaxModelCalls,
    pausedByCurrentBudget: null,
    activityClockAligned:
      aligned.aligned
  };
}


function interactionDetail(channel) {
  if (channel === "official_chat") {
    return "G 正在官端陪谢诗";
  }

  if (channel === "bedroom_chat") {
    return "G 正在卧室陪谢诗";
  }

  return "G 正在和谢诗一起活动";
}


export async function finishFreeActivityPass({
  serviceClient,
  userId,
  activityPassId,
  finalState = "completed",
  summary = null,
  source = "living_room_v2",
  now = new Date()
}) {
  if (!["completed", "cancelled"].includes(finalState)) {
    throw new HomeOrchestrationError(
      "invalid_free_activity_final_state",
      "通行证只能标记为完成或取消",
      400
    );
  }

  const currentTime =
    now instanceof Date ? now : new Date(now);

  if (Number.isNaN(currentTime.getTime())) {
    throw new HomeOrchestrationError(
      "invalid_free_activity_finish_time",
      "结束通行证时收到了无效时间",
      400
    );
  }

  const pass = await requireData(
    serviceClient
      .from("activity_passes")
      .select("*")
      .eq("owner_user_id", userId)
      .eq("id", activityPassId)
      .single(),
    "free_activity_finish_pass_read_failed",
    "无法读取要结束的活动通行证"
  );

  const progress = await requireData(
    serviceClient
      .from("free_activity_progress")
      .select("*")
      .eq("owner_user_id", userId)
      .eq("activity_pass_id", activityPassId)
      .single(),
    "free_activity_finish_progress_read_failed",
    "无法读取要结束的活动进度"
  );

  const activeSecondsUsed =
    calculateActiveSecondsUsed({
      activeSecondsUsed:
        progress.active_seconds_used,
      lastResumedAt:
        progress.last_resumed_at,
      state: progress.state,
      now: currentTime,
      activeSecondsBudget:
        progress.active_seconds_budget
    });

  const cleanSummary =
    normalizeText(summary, 10_000) ||
    progress.progress_summary ||
    (finalState === "completed"
      ? "本次自由活动已经完成。"
      : "本次自由活动已由大管家取消。" );

  const updatedProgress = await requireData(
    serviceClient
      .from("free_activity_progress")
      .update({
        state: finalState,
        active_seconds_used:
          activeSecondsUsed,
        last_resumed_at: null,
        paused_at:
          currentTime.toISOString(),
        pause_reason:
          finalState === "completed"
            ? "completed_by_owner"
            : "cancelled_by_owner",
        progress_summary: cleanSummary,
        metadata: {
          ...(progress.metadata ?? {}),
          finalizedAt:
            currentTime.toISOString(),
          finalizedBy: source,
          finalState
        }
      })
      .eq("owner_user_id", userId)
      .eq("activity_pass_id", activityPassId)
      .select("*")
      .single(),
    "free_activity_finish_progress_update_failed",
    "无法保存通行证的最终进度"
  );

  const updatedPass = await requireData(
    serviceClient
      .from("activity_passes")
      .update({
        status: finalState,
        ends_at: currentTime.toISOString()
      })
      .eq("owner_user_id", userId)
      .eq("id", activityPassId)
      .select("*")
      .single(),
    "free_activity_finish_pass_update_failed",
    "无法结束活动通行证"
  );

  const activeInteraction = await requireData(
    serviceClient
      .from("home_interaction_sessions")
      .select("*")
      .eq("owner_user_id", userId)
      .eq("status", "active")
      .gt(
        "expires_at",
        currentTime.toISOString()
      )
      .order("last_seen_at", {
        ascending: false
      })
      .limit(1)
      .maybeSingle(),
    "free_activity_finish_interaction_read_failed",
    "无法确认通行证结束后的互动状态"
  );

  const presencePayload = activeInteraction
    ? {
        owner_user_id: userId,
        status: "awake",
        status_detail:
          interactionDetail(
            activeInteraction.channel
          ),
        source,
        current_activity_pass_id: null,
        current_activity_run_id: null,
        free_activity_until: null,
        heartbeat_paused_until:
          activeInteraction.expires_at,
        metadata: {
          mode: "interactive_awake",
          interactionSessionId:
            activeInteraction.id,
          lastFinishedActivityPassId:
            activityPassId
        }
      }
    : {
        owner_user_id: userId,
        status: "resting",
        status_detail: "G 在卧室休息",
        source,
        current_activity_pass_id: null,
        current_activity_run_id: null,
        awake_until: null,
        free_activity_until: null,
        heartbeat_paused_until: null,
        next_heartbeat_at: null,
        metadata: {
          mode: "resting",
          lastFinishedActivityPassId:
            activityPassId
        }
      };

  const presence = await requireData(
    serviceClient
      .from("home_presence")
      .upsert(presencePayload, {
        onConflict: "owner_user_id"
      })
      .select("*")
      .single(),
    "free_activity_finish_presence_failed",
    "通行证已经结束，但无法同步全屋状态"
  );

  const { error: eventError } =
    await serviceClient
      .from("home_events")
      .insert({
        owner_user_id: userId,
        actor: "xie_shi",
        source,
        event_type:
          finalState === "completed"
            ? "free_activity_completed_by_owner"
            : "free_activity_cancelled_by_owner",
        room: "living_room",
        title:
          finalState === "completed"
            ? "自由活动已经完成"
            : "自由活动已经取消",
        detail: cleanSummary,
        visibility: "home_private",
        is_user_visible: true,
        activity_pass_id:
          activityPassId,
        metadata: {
          activeSecondsUsed,
          finalState
        }
      });

  if (eventError) {
    console.warn(
      "记录通行证收尾事件失败：",
      eventError.message
    );
  }

  return {
    pass: updatedPass,
    progress: updatedProgress,
    presence,
    finalState,
    modelCalled: false
  };
}
