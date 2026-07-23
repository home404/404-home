const SHANGHAI_TIME_ZONE =
  "Asia/Shanghai";

const POLICY_DEFAULTS = Object.freeze({
  naturalWakeEnabled: true,
  naturalWakeMinPerDay: 3,
  naturalWakeMaxPerDay: 6,
  minModelWakeIntervalMinutes: 120,
  dailyModelCallLimit: 6,
  dailyCostLimitUsd: 0.20,
  intervalMinMinutes: 30,
  intervalMaxMinutes: 50,
  timezone: SHANGHAI_TIME_ZONE
});

const COUNTED_RUN_STATUSES = [
  "running",
  "completed",
  "silent",
  "failed"
];


export class HeartPolicyError extends Error {
  constructor(
    code,
    message,
    status = 500,
    details = null
  ) {
    super(message);

    this.name = "HeartPolicyError";
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
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(
    maximum,
    Math.max(
      minimum,
      Math.round(number)
    )
  );
}


function clampNumber(
  value,
  minimum,
  maximum,
  fallback
) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.min(
    maximum,
    Math.max(minimum, number)
  );
}


function randomMinutes(
  minimum,
  maximum
) {
  const min = Math.ceil(minimum);
  const max = Math.floor(maximum);

  return Math.floor(
    Math.random() *
      (max - min + 1)
  ) + min;
}


function addMinutes(date, minutes) {
  return new Date(
    date.getTime() +
      minutes * 60_000
  );
}


function getZonedParts(
  date,
  timeZone
) {
  const parts = new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }
  ).formatToParts(date);

  const values = {};

  for (const part of parts) {
    if (part.type !== "literal") {
      values[part.type] =
        Number(part.value);
    }
  }

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second
  };
}


function addCalendarDays(
  dateParts,
  days
) {
  const date = new Date(
    Date.UTC(
      dateParts.year,
      dateParts.month - 1,
      dateParts.day + days
    )
  );

  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate()
  };
}


function zonedDateTimeToDate({
  year,
  month,
  day,
  hour,
  minute,
  timeZone
}) {
  const targetAsUtc = Date.UTC(
    year,
    month - 1,
    day,
    hour,
    minute,
    0,
    0
  );

  let resolved = new Date(targetAsUtc);

  for (
    let index = 0;
    index < 5;
    index += 1
  ) {
    const represented = getZonedParts(
      resolved,
      timeZone
    );

    const representedAsUtc = Date.UTC(
      represented.year,
      represented.month - 1,
      represented.day,
      represented.hour,
      represented.minute,
      represented.second,
      0
    );

    const difference =
      targetAsUtc - representedAsUtc;

    if (Math.abs(difference) < 1000) {
      break;
    }

    resolved = new Date(
      resolved.getTime() + difference
    );
  }

  return resolved;
}


function getLocalDayBounds(
  date,
  timeZone
) {
  const parts = getZonedParts(
    date,
    timeZone
  );

  const nextDay = addCalendarDays(
    parts,
    1
  );

  const start = zonedDateTimeToDate({
    ...parts,
    hour: 0,
    minute: 0,
    timeZone
  });

  const end = zonedDateTimeToDate({
    ...nextDay,
    hour: 0,
    minute: 0,
    timeZone
  });

  const dateKey = [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0")
  ].join("-");

  return {
    start,
    end,
    dateKey
  };
}


function hashText(value) {
  let hash = 2166136261;

  for (
    let index = 0;
    index < value.length;
    index += 1
  ) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(
      hash,
      16777619
    );
  }

  return hash >>> 0;
}


export function selectDailyNaturalTarget({
  userId,
  dateKey,
  minimum,
  maximum
}) {
  const min = Math.min(
    minimum,
    maximum
  );
  const max = Math.max(
    minimum,
    maximum
  );

  if (min === max) {
    return min;
  }

  const width = max - min + 1;
  const hash = hashText(
    `${userId}:${dateKey}`
  );

  return min + hash % width;
}


export function calculateNaturalWakeChance({
  remainingTarget,
  minutesRemaining,
  averageInspectionMinutes
}) {
  if (remainingTarget <= 0) {
    return 0;
  }

  const inspectionsRemaining =
    Math.max(
      1,
      Math.ceil(
        minutesRemaining /
          Math.max(
            1,
            averageInspectionMinutes
          )
      )
    );

  return Math.min(
    1,
    remainingTarget /
      inspectionsRemaining
  );
}


function normalizePreferences(row = {}) {
  const intervalMinMinutes =
    clampInteger(
      row.interval_min_minutes,
      15,
      720,
      POLICY_DEFAULTS
        .intervalMinMinutes
    );

  const intervalMaxMinutes =
    clampInteger(
      row.interval_max_minutes,
      15,
      720,
      POLICY_DEFAULTS
        .intervalMaxMinutes
    );

  const naturalWakeMinPerDay =
    clampInteger(
      row.natural_wake_min_per_day,
      0,
      24,
      POLICY_DEFAULTS
        .naturalWakeMinPerDay
    );

  const naturalWakeMaxPerDay =
    clampInteger(
      row.natural_wake_max_per_day,
      0,
      24,
      POLICY_DEFAULTS
        .naturalWakeMaxPerDay
    );

  return {
    naturalWakeEnabled:
      row.natural_wake_enabled ??
      POLICY_DEFAULTS
        .naturalWakeEnabled,
    naturalWakeMinPerDay:
      Math.min(
        naturalWakeMinPerDay,
        naturalWakeMaxPerDay
      ),
    naturalWakeMaxPerDay:
      Math.max(
        naturalWakeMinPerDay,
        naturalWakeMaxPerDay
      ),
    minModelWakeIntervalMinutes:
      clampInteger(
        row.min_model_wake_interval_minutes,
        15,
        1440,
        POLICY_DEFAULTS
          .minModelWakeIntervalMinutes
      ),
    dailyModelCallLimit:
      clampInteger(
        row.daily_model_call_limit,
        0,
        100,
        POLICY_DEFAULTS
          .dailyModelCallLimit
      ),
    dailyCostLimitUsd:
      clampNumber(
        row.daily_cost_limit_usd,
        0,
        100,
        POLICY_DEFAULTS
          .dailyCostLimitUsd
      ),
    intervalMinMinutes:
      Math.min(
        intervalMinMinutes,
        intervalMaxMinutes
      ),
    intervalMaxMinutes:
      Math.max(
        intervalMinMinutes,
        intervalMaxMinutes
      ),
    timezone:
      String(
        row.timezone ??
        POLICY_DEFAULTS.timezone
      ).trim() ||
      POLICY_DEFAULTS.timezone
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
    throw new HeartPolicyError(
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


export function createHeartPolicyService({
  serviceClient
}) {
  if (!serviceClient) {
    throw new Error(
      "创建 heartPolicyService 时缺少 serviceClient"
    );
  }


  async function getPolicyPreferences({
    userId
  }) {
    const row = await requireData(
      serviceClient
        .from("heartbeat_preferences")
        .select("*")
        .eq("owner_user_id", userId)
        .maybeSingle(),
      "heart_policy_preferences_read_failed",
      "无法读取小心脏模型唤醒策略"
    );

    return normalizePreferences(
      row ?? {}
    );
  }


  async function getDailyUsage({
    userId,
    now,
    preferences
  }) {
    const day = getLocalDayBounds(
      now,
      preferences.timezone
    );

    const rows = await requireData(
      serviceClient
        .from("activity_runs")
        .select([
          "id",
          "status",
          "run_mode",
          "trigger_source",
          "estimated_cost_usd",
          "started_at"
        ].join(", "))
        .eq("owner_user_id", userId)
        .eq("run_mode", "heartbeat")
        .eq("trigger_source", "worker")
        .in(
          "status",
          COUNTED_RUN_STATUSES
        )
        .gte(
          "started_at",
          day.start.toISOString()
        )
        .lt(
          "started_at",
          day.end.toISOString()
        )
        .order("started_at", {
          ascending: false
        }),
      "heart_policy_daily_usage_read_failed",
      "无法读取今日自动心跳用量"
    );

    let estimatedCostUsd = 0;

    for (const row of rows ?? []) {
      const cost = Number(
        row.estimated_cost_usd ?? 0
      );

      if (Number.isFinite(cost)) {
        estimatedCostUsd += cost;
      }
    }

    const lastRun = await requireData(
      serviceClient
        .from("activity_runs")
        .select([
          "id",
          "status",
          "started_at",
          "estimated_cost_usd"
        ].join(", "))
        .eq("owner_user_id", userId)
        .eq("run_mode", "heartbeat")
        .eq("trigger_source", "worker")
        .in(
          "status",
          COUNTED_RUN_STATUSES
        )
        .order("started_at", {
          ascending: false
        })
        .limit(1)
        .maybeSingle(),
      "heart_policy_last_run_read_failed",
      "无法读取上一次自动模型醒来"
    );

    return {
      day,
      modelCalls:
        rows?.length ?? 0,
      estimatedCostUsd:
        Number(
          estimatedCostUsd.toFixed(6)
        ),
      lastRun:
        lastRun ?? null
    };
  }


  async function getNewUnansweredComments({
    userId,
    since
  }) {
    const comments = await requireData(
      serviceClient
        .from("study_comments")
        .select([
          "id",
          "entry_id",
          "body",
          "created_at"
        ].join(", "))
        .eq("owner_user_id", userId)
        .eq("author", "xie_shi")
        .gt(
          "created_at",
          since.toISOString()
        )
        .order("created_at", {
          ascending: false
        })
        .limit(20),
      "heart_policy_comments_read_failed",
      "无法检查新评论"
    );

    if (!comments?.length) {
      return [];
    }

    const commentIds = comments.map(
      (comment) => comment.id
    );

    const replies = await requireData(
      serviceClient
        .from("study_comments")
        .select("parent_comment_id")
        .eq("owner_user_id", userId)
        .eq("author", "g")
        .in(
          "parent_comment_id",
          commentIds
        ),
      "heart_policy_comment_replies_read_failed",
      "无法检查评论回复状态"
    );

    const repliedIds = new Set(
      (replies ?? [])
        .map(
          (reply) =>
            reply.parent_comment_id
        )
        .filter(Boolean)
    );

    return comments.filter(
      (comment) =>
        !repliedIds.has(comment.id)
    );
  }


  function nextInspectionAt({
    now,
    preferences
  }) {
    return addMinutes(
      now,
      randomMinutes(
        preferences.intervalMinMinutes,
        preferences.intervalMaxMinutes
      )
    );
  }


  async function evaluateScheduledModelWake({
    userId,
    now = new Date(),
    basePlan
  }) {
    const currentTime =
      now instanceof Date
        ? now
        : new Date(now);

    if (Number.isNaN(
      currentTime.getTime()
    )) {
      throw new HeartPolicyError(
        "invalid_policy_time",
        "模型唤醒策略收到无效时间"
      );
    }

    /*
      自由活动已经由通行证自己的
      max_model_calls / max_cost_usd 管理。
      不把普通自然醒来上限套在自由活动上。
    */
    if (basePlan?.activePass) {
      return {
        shouldCallModel: true,
        wakeReason: "free_activity",
        skipReason: null,
        skipDetail: null,
        nextInspectionAt: null,
        preferences: null,
        budget: null,
        naturalWake: null
      };
    }

    const preferences =
      await getPolicyPreferences({
        userId
      });

    const usage = await getDailyUsage({
      userId,
      now: currentTime,
      preferences
    });

    const standardNextInspection =
      nextInspectionAt({
        now: currentTime,
        preferences
      });

    const budget = {
      modelCalls:
        usage.modelCalls,
      modelCallLimit:
        preferences.dailyModelCallLimit,
      estimatedCostUsd:
        usage.estimatedCostUsd,
      costLimitUsd:
        preferences.dailyCostLimitUsd
    };

    if (
      usage.modelCalls >=
        preferences.dailyModelCallLimit
    ) {
      return {
        shouldCallModel: false,
        wakeReason: null,
        skipReason:
          "daily_model_call_limit_reached",
        skipDetail:
          `今日普通自动心跳已调用模型 ${usage.modelCalls}/${preferences.dailyModelCallLimit} 次。`,
        nextInspectionAt:
          addMinutes(
            usage.day.end,
            5
          ),
        preferences,
        budget,
        naturalWake: null
      };
    }

    if (
      preferences.dailyCostLimitUsd > 0 &&
      usage.estimatedCostUsd >=
        preferences.dailyCostLimitUsd
    ) {
      return {
        shouldCallModel: false,
        wakeReason: null,
        skipReason:
          "daily_model_cost_limit_reached",
        skipDetail:
          `今日普通自动心跳预估费用已达到 $${usage.estimatedCostUsd.toFixed(4)}。`,
        nextInspectionAt:
          addMinutes(
            usage.day.end,
            5
          ),
        preferences,
        budget,
        naturalWake: null
      };
    }

    const lastRunAt =
      usage.lastRun?.started_at
        ? new Date(
            usage.lastRun.started_at
          )
        : null;

    if (
      lastRunAt &&
      !Number.isNaN(lastRunAt.getTime())
    ) {
      const earliestNextModelWake =
        addMinutes(
          lastRunAt,
          preferences
            .minModelWakeIntervalMinutes
        );

      if (
        earliestNextModelWake >
          currentTime
      ) {
        return {
          shouldCallModel: false,
          wakeReason: null,
          skipReason:
            "minimum_model_wake_interval",
          skipDetail:
            `距离上一次普通自动模型醒来不足 ${preferences.minModelWakeIntervalMinutes} 分钟。`,
          nextInspectionAt:
            earliestNextModelWake >
              standardNextInspection
              ? earliestNextModelWake
              : standardNextInspection,
          preferences,
          budget,
          naturalWake: null
        };
      }
    }

    const signalSince =
      lastRunAt &&
      !Number.isNaN(lastRunAt.getTime())
        ? lastRunAt
        : usage.day.start;

    const unansweredComments =
      await getNewUnansweredComments({
        userId,
        since: signalSince
      });

    if (unansweredComments.length) {
      return {
        shouldCallModel: true,
        wakeReason: "new_comment",
        skipReason: null,
        skipDetail: null,
        nextInspectionAt: null,
        preferences,
        budget,
        naturalWake: {
          triggeredByCommentCount:
            unansweredComments.length
        }
      };
    }

    if (!preferences.naturalWakeEnabled) {
      return {
        shouldCallModel: false,
        wakeReason: null,
        skipReason:
          "natural_wake_disabled",
        skipDetail:
          "自然醒来机会目前关闭，本轮只完成程序巡检。",
        nextInspectionAt:
          standardNextInspection,
        preferences,
        budget,
        naturalWake: null
      };
    }

    const target =
      selectDailyNaturalTarget({
        userId,
        dateKey:
          usage.day.dateKey,
        minimum:
          preferences
            .naturalWakeMinPerDay,
        maximum:
          preferences
            .naturalWakeMaxPerDay
      });

    const remainingTarget =
      Math.max(
        0,
        target - usage.modelCalls
      );

    const minutesRemaining =
      Math.max(
        1,
        (
          usage.day.end.getTime() -
          currentTime.getTime()
        ) / 60_000
      );

    const averageInspectionMinutes =
      (
        preferences.intervalMinMinutes +
        preferences.intervalMaxMinutes
      ) / 2;

    const chance =
      calculateNaturalWakeChance({
        remainingTarget,
        minutesRemaining,
        averageInspectionMinutes
      });

    const naturalWake = {
      dateKey:
        usage.day.dateKey,
      target,
      completed:
        usage.modelCalls,
      remaining:
        remainingTarget,
      chance:
        Number(chance.toFixed(4))
    };

    if (remainingTarget <= 0) {
      return {
        shouldCallModel: false,
        wakeReason: null,
        skipReason:
          "natural_wake_target_reached",
        skipDetail:
          `今日自然醒来目标 ${target} 次已经完成。`,
        nextInspectionAt:
          addMinutes(
            usage.day.end,
            5
          ),
        preferences,
        budget,
        naturalWake
      };
    }

    if (Math.random() <= chance) {
      return {
        shouldCallModel: true,
        wakeReason: "natural_wake",
        skipReason: null,
        skipDetail: null,
        nextInspectionAt: null,
        preferences,
        budget,
        naturalWake
      };
    }

    return {
      shouldCallModel: false,
      wakeReason: null,
      skipReason:
        "inspection_only",
      skipDetail:
        "本轮只完成程序巡检，没有触发真实模型醒来。",
      nextInspectionAt:
        standardNextInspection,
      preferences,
      budget,
      naturalWake
    };
  }


  return {
    getPolicyPreferences,
    getDailyUsage,
    evaluateScheduledModelWake
  };
}
