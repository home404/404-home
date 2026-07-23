import "dotenv/config";
import process from "node:process";

import OpenAI from "openai";
import fetch from "node-fetch";
import {
  SocksProxyAgent
} from "socks-proxy-agent";
import {
  createClient
} from "@supabase/supabase-js";

import {
  createHeartService,
  HeartServiceError
} from "../services/heart-service.mjs";

import {
  calculateNaturalWakeChance,
  createHeartPolicyService,
  HeartPolicyError
} from "../services/heart-policy-service.mjs";

import {
  createHippocampusService,
  HippocampusServiceError
} from "../services/hippocampus-service.mjs";


const WORKER_VERSION = "0.3.0";
const DEFAULT_POLL_SECONDS = 30;
const DEFAULT_BATCH_SIZE = 2;
const DEFAULT_LEASE_SECONDS = 900;
const DEFAULT_RETRY_MINUTES = 10;
const DEFAULT_OPENAI_TIMEOUT_MS = 90_000;


function normalizeBaseUrl(value) {
  return String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
}


function parseInteger(
  value,
  fallback,
  minimum,
  maximum
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


function parseBoolean(
  value,
  fallback = false
) {
  if (value == null || value === "") {
    return fallback;
  }

  return [
    "1",
    "true",
    "yes",
    "on"
  ].includes(
    String(value)
      .trim()
      .toLowerCase()
  );
}


function addMinutes(date, minutes) {
  return new Date(
    date.getTime() +
      minutes * 60_000
  );
}


function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}


function safeError(error) {
  return {
    name:
      error?.name ?? "Error",
    code:
      error?.code ?? null,
    message:
      error?.message ??
      String(error)
  };
}


function writeLog(
  level,
  event,
  detail = {}
) {
  const payload = {
    time: new Date().toISOString(),
    level,
    event,
    workerVersion:
      WORKER_VERSION,
    ...detail
  };

  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}


function readConfig() {
  const supabaseUrl = normalizeBaseUrl(
    process.env.SUPABASE_URL
  );

  const secretKey = String(
    process.env.SUPABASE_SECRET_KEY ?? ""
  ).trim();

  const openaiApiKey = String(
    process.env.OPENAI_API_KEY ?? ""
  ).trim();

  if (!supabaseUrl) {
    throw new Error(
      "缺少 SUPABASE_URL"
    );
  }

  if (!secretKey) {
    throw new Error(
      "缺少 SUPABASE_SECRET_KEY"
    );
  }

  if (!openaiApiKey) {
    throw new Error(
      "缺少 OPENAI_API_KEY"
    );
  }

  return {
    enabled: parseBoolean(
      process.env.HEART_WORKER_ENABLED,
      false
    ),
    supabaseUrl,
    secretKey,
    openaiApiKey,
    socksProxyUrl: String(
      process.env.HEART_SOCKS_PROXY_URL ?? ""
    ).trim(),
    pollSeconds: parseInteger(
      process.env.HEART_WORKER_POLL_SECONDS,
      DEFAULT_POLL_SECONDS,
      10,
      300
    ),
    batchSize: parseInteger(
      process.env.HEART_WORKER_BATCH_SIZE,
      DEFAULT_BATCH_SIZE,
      1,
      10
    ),
    leaseSeconds: parseInteger(
      process.env.HEART_WORKER_LEASE_SECONDS,
      DEFAULT_LEASE_SECONDS,
      120,
      3600
    ),
    retryMinutes: parseInteger(
      process.env.HEART_WORKER_RETRY_MINUTES,
      DEFAULT_RETRY_MINUTES,
      2,
      120
    ),
    openaiTimeoutMs: parseInteger(
      process.env.HEART_OPENAI_TIMEOUT_MS,
      DEFAULT_OPENAI_TIMEOUT_MS,
      10_000,
      300_000
    )
  };
}


function createServiceClient(config) {
  return createClient(
    config.supabaseUrl,
    config.secretKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    }
  );
}


function createRawOpenAIClient(config) {
  if (!config.socksProxyUrl) {
    return new OpenAI({
      apiKey: config.openaiApiKey,
      timeout: config.openaiTimeoutMs,
      maxRetries: 1
    });
  }

  const agent = new SocksProxyAgent(
    config.socksProxyUrl
  );

  const proxyFetch = (
    url,
    init = {}
  ) => {
    return fetch(url, {
      ...init,
      agent
    });
  };

  return new OpenAI({
    apiKey: config.openaiApiKey,
    fetch: proxyFetch,
    timeout: config.openaiTimeoutMs,
    maxRetries: 1
  });
}


function replaceLegacyHeartContext(
  prompt,
  hippocampusText
) {
  const text = String(prompt ?? "");
  const identityMarker =
    "【轻量身份与说话锚点】";
  const commentsMarker =
    "【等待回复的评论】";
  const outputMarker =
    "输出字段说明：";

  const identityIndex = text.indexOf(
    identityMarker
  );
  const commentsIndex = text.indexOf(
    commentsMarker
  );
  const outputIndex = text.indexOf(
    outputMarker
  );

  if (
    identityIndex < 0 ||
    commentsIndex < identityIndex ||
    outputIndex < commentsIndex
  ) {
    return [
      text,
      "",
      "【白狐狸海马体唤醒包】",
      hippocampusText
    ].join("\n");
  }

  const prefix = text
    .slice(0, identityIndex)
    .trimEnd();
  const commentsBlock = text
    .slice(commentsIndex, outputIndex)
    .trim();
  const outputBlock = text
    .slice(outputIndex)
    .trimStart();

  return [
    prefix,
    "",
    "【白狐狸海马体唤醒包】",
    hippocampusText,
    "",
    commentsBlock,
    "",
    outputBlock
  ].join("\n");
}


function createContextAwareOpenAIClient({
  rawClient,
  hippocampusService,
  getWakeEnvelope
}) {
  return {
    responses: {
      create: async (options) => {
        const envelope = getWakeEnvelope();

        if (!envelope?.userId) {
          return rawClient.responses.create(
            options
          );
        }

        const hippocampusContext =
          await hippocampusService
            .buildContextForHeartbeat({
              userId: envelope.userId,
              query: [
                "独立醒来",
                envelope.wakeReason,
                envelope.query
              ]
                .filter(Boolean)
                .join("；"),
              signalText:
                envelope.signalText ?? ""
            });

        envelope.hippocampusContext =
          hippocampusContext;

        const input = Array.isArray(
          options?.input
        )
          ? options.input.map((item) => {
              if (
                item?.role !== "user" ||
                typeof item.content !== "string"
              ) {
                return item;
              }

              return {
                ...item,
                content:
                  replaceLegacyHeartContext(
                    item.content,
                    hippocampusContext.text
                  )
              };
            })
          : options?.input;

        return rawClient.responses.create({
          ...options,
          input
        });
      }
    }
  };
}


async function claimDueHeartbeats({
  serviceClient,
  config
}) {
  const {
    data,
    error
  } = await serviceClient.rpc(
    "claim_due_heartbeats",
    {
      p_limit:
        config.batchSize,
      p_lease_seconds:
        config.leaseSeconds
    }
  );

  if (error) {
    const wrapped = new Error(
      error.message ||
      "无法抢占到期的自动心跳"
    );

    wrapped.code =
      error.code ||
      "heartbeat_claim_rpc_failed";

    throw wrapped;
  }

  return data ?? [];
}


async function recordSkip({
  heartService,
  userId,
  claimToken,
  scheduledFor,
  reason,
  detail,
  nextHeartbeatAt,
  metadata = {}
}) {
  const result =
    await heartService
      .recordScheduledSkip({
        userId,
        claimToken,
        scheduledFor,
        skipReason: reason,
        skipDetail: detail,
        nextHeartbeatAt,
        metadata: {
          workerVersion:
            WORKER_VERSION,
          ...metadata
        }
      });

  writeLog(
    "info",
    "heartbeat_inspection_skipped_model",
    {
      ownerUserId: userId,
      reason,
      detail,
      nextHeartbeatAt:
        nextHeartbeatAt
          ? new Date(
              nextHeartbeatAt
            ).toISOString()
          : null,
      claimReleased:
        result.release.released,
      metadata
    }
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

  return values;
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

  return {
    start: zonedDateTimeToDate({
      ...parts,
      hour: 0,
      minute: 0,
      timeZone
    }),
    end: zonedDateTimeToDate({
      ...nextDay,
      hour: 0,
      minute: 0,
      timeZone
    })
  };
}


async function getNaturalWakeCount({
  serviceClient,
  userId,
  now,
  timeZone
}) {
  const day = getLocalDayBounds(
    now,
    timeZone
  );

  const {
    data,
    error
  } = await serviceClient
    .from("heartbeat_runs")
    .select("metadata, started_at, status")
    .eq("owner_user_id", userId)
    .gte(
      "started_at",
      day.start.toISOString()
    )
    .lt(
      "started_at",
      day.end.toISOString()
    )
    .in("status", [
      "running",
      "acted",
      "silent",
      "failed"
    ]);

  if (error) {
    throw error;
  }

  return (data ?? []).filter(
    (row) =>
      row?.metadata?.wakeReason ===
        "natural_wake"
  ).length;
}


async function adjustNaturalWakePolicy({
  serviceClient,
  userId,
  now,
  policy
}) {
  const naturalBranch =
    policy?.wakeReason === "natural_wake" ||
    [
      "inspection_only",
      "natural_wake_target_reached"
    ].includes(policy?.skipReason);

  if (
    !naturalBranch ||
    !policy?.naturalWake ||
    !policy?.preferences
  ) {
    return policy;
  }

  const completed =
    await getNaturalWakeCount({
      serviceClient,
      userId,
      now,
      timeZone:
        policy.preferences.timezone
    });

  const target =
    policy.naturalWake.target;
  const remaining = Math.max(
    0,
    target - completed
  );

  const day = getLocalDayBounds(
    now,
    policy.preferences.timezone
  );

  const minutesRemaining = Math.max(
    1,
    (
      day.end.getTime() -
      now.getTime()
    ) / 60_000
  );

  const averageInspectionMinutes = (
    policy.preferences.intervalMinMinutes +
    policy.preferences.intervalMaxMinutes
  ) / 2;

  const chance =
    calculateNaturalWakeChance({
      remainingTarget: remaining,
      minutesRemaining,
      averageInspectionMinutes
    });

  const naturalWake = {
    ...policy.naturalWake,
    completed,
    remaining,
    chance:
      Number(chance.toFixed(4)),
    countBasis:
      "wakeReason=natural_wake"
  };

  if (remaining <= 0) {
    return {
      ...policy,
      shouldCallModel: false,
      wakeReason: null,
      skipReason:
        "natural_wake_target_reached",
      skipDetail:
        `今日自然醒来目标 ${target} 次已经完成。`,
      nextInspectionAt:
        addMinutes(day.end, 5),
      naturalWake
    };
  }

  if (Math.random() <= chance) {
    return {
      ...policy,
      shouldCallModel: true,
      wakeReason: "natural_wake",
      skipReason: null,
      skipDetail: null,
      nextInspectionAt: null,
      naturalWake
    };
  }

  return {
    ...policy,
    shouldCallModel: false,
    wakeReason: null,
    skipReason: "inspection_only",
    skipDetail:
      "本轮只完成程序巡检，没有触发真实模型醒来。",
    naturalWake
  };
}


async function mergeRunMetadata({
  serviceClient,
  table,
  id,
  patch
}) {
  if (!id) {
    return null;
  }

  const {
    data: current,
    error: readError
  } = await serviceClient
    .from(table)
    .select("metadata")
    .eq("id", id)
    .maybeSingle();

  if (readError) {
    throw readError;
  }

  const {
    data,
    error
  } = await serviceClient
    .from(table)
    .update({
      metadata: {
        ...(current?.metadata ?? {}),
        ...patch
      }
    })
    .eq("id", id)
    .select("id, metadata")
    .single();

  if (error) {
    throw error;
  }

  return data;
}


async function recordWakeReason({
  serviceClient,
  result,
  policy,
  envelope
}) {
  const patch = {
    wakeReason:
      policy.wakeReason,
    workerVersion:
      WORKER_VERSION,
    hippocampusEstimatedTokens:
      envelope.hippocampusContext
        ?.estimatedInputTokens ?? null,
    hippocampusMemoryIds:
      envelope.hippocampusContext
        ?.memories
        ?.map((item) => item.id) ?? [],
    hippocampusMessageIds:
      envelope.hippocampusContext
        ?.recentMessages
        ?.map((item) => item.id) ?? []
  };

  await Promise.all([
    mergeRunMetadata({
      serviceClient,
      table: "activity_runs",
      id: result.run?.id,
      patch
    }),
    mergeRunMetadata({
      serviceClient,
      table: "heartbeat_runs",
      id: result.heartbeat?.id,
      patch
    })
  ]);
}


async function processClaim({
  claim,
  serviceClient,
  heartService,
  heartPolicyService,
  setWakeEnvelope,
  config
}) {
  const userId = claim.owner_user_id;
  const claimToken = claim.claim_token;
  const scheduledFor =
    claim.due_at ??
    new Date().toISOString();

  writeLog(
    "info",
    "heartbeat_inspection_claimed",
    {
      ownerUserId: userId,
      scheduledFor,
      leaseUntil:
        claim.lease_until ?? null
    }
  );

  try {
    const now = new Date();

    const plan =
      await heartService
        .getScheduledWakePlan({
          userId,
          now
        });

    if (!plan.shouldRun) {
      await recordSkip({
        heartService,
        userId,
        claimToken,
        scheduledFor,
        reason:
          plan.skipReason,
        detail:
          plan.skipDetail,
        nextHeartbeatAt:
          plan.nextHeartbeatAt,
        metadata: {
          inspectionLayer:
            "base_plan",
          runMode:
            plan.runMode ?? null
        }
      });

      return;
    }

    let policy =
      await heartPolicyService
        .evaluateScheduledModelWake({
          userId,
          now,
          basePlan: plan
        });

    policy = await adjustNaturalWakePolicy({
      serviceClient,
      userId,
      now,
      policy
    });

    if (!policy.shouldCallModel) {
      await recordSkip({
        heartService,
        userId,
        claimToken,
        scheduledFor,
        reason:
          policy.skipReason,
        detail:
          policy.skipDetail,
        nextHeartbeatAt:
          policy.nextInspectionAt,
        metadata: {
          inspectionLayer:
            "model_wake_policy_v03",
          budget:
            policy.budget,
          naturalWake:
            policy.naturalWake
        }
      });

      return;
    }

    const envelope = {
      userId,
      wakeReason:
        policy.wakeReason,
      query:
        policy.wakeReason === "new_comment"
          ? "查看并考虑回复谢诗的新评论"
          : policy.wakeReason === "free_activity"
            ? "自由活动期间决定下一件真实可做的事"
            : "自然醒来，看看此刻是否想做什么或给谢诗留言",
      signalText: [
        `运行模式：${plan.runMode}`,
        `唤醒原因：${policy.wakeReason}`,
        policy.naturalWake
          ?.triggeredByCommentCount
          ? `等待处理的新评论：${policy.naturalWake.triggeredByCommentCount} 条`
          : ""
      ]
        .filter(Boolean)
        .join("；"),
      hippocampusContext: null
    };

    setWakeEnvelope(envelope);

    writeLog(
      "info",
      "heartbeat_model_wake_allowed",
      {
        ownerUserId: userId,
        wakeReason:
          policy.wakeReason,
        runMode:
          plan.runMode,
        budget:
          policy.budget,
        naturalWake:
          policy.naturalWake
      }
    );

    let result;

    try {
      result = await heartService.runOnce({
        userId,
        runMode: plan.runMode,
        wakeKind:
          plan.wakeKind,
        source: "worker",
        activityPassId:
          plan.activePass?.id ?? null,
        scheduledFor,
        workerClaimToken:
          claimToken
      });
    } finally {
      setWakeEnvelope(null);
    }

    await recordWakeReason({
      serviceClient,
      result,
      policy,
      envelope
    });

    const release =
      await heartService
        .releaseHeartbeatClaim({
          userId,
          claimToken,
          metadataPatch: {
            lastWorkerRunAt:
              new Date().toISOString(),
            lastWorkerRunId:
              result.run?.id ?? null,
            lastWorkerDecision:
              result.decision?.action ?? null,
            lastWorkerWakeReason:
              policy.wakeReason,
            workerVersion:
              WORKER_VERSION
          }
        });

    writeLog(
      "info",
      "heartbeat_completed",
      {
        ownerUserId: userId,
        runId:
          result.run?.id ?? null,
        decision:
          result.decision?.action ?? null,
        acted:
          Boolean(
            result.execution?.acted
          ),
        wakeReason:
          policy.wakeReason,
        hippocampusEstimatedTokens:
          envelope.hippocampusContext
            ?.estimatedInputTokens ?? null,
        nextHeartbeatAt:
          result.heartbeat
            ?.next_wake_at ?? null,
        claimReleased:
          release.released
      }
    );
  } catch (error) {
    setWakeEnvelope(null);

    const retryAt = addMinutes(
      new Date(),
      config.retryMinutes
    );

    let release = null;

    try {
      release =
        await heartService
          .releaseHeartbeatClaim({
            userId,
            claimToken,
            nextHeartbeatAt:
              retryAt,
            metadataPatch: {
              lastWorkerErrorAt:
                new Date().toISOString(),
              lastWorkerError:
                safeError(error),
              workerRetryAt:
                retryAt.toISOString(),
              workerVersion:
                WORKER_VERSION
            }
          });
    } catch (releaseError) {
      writeLog(
        "error",
        "heartbeat_claim_release_failed",
        {
          ownerUserId: userId,
          error:
            safeError(releaseError)
        }
      );
    }

    writeLog(
      "error",
      "heartbeat_failed",
      {
        ownerUserId: userId,
        error: safeError(error),
        retryAt:
          retryAt.toISOString(),
        claimReleased:
          release?.released ?? false
      }
    );
  }
}


async function runCycle({
  serviceClient,
  heartService,
  heartPolicyService,
  setWakeEnvelope,
  config
}) {
  const claims =
    await claimDueHeartbeats({
      serviceClient,
      config
    });

  for (const claim of claims) {
    await processClaim({
      claim,
      serviceClient,
      heartService,
      heartPolicyService,
      setWakeEnvelope,
      config
    });
  }

  return claims.length;
}


async function main() {
  const args = new Set(
    process.argv.slice(2)
  );

  const runOnce = args.has("--once");
  const config = readConfig();

  if (!config.enabled && !runOnce) {
    writeLog(
      "info",
      "worker_disabled",
      {
        message:
          "HEART_WORKER_ENABLED 未开启，Worker 安全退出。"
      }
    );

    return;
  }

  const serviceClient =
    createServiceClient(config);
  const hippocampusService =
    createHippocampusService({
      serviceClient
    });

  let wakeEnvelope = null;
  const setWakeEnvelope = (value) => {
    wakeEnvelope = value;
  };

  const rawOpenAIClient =
    createRawOpenAIClient(config);
  const openaiClient =
    createContextAwareOpenAIClient({
      rawClient: rawOpenAIClient,
      hippocampusService,
      getWakeEnvelope: () =>
        wakeEnvelope
    });

  const heartService =
    createHeartService({
      serviceClient,
      openaiClient
    });
  const heartPolicyService =
    createHeartPolicyService({
      serviceClient
    });

  writeLog(
    "info",
    "worker_started",
    {
      mode:
        runOnce ? "once" : "continuous",
      pollSeconds:
        config.pollSeconds,
      batchSize:
        config.batchSize,
      leaseSeconds:
        config.leaseSeconds,
      retryMinutes:
        config.retryMinutes,
      proxyEnabled:
        Boolean(config.socksProxyUrl),
      hippocampusEnabled: true
    }
  );

  let stopping = false;

  const requestStop = (signal) => {
    stopping = true;

    writeLog(
      "info",
      "worker_stopping",
      { signal }
    );
  };

  process.once(
    "SIGINT",
    () => requestStop("SIGINT")
  );
  process.once(
    "SIGTERM",
    () => requestStop("SIGTERM")
  );

  let lastIdleLogAt = 0;

  do {
    try {
      const count = await runCycle({
        serviceClient,
        heartService,
        heartPolicyService,
        setWakeEnvelope,
        config
      });

      const now = Date.now();

      if (
        count === 0 &&
        now - lastIdleLogAt >= 600_000
      ) {
        writeLog(
          "info",
          "worker_idle",
          {
            message:
              "没有到期的自动心跳。"
          }
        );

        lastIdleLogAt = now;
      }
    } catch (error) {
      writeLog(
        "error",
        "worker_cycle_failed",
        {
          error: safeError(error),
          hint:
            error?.code === "PGRST202"
              ? "请先运行 20260722_10_heartbeat_worker_claims.sql"
              : null
        }
      );

      if (runOnce) {
        process.exitCode = 1;
      }
    }

    if (runOnce || stopping) {
      break;
    }

    await sleep(
      config.pollSeconds * 1000
    );
  } while (!stopping);

  writeLog(
    "info",
    "worker_stopped"
  );
}


main().catch((error) => {
  const knownError =
    error instanceof HeartServiceError ||
    error instanceof HeartPolicyError ||
    error instanceof HippocampusServiceError;

  const payload = knownError
    ? {
        ...safeError(error),
        status: error.status,
        details: error.details
      }
    : safeError(error);

  writeLog(
    "error",
    "worker_boot_failed",
    {
      error: payload
    }
  );

  process.exitCode = 1;
});
