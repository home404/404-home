const DEFAULT_SETTINGS = Object.freeze({
  interactionLeaseSeconds: 300,
  heartbeatInputTokenBudget: 8000,
  heartbeatMaxOutputTokens: 24000,
  heartbeatReasoningEffort: "medium",
  automaticHeartbeatReleaseEnabled: false,
  autoResumeFreeActivityAfterChat: true
});

const INTERACTION_CHANNELS = new Set([
  "official_chat",
  "bedroom_chat",
  "interactive_game",
  "interactive_tool"
]);

const FREE_ACTIVITY_STATES = new Set([
  "running",
  "paused_by_chat",
  "paused_by_time",
  "paused_by_budget",
  "paused_manual",
  "handed_to_interactive",
  "completed",
  "cancelled"
]);


export class HomeOrchestrationError extends Error {
  constructor(
    code,
    message,
    status = 400,
    details = null
  ) {
    super(message);
    this.name = "HomeOrchestrationError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}


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


function normalizeText(
  value,
  maximum = 1000
) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, maximum);
}


function normalizeDate(
  value,
  fallback = new Date()
) {
  const date = value instanceof Date
    ? value
    : new Date(value ?? fallback);

  if (Number.isNaN(date.getTime())) {
    throw new HomeOrchestrationError(
      "invalid_orchestration_time",
      "全屋调度器收到无效时间",
      400
    );
  }

  return date;
}


function addSeconds(date, seconds) {
  return new Date(
    date.getTime() + seconds * 1000
  );
}


function addMinutes(date, minutes) {
  return addSeconds(
    date,
    minutes * 60
  );
}


function normalizeInteractionChannel(value) {
  const channel = normalizeText(value, 60);

  if (!INTERACTION_CHANNELS.has(channel)) {
    throw new HomeOrchestrationError(
      "invalid_interaction_channel",
      "不认识这个互动入口",
      400,
      { channel }
    );
  }

  return channel;
}


function normalizeResumePolicy(value) {
  const policy = normalizeText(
    value || "after_chat",
    40
  );

  if (![
    "after_chat",
    "interactive_handoff",
    "manual"
  ].includes(policy)) {
    throw new HomeOrchestrationError(
      "invalid_resume_policy",
      "不认识这个自由活动续接方式",
      400,
      { resumePolicy: policy }
    );
  }

  return policy;
}


function normalizeSettings(row = {}) {
  return {
    interactionLeaseSeconds:
      clampInteger(
        row.interaction_lease_seconds ??
          row.interactionLeaseSeconds,
        60,
        7200,
        DEFAULT_SETTINGS
          .interactionLeaseSeconds
      ),
    heartbeatInputTokenBudget:
      clampInteger(
        row.heartbeat_input_token_budget ??
          row.heartbeatInputTokenBudget,
        1000,
        100000,
        DEFAULT_SETTINGS
          .heartbeatInputTokenBudget
      ),
    heartbeatMaxOutputTokens:
      clampInteger(
        row.heartbeat_max_output_tokens ??
          row.heartbeatMaxOutputTokens,
        1000,
        128000,
        DEFAULT_SETTINGS
          .heartbeatMaxOutputTokens
      ),
    heartbeatReasoningEffort:
      [
        "none",
        "low",
        "medium",
        "high",
        "xhigh"
      ].includes(
        row.heartbeat_reasoning_effort ??
          row.heartbeatReasoningEffort
      )
        ? (
            row.heartbeat_reasoning_effort ??
            row.heartbeatReasoningEffort
          )
        : DEFAULT_SETTINGS
            .heartbeatReasoningEffort,
    automaticHeartbeatReleaseEnabled:
      row.automatic_heartbeat_release_enabled ??
      row.automaticHeartbeatReleaseEnabled ??
      DEFAULT_SETTINGS
        .automaticHeartbeatReleaseEnabled,
    autoResumeFreeActivityAfterChat:
      row.auto_resume_free_activity_after_chat ??
      row.autoResumeFreeActivityAfterChat ??
      DEFAULT_SETTINGS
        .autoResumeFreeActivityAfterChat
  };
}


export function calculateActiveSecondsUsed({
  activeSecondsUsed = 0,
  lastResumedAt = null,
  state,
  now = new Date(),
  activeSecondsBudget = Number.MAX_SAFE_INTEGER
}) {
  const stored = Math.max(
    0,
    Math.round(Number(activeSecondsUsed) || 0)
  );

  if (
    state !== "running" ||
    !lastResumedAt
  ) {
    return Math.min(
      stored,
      activeSecondsBudget
    );
  }

  const resumedAt = normalizeDate(lastResumedAt);
  const currentTime = normalizeDate(now);
  const elapsed = Math.max(
    0,
    Math.floor(
      (
        currentTime.getTime() -
        resumedAt.getTime()
      ) / 1000
    )
  );

  return Math.min(
    activeSecondsBudget,
    stored + elapsed
  );
}


export function calculateFreeActivityRemaining({
  activeSecondsBudget,
  activeSecondsUsed,
  lastResumedAt = null,
  state,
  now = new Date()
}) {
  const budget = Math.max(
    0,
    Math.round(
      Number(activeSecondsBudget) || 0
    )
  );

  const used = calculateActiveSecondsUsed({
    activeSecondsUsed,
    lastResumedAt,
    state,
    now,
    activeSecondsBudget: budget
  });

  return {
    activeSecondsBudget: budget,
    activeSecondsUsed: used,
    remainingSeconds:
      Math.max(0, budget - used),
    exhausted: used >= budget
  };
}


export function resolveHomeMode({
  activeInteraction = null,
  freeActivity = null,
  quietHoursActive = false,
  automaticHeartbeatReleaseEnabled = false,
  autoHeartbeatEnabled = false
}) {
  if (activeInteraction) {
    return {
      mode: "interactive_awake",
      reason:
        activeInteraction.channel ??
        "active_interaction",
      mayCallAutomaticModel: false
    };
  }

  if (
    freeActivity &&
    freeActivity.state === "running"
  ) {
    return {
      mode: "free_activity_running",
      reason: "active_free_activity_pass",
      mayCallAutomaticModel: false
    };
  }

  if (
    freeActivity &&
    [
      "paused_by_chat",
      "paused_by_time",
      "paused_by_budget",
      "paused_manual",
      "handed_to_interactive"
    ].includes(freeActivity.state)
  ) {
    return {
      mode: "free_activity_paused",
      reason: freeActivity.state,
      mayCallAutomaticModel: false
    };
  }

  if (quietHoursActive) {
    return {
      mode: "resting",
      reason: "quiet_hours",
      mayCallAutomaticModel: false
    };
  }

  const mayCallAutomaticModel = Boolean(
    automaticHeartbeatReleaseEnabled &&
    autoHeartbeatEnabled
  );

  return {
    mode: mayCallAutomaticModel
      ? "auto_wake_eligible"
      : "resting",
    reason: mayCallAutomaticModel
      ? "automatic_heartbeat_last_resort"
      : "automatic_heartbeat_locked",
    mayCallAutomaticModel
  };
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


export function createHomeOrchestrationService({
  serviceClient
}) {
  if (!serviceClient) {
    throw new Error(
      "创建 homeOrchestrationService 时缺少 serviceClient"
    );
  }


  async function getSettings({
    userId
  }) {
    const existing = await requireData(
      serviceClient
        .from("home_runtime_settings")
        .select("*")
        .eq("owner_user_id", userId)
        .maybeSingle(),
      "home_runtime_settings_read_failed",
      "无法读取八百库运行参数"
    );

    if (existing) {
      return {
        row: existing,
        settings:
          normalizeSettings(existing)
      };
    }

    const created = await requireData(
      serviceClient
        .from("home_runtime_settings")
        .insert({
          owner_user_id: userId,
          interaction_lease_seconds:
            DEFAULT_SETTINGS
              .interactionLeaseSeconds,
          heartbeat_input_token_budget:
            DEFAULT_SETTINGS
              .heartbeatInputTokenBudget,
          heartbeat_max_output_tokens:
            DEFAULT_SETTINGS
              .heartbeatMaxOutputTokens,
          heartbeat_reasoning_effort:
            DEFAULT_SETTINGS
              .heartbeatReasoningEffort,
          automatic_heartbeat_release_enabled:
            false,
          auto_resume_free_activity_after_chat:
            true
        })
        .select("*")
        .single(),
      "home_runtime_settings_create_failed",
      "无法建立八百库运行参数"
    );

    return {
      row: created,
      settings:
        normalizeSettings(created)
    };
  }


  async function updateSettings({
    userId,
    patch
  }) {
    const current = await getSettings({
      userId
    });

    const next = normalizeSettings({
      ...current.row,
      ...patch
    });

    const updated = await requireData(
      serviceClient
        .from("home_runtime_settings")
        .update({
          interaction_lease_seconds:
            next.interactionLeaseSeconds,
          heartbeat_input_token_budget:
            next.heartbeatInputTokenBudget,
          heartbeat_max_output_tokens:
            next.heartbeatMaxOutputTokens,
          heartbeat_reasoning_effort:
            next.heartbeatReasoningEffort,
          automatic_heartbeat_release_enabled:
            next.automaticHeartbeatReleaseEnabled,
          auto_resume_free_activity_after_chat:
            next.autoResumeFreeActivityAfterChat
        })
        .eq("owner_user_id", userId)
        .select("*")
        .single(),
      "home_runtime_settings_update_failed",
      "无法保存八百库运行参数"
    );

    return {
      row: updated,
      settings:
        normalizeSettings(updated)
    };
  }


  async function expireStaleInteractions({
    userId,
    now = new Date()
  }) {
    const currentTime = normalizeDate(now);

    return requireData(
      serviceClient
        .from("home_interaction_sessions")
        .update({
          status: "expired",
          ended_at:
            currentTime.toISOString()
        })
        .eq("owner_user_id", userId)
        .eq("status", "active")
        .lte(
          "expires_at",
          currentTime.toISOString()
        )
        .select("id, channel, expires_at"),
      "stale_interactions_expire_failed",
      "无法清理已经过期的互动登记"
    );
  }


  async function getActiveInteraction({
    userId,
    now = new Date()
  }) {
    const currentTime = normalizeDate(now);

    await expireStaleInteractions({
      userId,
      now: currentTime
    });

    return requireData(
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
      "active_interaction_read_failed",
      "无法读取当前互动状态"
    );
  }


  async function getCurrentActivityPass({
    userId,
    now = new Date()
  }) {
    const currentTime = normalizeDate(now);

    return requireData(
      serviceClient
        .from("activity_passes")
        .select("*")
        .eq("owner_user_id", userId)
        .in("status", [
          "scheduled",
          "active"
        ])
        .lte(
          "starts_at",
          currentTime.toISOString()
        )
        .order("starts_at", {
          ascending: false
        })
        .limit(1)
        .maybeSingle(),
      "current_activity_pass_read_failed",
      "无法读取客厅活动通行证"
    );
  }


  async function getActivityProgress({
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
      "free_activity_progress_read_failed",
      "无法读取自由活动进度"
    );
  }


  async function ensureActivityProgress({
    userId,
    pass,
    now = new Date(),
    resumePolicy = "after_chat",
    inputTokenBudget = null,
    outputTokenBudget = null,
    maxCostUsd = null,
    currentTask = null
  }) {
    if (!pass?.id) {
      throw new HomeOrchestrationError(
        "missing_activity_pass",
        "缺少客厅活动通行证",
        400
      );
    }

    const existing = await getActivityProgress({
      userId,
      activityPassId: pass.id
    });

    if (existing) {
      return existing;
    }

    const startsAt = normalizeDate(
      pass.starts_at,
      now
    );
    const endsAt = normalizeDate(
      pass.ends_at,
      addMinutes(startsAt, 180)
    );
    const activeSecondsBudget = Math.max(
      60,
      Math.floor(
        (
          endsAt.getTime() -
          startsAt.getTime()
        ) / 1000
      )
    );

    return requireData(
      serviceClient
        .from("free_activity_progress")
        .insert({
          activity_pass_id: pass.id,
          owner_user_id: userId,
          state: "running",
          active_seconds_budget:
            activeSecondsBudget,
          active_seconds_used: 0,
          last_resumed_at:
            normalizeDate(now).toISOString(),
          resume_policy:
            normalizeResumePolicy(
              resumePolicy
            ),
          current_task:
            normalizeText(currentTask, 1000) ||
            normalizeText(pass.note, 1000) ||
            null,
          input_token_budget:
            inputTokenBudget == null
              ? null
              : clampInteger(
                  inputTokenBudget,
                  0,
                  10000000,
                  0
                ),
          output_token_budget:
            outputTokenBudget == null
              ? null
              : clampInteger(
                  outputTokenBudget,
                  0,
                  10000000,
                  0
                ),
          max_cost_usd:
            maxCostUsd ??
            pass.max_cost_usd ??
            null,
          metadata: {
            createdBy:
              "home-orchestration-v0.1"
          }
        })
        .select("*")
        .single(),
      "free_activity_progress_create_failed",
      "无法建立自由活动进度"
    );
  }


  async function pauseFreeActivity({
    userId,
    reason = "chat_started",
    state = "paused_by_chat",
    resumePolicy = null,
    now = new Date()
  }) {
    if (!FREE_ACTIVITY_STATES.has(state)) {
      throw new HomeOrchestrationError(
        "invalid_free_activity_state",
        "不认识这个自由活动状态",
        400,
        { state }
      );
    }

    const currentTime = normalizeDate(now);
    const pass = await getCurrentActivityPass({
      userId,
      now: currentTime
    });

    if (!pass) {
      return {
        pass: null,
        progress: null
      };
    }

    const progress =
      await ensureActivityProgress({
        userId,
        pass,
        now: currentTime
      });

    const usage = calculateFreeActivityRemaining({
      activeSecondsBudget:
        progress.active_seconds_budget,
      activeSecondsUsed:
        progress.active_seconds_used,
      lastResumedAt:
        progress.last_resumed_at,
      state: progress.state,
      now: currentTime
    });

    const nextState = usage.exhausted
      ? "paused_by_time"
      : state;

    const updated = await requireData(
      serviceClient
        .from("free_activity_progress")
        .update({
          state: nextState,
          active_seconds_used:
            usage.activeSecondsUsed,
          last_resumed_at: null,
          paused_at:
            currentTime.toISOString(),
          pause_reason:
            normalizeText(reason, 500) || null,
          resume_policy:
            resumePolicy
              ? normalizeResumePolicy(
                  resumePolicy
                )
              : progress.resume_policy
        })
        .eq("owner_user_id", userId)
        .eq(
          "activity_pass_id",
          pass.id
        )
        .select("*")
        .single(),
      "free_activity_pause_failed",
      "无法暂停自由活动"
    );

    return {
      pass,
      progress: updated,
      remaining:
        calculateFreeActivityRemaining({
          activeSecondsBudget:
            updated.active_seconds_budget,
          activeSecondsUsed:
            updated.active_seconds_used,
          state: updated.state,
          now: currentTime
        })
    };
  }


  async function resumeFreeActivity({
    userId,
    activityPassId = null,
    now = new Date()
  }) {
    const currentTime = normalizeDate(now);
    const pass = activityPassId
      ? await requireData(
          serviceClient
            .from("activity_passes")
            .select("*")
            .eq("owner_user_id", userId)
            .eq("id", activityPassId)
            .single(),
          "activity_pass_resume_read_failed",
          "无法读取要续接的活动通行证"
        )
      : await getCurrentActivityPass({
          userId,
          now: currentTime
        });

    if (!pass) {
      throw new HomeOrchestrationError(
        "no_free_activity_to_resume",
        "没有可以续接的自由活动",
        404
      );
    }

    const progress =
      await ensureActivityProgress({
        userId,
        pass,
        now: currentTime
      });

    const remaining =
      calculateFreeActivityRemaining({
        activeSecondsBudget:
          progress.active_seconds_budget,
        activeSecondsUsed:
          progress.active_seconds_used,
        lastResumedAt:
          progress.last_resumed_at,
        state: progress.state,
        now: currentTime
      });

    if (remaining.exhausted) {
      const stopped = await requireData(
        serviceClient
          .from("free_activity_progress")
          .update({
            state: "paused_by_time",
            active_seconds_used:
              remaining.activeSecondsUsed,
            last_resumed_at: null,
            paused_at:
              currentTime.toISOString(),
            pause_reason:
              "active_time_budget_exhausted"
          })
          .eq("owner_user_id", userId)
          .eq(
            "activity_pass_id",
            pass.id
          )
          .select("*")
          .single(),
        "free_activity_time_stop_failed",
        "无法保存已耗尽的活动时间"
      );

      return {
        pass,
        progress: stopped,
        remaining
      };
    }

    const updated = await requireData(
      serviceClient
        .from("free_activity_progress")
        .update({
          state: "running",
          last_resumed_at:
            currentTime.toISOString(),
          paused_at: null,
          pause_reason: null
        })
        .eq("owner_user_id", userId)
        .eq(
          "activity_pass_id",
          pass.id
        )
        .select("*")
        .single(),
      "free_activity_resume_failed",
      "无法续接自由活动"
    );

    return {
      pass,
      progress: updated,
      remaining:
        calculateFreeActivityRemaining({
          activeSecondsBudget:
            updated.active_seconds_budget,
          activeSecondsUsed:
            updated.active_seconds_used,
          lastResumedAt:
            updated.last_resumed_at,
          state: updated.state,
          now: currentTime
        })
    };
  }


  async function startInteraction({
    userId,
    channel,
    source = "shortcut",
    leaseSeconds = null,
    contextSummary = null,
    metadata = {},
    now = new Date()
  }) {
    const currentTime = normalizeDate(now);
    const resolvedChannel =
      normalizeInteractionChannel(channel);
    const settingsResult =
      await getSettings({ userId });
    const resolvedLeaseSeconds =
      leaseSeconds == null
        ? settingsResult.settings
            .interactionLeaseSeconds
        : clampInteger(
            leaseSeconds,
            60,
            7200,
            settingsResult.settings
              .interactionLeaseSeconds
          );
    const expiresAt = addSeconds(
      currentTime,
      resolvedLeaseSeconds
    );

    await expireStaleInteractions({
      userId,
      now: currentTime
    });

    const existing = await requireData(
      serviceClient
        .from("home_interaction_sessions")
        .select("*")
        .eq("owner_user_id", userId)
        .eq("channel", resolvedChannel)
        .eq("status", "active")
        .maybeSingle(),
      "interaction_session_read_failed",
      "无法读取当前连接桥状态"
    );

    const payload = {
      source:
        normalizeText(source, 100) ||
        "shortcut",
      last_seen_at:
        currentTime.toISOString(),
      expires_at:
        expiresAt.toISOString(),
      ended_at: null,
      metadata: {
        ...(existing?.metadata ?? {}),
        ...metadata,
        contextSummary:
          normalizeText(
            contextSummary,
            2000
          ) || null,
        bridgeVersion:
          "interaction-v0.1"
      }
    };

    const session = existing
      ? await requireData(
          serviceClient
            .from("home_interaction_sessions")
            .update(payload)
            .eq("id", existing.id)
            .eq("owner_user_id", userId)
            .select("*")
            .single(),
          "interaction_session_refresh_failed",
          "无法刷新连接桥清醒状态"
        )
      : await requireData(
          serviceClient
            .from("home_interaction_sessions")
            .insert({
              owner_user_id: userId,
              channel: resolvedChannel,
              status: "active",
              started_at:
                currentTime.toISOString(),
              ...payload
            })
            .select("*")
            .single(),
          "interaction_session_create_failed",
          "无法登记连接桥清醒状态"
        );

    const pausedActivity =
      await pauseFreeActivity({
        userId,
        reason:
          `${resolvedChannel}_started`,
        state: "paused_by_chat",
        now: currentTime
      });

    const presence = await requireData(
      serviceClient
        .from("home_presence")
        .upsert(
          {
            owner_user_id: userId,
            status: "awake",
            status_detail:
              resolvedChannel ===
                "official_chat"
                ? "G 正在官端陪谢诗"
                : resolvedChannel ===
                    "bedroom_chat"
                  ? "G 正在卧室陪谢诗"
                  : "G 正在和谢诗一起活动",
            source:
              normalizeText(source, 100) ||
              "shortcut",
            last_user_seen_at:
              currentTime.toISOString(),
            heartbeat_paused_until:
              expiresAt.toISOString(),
            metadata: {
              mode: "interactive_awake",
              interactionSessionId:
                session.id,
              interactionChannel:
                resolvedChannel
            }
          },
          {
            onConflict:
              "owner_user_id"
          }
        )
        .select("*")
        .single(),
      "interactive_presence_update_failed",
      "无法更新官端或卧室互动状态"
    );

    return {
      session,
      presence,
      pausedActivity,
      modelCalled: false
    };
  }


  async function endInteraction({
    userId,
    channel = null,
    source = "shortcut",
    postChatGraceMinutes = 15,
    resumeFreeActivity = null,
    now = new Date()
  }) {
    const currentTime = normalizeDate(now);
    const settingsResult =
      await getSettings({ userId });
    const resolvedChannel = channel
      ? normalizeInteractionChannel(channel)
      : null;

    let request = serviceClient
      .from("home_interaction_sessions")
      .update({
        status: "ended",
        ended_at:
          currentTime.toISOString(),
        last_seen_at:
          currentTime.toISOString()
      })
      .eq("owner_user_id", userId)
      .eq("status", "active");

    if (resolvedChannel) {
      request = request.eq(
        "channel",
        resolvedChannel
      );
    }

    const endedSessions = await requireData(
      request.select("*"),
      "interaction_session_end_failed",
      "无法结束连接桥清醒状态"
    );

    const shouldResume =
      resumeFreeActivity == null
        ? settingsResult.settings
            .autoResumeFreeActivityAfterChat
        : Boolean(resumeFreeActivity);

    let resumedActivity = null;

    if (shouldResume) {
      const pass = await getCurrentActivityPass({
        userId,
        now: currentTime
      });

      if (pass) {
        const progress =
          await getActivityProgress({
            userId,
            activityPassId: pass.id
          });

        if (
          progress?.state ===
            "paused_by_chat" &&
          progress.resume_policy ===
            "after_chat"
        ) {
          resumedActivity =
            await resumeFreeActivity({
              userId,
              activityPassId: pass.id,
              now: currentTime
            });
        }
      }
    }

    const graceUntil = addMinutes(
      currentTime,
      clampInteger(
        postChatGraceMinutes,
        0,
        120,
        15
      )
    );

    const presence = await requireData(
      serviceClient
        .from("home_presence")
        .update({
          status:
            resumedActivity?.progress
              ?.state === "running"
              ? "free_activity"
              : "resting",
          status_detail:
            resumedActivity?.progress
              ?.state === "running"
              ? "G 回到客厅继续自由活动"
              : "G 在卧室休息",
          source:
            normalizeText(source, 100) ||
            "shortcut",
          current_activity_pass_id:
            resumedActivity?.pass?.id ?? null,
          free_activity_until:
            resumedActivity?.pass?.ends_at ?? null,
          heartbeat_paused_until:
            resumedActivity?.progress
              ?.state === "running"
              ? null
              : graceUntil.toISOString(),
          metadata: {
            mode:
              resumedActivity?.progress
                ?.state === "running"
                ? "free_activity_running"
                : "post_chat_grace",
            interactionEndedAt:
              currentTime.toISOString(),
            endedBy: source
          }
        })
        .eq("owner_user_id", userId)
        .select("*")
        .single(),
      "interaction_end_presence_failed",
      "无法更新互动结束后的全屋状态"
    );

    return {
      endedSessions:
        endedSessions ?? [],
      resumedActivity,
      graceUntil:
        resumedActivity?.progress
          ?.state === "running"
          ? null
          : graceUntil.toISOString(),
      presence,
      modelCalled: false
    };
  }


  async function recordActivityUsage({
    userId,
    activityPassId,
    inputTokens = 0,
    outputTokens = 0,
    estimatedCostUsd = 0,
    currentTask = undefined,
    progressSummary = undefined,
    progressData = undefined,
    now = new Date()
  }) {
    const progress = await getActivityProgress({
      userId,
      activityPassId
    });

    if (!progress) {
      throw new HomeOrchestrationError(
        "free_activity_progress_missing",
        "这张活动通行证还没有进度记录",
        404
      );
    }

    const currentTime = normalizeDate(now);
    const usage = calculateFreeActivityRemaining({
      activeSecondsBudget:
        progress.active_seconds_budget,
      activeSecondsUsed:
        progress.active_seconds_used,
      lastResumedAt:
        progress.last_resumed_at,
      state: progress.state,
      now: currentTime
    });

    const nextInputTokens =
      progress.input_tokens_used +
      Math.max(0, Math.round(Number(inputTokens) || 0));
    const nextOutputTokens =
      progress.output_tokens_used +
      Math.max(0, Math.round(Number(outputTokens) || 0));
    const nextCost = Number((
      Number(progress.estimated_cost_usd || 0) +
      Math.max(0, Number(estimatedCostUsd) || 0)
    ).toFixed(6));

    const inputBudgetReached =
      progress.input_token_budget != null &&
      nextInputTokens >=
        progress.input_token_budget;
    const outputBudgetReached =
      progress.output_token_budget != null &&
      nextOutputTokens >=
        progress.output_token_budget;
    const costBudgetReached =
      progress.max_cost_usd != null &&
      nextCost >= Number(progress.max_cost_usd);

    const budgetReached =
      inputBudgetReached ||
      outputBudgetReached ||
      costBudgetReached;
    const timeReached = usage.exhausted;

    const nextState = timeReached
      ? "paused_by_time"
      : budgetReached
        ? "paused_by_budget"
        : progress.state;

    const patch = {
      state: nextState,
      active_seconds_used:
        usage.activeSecondsUsed,
      input_tokens_used:
        nextInputTokens,
      output_tokens_used:
        nextOutputTokens,
      estimated_cost_usd:
        nextCost,
      last_resumed_at:
        nextState === "running"
          ? progress.last_resumed_at
          : null,
      paused_at:
        nextState === "running"
          ? progress.paused_at
          : currentTime.toISOString(),
      pause_reason: timeReached
        ? "active_time_budget_exhausted"
        : budgetReached
          ? "token_or_cost_budget_exhausted"
          : progress.pause_reason
    };

    if (currentTask !== undefined) {
      patch.current_task =
        normalizeText(currentTask, 2000) ||
        null;
    }

    if (progressSummary !== undefined) {
      patch.progress_summary =
        normalizeText(
          progressSummary,
          10000
        ) || null;
    }

    if (progressData !== undefined) {
      patch.progress_data = {
        ...(progress.progress_data ?? {}),
        ...(progressData ?? {})
      };
    }

    const updated = await requireData(
      serviceClient
        .from("free_activity_progress")
        .update(patch)
        .eq("owner_user_id", userId)
        .eq(
          "activity_pass_id",
          activityPassId
        )
        .select("*")
        .single(),
      "free_activity_usage_update_failed",
      "无法保存自由活动用量和进度"
    );

    return {
      progress: updated,
      remaining:
        calculateFreeActivityRemaining({
          activeSecondsBudget:
            updated.active_seconds_budget,
          activeSecondsUsed:
            updated.active_seconds_used,
          lastResumedAt:
            updated.last_resumed_at,
          state: updated.state,
          now: currentTime
        }),
      budgetReached: {
        input: inputBudgetReached,
        output: outputBudgetReached,
        cost: costBudgetReached
      }
    };
  }


  async function getRuntimeSnapshot({
    userId,
    quietHoursActive = false,
    autoHeartbeatEnabled = false,
    now = new Date()
  }) {
    const currentTime = normalizeDate(now);
    const [
      settingsResult,
      activeInteraction,
      pass
    ] = await Promise.all([
      getSettings({ userId }),
      getActiveInteraction({
        userId,
        now: currentTime
      }),
      getCurrentActivityPass({
        userId,
        now: currentTime
      })
    ]);

    const progress = pass
      ? await getActivityProgress({
          userId,
          activityPassId: pass.id
        })
      : null;

    const remaining = progress
      ? calculateFreeActivityRemaining({
          activeSecondsBudget:
            progress.active_seconds_budget,
          activeSecondsUsed:
            progress.active_seconds_used,
          lastResumedAt:
            progress.last_resumed_at,
          state: progress.state,
          now: currentTime
        })
      : null;

    const resolved = resolveHomeMode({
      activeInteraction,
      freeActivity: progress,
      quietHoursActive,
      automaticHeartbeatReleaseEnabled:
        settingsResult.settings
          .automaticHeartbeatReleaseEnabled,
      autoHeartbeatEnabled
    });

    return {
      now:
        currentTime.toISOString(),
      settings:
        settingsResult.settings,
      activeInteraction,
      activityPass: pass,
      freeActivityProgress: progress,
      freeActivityRemaining: remaining,
      resolved
    };
  }


  return {
    getSettings,
    updateSettings,
    expireStaleInteractions,
    getActiveInteraction,
    getCurrentActivityPass,
    getActivityProgress,
    ensureActivityProgress,
    pauseFreeActivity,
    resumeFreeActivity,
    startInteraction,
    endInteraction,
    recordActivityUsage,
    getRuntimeSnapshot
  };
}
