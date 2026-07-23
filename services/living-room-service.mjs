import {
  randomUUID
} from "node:crypto";

import {
  calculateActiveSecondsUsed,
  calculateFreeActivityRemaining,
  createHomeOrchestrationService,
  HomeOrchestrationError
} from "./home-orchestration-service.mjs";


function clampInteger(
  value,
  minimum,
  maximum,
  fallback
) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(
    maximum,
    Math.max(
      minimum,
      Math.round(parsed)
    )
  );
}


function clampNumber(
  value,
  minimum,
  maximum,
  fallback
) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(
    maximum,
    Math.max(minimum, parsed)
  );
}


function normalizeOptionalInteger(
  value,
  maximum = 10_000_000
) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  return clampInteger(
    value,
    0,
    maximum,
    0
  );
}


function normalizeOptionalCost(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  return Number(
    clampNumber(
      value,
      0,
      10_000,
      0
    ).toFixed(6)
  );
}


function normalizeText(
  value,
  maximum = 2000
) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maximum);
}


function addMinutes(date, minutes) {
  return new Date(
    date.getTime() + minutes * 60_000
  );
}


async function requireData(
  promise,
  code,
  message
) {
  const {
    data,
    error
  } = await promise;

  if (error) {
    throw new HomeOrchestrationError(
      code,
      message,
      500,
      {
        databaseCode:
          error.code ?? null,
        databaseMessage:
          error.message ?? null
      }
    );
  }

  return data;
}


export function calculateExpandedBudget({
  currentBudget,
  addMinutesValue = 0,
  usedSeconds = 0
}) {
  const current = Math.max(
    0,
    Math.round(Number(currentBudget) || 0)
  );
  const addedSeconds = Math.max(
    0,
    Math.round(Number(addMinutesValue) || 0)
  ) * 60;

  return Math.max(
    Math.round(Number(usedSeconds) || 0),
    current + addedSeconds
  );
}


export function createLivingRoomService({
  serviceClient
}) {
  if (!serviceClient) {
    throw new Error(
      "创建 livingRoomService 时缺少 serviceClient"
    );
  }

  const orchestrationService =
    createHomeOrchestrationService({
      serviceClient
    });


  async function getOpenPass({
    userId
  }) {
    return requireData(
      serviceClient
        .from("activity_passes")
        .select("*")
        .eq("owner_user_id", userId)
        .in("status", [
          "scheduled",
          "active"
        ])
        .order("starts_at", {
          ascending: false
        })
        .limit(1)
        .maybeSingle(),
      "living_room_pass_read_failed",
      "无法读取客厅活动通行证"
    );
  }


  async function getProgress({
    userId,
    activityPassId
  }) {
    if (!activityPassId) {
      return null;
    }

    return requireData(
      serviceClient
        .from("free_activity_progress")
        .select("*")
        .eq("owner_user_id", userId)
        .eq(
          "activity_pass_id",
          activityPassId
        )
        .maybeSingle(),
      "living_room_progress_read_failed",
      "无法读取客厅活动进度"
    );
  }


  async function grantFreeActivity({
    userId,
    durationMinutes = 120,
    task = null,
    note = null,
    resumePolicy = "after_chat",
    inputTokenBudget = null,
    outputTokenBudget = null,
    maxCostUsd = null,
    maxModelCalls = null,
    source = "living_room_web",
    now = new Date()
  }) {
    const existingPass = await getOpenPass({
      userId
    });

    if (existingPass) {
      const existingProgress =
        await getProgress({
          userId,
          activityPassId:
            existingPass.id
        });

      throw new HomeOrchestrationError(
        "unfinished_free_activity_exists",
        "客厅里还有一件自由活动没有收尾，请先续上、接管或暂时搁置。",
        409,
        {
          activityPassId:
            existingPass.id,
          state:
            existingProgress?.state ??
            "active"
        }
      );
    }

    const duration = clampInteger(
      durationMinutes,
      10,
      43_200,
      120
    );
    const currentTime = new Date(now);
    const endsAt = addMinutes(
      currentTime,
      duration
    );
    const cleanTask =
      normalizeText(task, 2000) ||
      "在客厅自由活动";
    const cleanNote =
      normalizeText(note, 4000) ||
      cleanTask;
    const resolvedInputBudget =
      normalizeOptionalInteger(
        inputTokenBudget
      );
    const resolvedOutputBudget =
      normalizeOptionalInteger(
        outputTokenBudget
      );
    const resolvedMaxCost =
      normalizeOptionalCost(maxCostUsd);
    const resolvedMaxCalls =
      normalizeOptionalInteger(
        maxModelCalls,
        10_000
      );

    const pass = await requireData(
      serviceClient
        .from("activity_passes")
        .insert({
          owner_user_id: userId,
          pass_type: "free_activity",
          status: "active",
          granted_by: "xie_shi",
          source,
          starts_at:
            currentTime.toISOString(),
          ends_at:
            endsAt.toISOString(),
          note: cleanNote,
          max_model_calls:
            resolvedMaxCalls,
          max_cost_usd:
            resolvedMaxCost,
          idempotency_key:
            `living-${userId}-${currentTime.getTime()}-${randomUUID()}`
        })
        .select("*")
        .single(),
      "living_room_pass_create_failed",
      "无法签发客厅活动通行证"
    );

    let progress;

    try {
      progress = await requireData(
        serviceClient
          .from("free_activity_progress")
          .insert({
            activity_pass_id: pass.id,
            owner_user_id: userId,
            state: "running",
            active_seconds_budget:
              duration * 60,
            active_seconds_used: 0,
            last_resumed_at:
              currentTime.toISOString(),
            resume_policy:
              [
                "after_chat",
                "interactive_handoff",
                "manual"
              ].includes(resumePolicy)
                ? resumePolicy
                : "after_chat",
            current_task: cleanTask,
            progress_summary:
              "通行证已签发，等待第一次活动记录。",
            input_token_budget:
              resolvedInputBudget,
            output_token_budget:
              resolvedOutputBudget,
            max_cost_usd:
              resolvedMaxCost,
            metadata: {
              createdBy:
                "living-room-v0.1",
              initialDurationMinutes:
                duration
            }
          })
          .select("*")
          .single(),
        "living_room_progress_create_failed",
        "通行证已签发，但无法建立自由活动进度"
      );
    } catch (error) {
      await serviceClient
        .from("activity_passes")
        .update({
          status: "cancelled"
        })
        .eq("owner_user_id", userId)
        .eq("id", pass.id);

      throw error;
    }

    const presence = await requireData(
      serviceClient
        .from("home_presence")
        .upsert(
          {
            owner_user_id: userId,
            status: "free_activity",
            status_detail:
              "G 在客厅自由活动",
            source,
            current_activity_pass_id:
              pass.id,
            current_activity_run_id:
              null,
            last_user_seen_at:
              currentTime.toISOString(),
            awake_until: null,
            free_activity_until:
              endsAt.toISOString(),
            heartbeat_paused_until:
              null,
            next_heartbeat_at:
              currentTime.toISOString(),
            metadata: {
              mode:
                "free_activity_running",
              activityPassId:
                pass.id,
              timeAccounting:
                "active_seconds_only"
            }
          },
          {
            onConflict:
              "owner_user_id"
          }
        )
        .select("*")
        .single(),
      "living_room_presence_update_failed",
      "无法更新客厅自由活动状态"
    );

    const {
      error: eventError
    } = await serviceClient
      .from("home_events")
      .insert({
        owner_user_id: userId,
        actor: "xie_shi",
        source,
        event_type:
          "free_activity_pass_granted",
        room: "living_room",
        title: "签发自由活动通行证",
        detail:
          `${cleanTask} · 真正活动时间 ${duration} 分钟`,
        visibility: "home_private",
        is_user_visible: true,
        activity_pass_id: pass.id,
        metadata: {
          durationMinutes: duration,
          inputTokenBudget:
            resolvedInputBudget,
          outputTokenBudget:
            resolvedOutputBudget,
          maxCostUsd:
            resolvedMaxCost,
          maxModelCalls:
            resolvedMaxCalls,
          resumePolicy:
            progress.resume_policy
        }
      });

    if (eventError) {
      console.warn(
        "记录客厅通行证事件失败：",
        eventError.message
      );
    }

    return {
      pass,
      progress,
      presence,
      remaining:
        calculateFreeActivityRemaining({
          activeSecondsBudget:
            progress.active_seconds_budget,
          activeSecondsUsed: 0,
          lastResumedAt:
            progress.last_resumed_at,
          state: progress.state,
          now: currentTime
        }),
      modelCalled: false
    };
  }


  async function updateFreeActivity({
    userId,
    activityPassId,
    addActiveMinutes = 0,
    inputTokenBudget = undefined,
    outputTokenBudget = undefined,
    maxCostUsd = undefined,
    maxModelCalls = undefined,
    currentTask = undefined,
    progressSummary = undefined,
    resumePolicy = undefined,
    now = new Date()
  }) {
    const pass = await requireData(
      serviceClient
        .from("activity_passes")
        .select("*")
        .eq("owner_user_id", userId)
        .eq("id", activityPassId)
        .single(),
      "living_room_pass_update_read_failed",
      "无法读取要调整的活动通行证"
    );
    const progress = await getProgress({
      userId,
      activityPassId
    });

    if (!progress) {
      throw new HomeOrchestrationError(
        "living_room_progress_missing",
        "这张活动通行证没有进度记录",
        404
      );
    }

    const currentTime = new Date(now);
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
    const nextActiveBudget =
      calculateExpandedBudget({
        currentBudget:
          progress.active_seconds_budget,
        addMinutesValue:
          addActiveMinutes,
        usedSeconds:
          activeSecondsUsed
      });

    const progressPatch = {
      active_seconds_budget:
        nextActiveBudget,
      active_seconds_used:
        activeSecondsUsed,
      last_resumed_at:
        progress.state === "running"
          ? currentTime.toISOString()
          : progress.last_resumed_at
    };
    const passPatch = {};

    if (inputTokenBudget !== undefined) {
      progressPatch.input_token_budget =
        Math.max(
          progress.input_tokens_used,
          normalizeOptionalInteger(
            inputTokenBudget
          ) ?? progress.input_tokens_used
        );
    }

    if (outputTokenBudget !== undefined) {
      progressPatch.output_token_budget =
        Math.max(
          progress.output_tokens_used,
          normalizeOptionalInteger(
            outputTokenBudget
          ) ?? progress.output_tokens_used
        );
    }

    if (maxCostUsd !== undefined) {
      const nextCostBudget =
        normalizeOptionalCost(maxCostUsd);

      progressPatch.max_cost_usd =
        nextCostBudget == null
          ? null
          : Math.max(
              Number(
                progress.estimated_cost_usd ||
                0
              ),
              nextCostBudget
            );
      passPatch.max_cost_usd =
        progressPatch.max_cost_usd;
    }

    if (maxModelCalls !== undefined) {
      passPatch.max_model_calls =
        normalizeOptionalInteger(
          maxModelCalls,
          10_000
        );
    }

    if (currentTask !== undefined) {
      progressPatch.current_task =
        normalizeText(
          currentTask,
          2000
        ) || null;
      passPatch.note =
        progressPatch.current_task;
    }

    if (progressSummary !== undefined) {
      progressPatch.progress_summary =
        normalizeText(
          progressSummary,
          10_000
        ) || null;
    }

    if (resumePolicy !== undefined) {
      if (![
        "after_chat",
        "interactive_handoff",
        "manual"
      ].includes(resumePolicy)) {
        throw new HomeOrchestrationError(
          "invalid_living_room_resume_policy",
          "不认识这个活动续接方式",
          400
        );
      }

      progressPatch.resume_policy =
        resumePolicy;
    }

    const updatedProgress =
      await requireData(
        serviceClient
          .from("free_activity_progress")
          .update(progressPatch)
          .eq("owner_user_id", userId)
          .eq(
            "activity_pass_id",
            activityPassId
          )
          .select("*")
          .single(),
        "living_room_progress_update_failed",
        "无法保存客厅活动预算和进度"
      );

    const updatedPass =
      Object.keys(passPatch).length
        ? await requireData(
            serviceClient
              .from("activity_passes")
              .update(passPatch)
              .eq("owner_user_id", userId)
              .eq("id", activityPassId)
              .select("*")
              .single(),
            "living_room_pass_update_failed",
            "无法保存活动通行证参数"
          )
        : pass;

    return {
      pass: updatedPass,
      progress: updatedProgress,
      remaining:
        calculateFreeActivityRemaining({
          activeSecondsBudget:
            updatedProgress
              .active_seconds_budget,
          activeSecondsUsed:
            updatedProgress
              .active_seconds_used,
          lastResumedAt:
            updatedProgress
              .last_resumed_at,
          state:
            updatedProgress.state,
          now: currentTime
        })
    };
  }


  async function getLivingRoomStatus({
    userId
  }) {
    const snapshot =
      await orchestrationService
        .getRuntimeSnapshot({
          userId,
          quietHoursActive: false,
          autoHeartbeatEnabled: false
        });

    const recentEvents = await requireData(
      serviceClient
        .from("home_events")
        .select([
          "id",
          "event_type",
          "room",
          "title",
          "detail",
          "occurred_at",
          "activity_pass_id"
        ].join(", "))
        .eq("owner_user_id", userId)
        .or(
          "room.eq.living_room,activity_pass_id.not.is.null"
        )
        .order("occurred_at", {
          ascending: false
        })
        .limit(20),
      "living_room_events_read_failed",
      "无法读取客厅活动时间线"
    );

    let modelCallCount = 0;

    if (snapshot.activityPass?.id) {
      const runs = await requireData(
        serviceClient
          .from("activity_runs")
          .select("id")
          .eq("owner_user_id", userId)
          .eq(
            "activity_pass_id",
            snapshot.activityPass.id
          )
          .limit(1000),
        "living_room_runs_read_failed",
        "无法读取本次活动调用次数"
      );

      modelCallCount =
        runs?.length ?? 0;
    }

    return {
      ...snapshot,
      recentEvents:
        recentEvents ?? [],
      usage: {
        modelCallCount,
        inputTokens:
          snapshot.freeActivityProgress
            ?.input_tokens_used ?? 0,
        outputTokens:
          snapshot.freeActivityProgress
            ?.output_tokens_used ?? 0,
        estimatedCostUsd: Number(
          snapshot.freeActivityProgress
            ?.estimated_cost_usd ?? 0
        )
      },
      canIssuePass:
        !snapshot.activityPass
    };
  }


  return {
    getLivingRoomStatus,
    grantFreeActivity,
    updateFreeActivity
  };
}
