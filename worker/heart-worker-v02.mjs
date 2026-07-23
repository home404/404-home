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
  createHeartPolicyService,
  HeartPolicyError
} from "../services/heart-policy-service.mjs";


const WORKER_VERSION = "0.2.0";
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


function createOpenAIClient(config) {
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


async function processClaim({
  claim,
  heartService,
  heartPolicyService,
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

    /*
      第一层：原有纯规则检查。
      包括开关、休息时段、聊天缓冲、
      自由活动通行证和通行证预算。
    */
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

    /*
      第二层：模型唤醒策略。
      这里检查每日上限、最短间隔、
      新评论和自然醒来机会。
      没通过时不会调用 OpenAI。
    */
    const policy =
      await heartPolicyService
        .evaluateScheduledModelWake({
          userId,
          now,
          basePlan: plan
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
            "model_wake_policy",
          budget:
            policy.budget,
          naturalWake:
            policy.naturalWake
        }
      });

      return;
    }

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

    const result =
      await heartService.runOnce({
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
            lastWorkerBudget:
              policy.budget,
            lastWorkerNaturalWake:
              policy.naturalWake
          }
        });

    writeLog(
      "info",
      "heartbeat_model_wake_completed",
      {
        ownerUserId: userId,
        runId:
          result.run?.id ?? null,
        wakeReason:
          policy.wakeReason,
        decision:
          result.decision?.action ?? null,
        acted:
          Boolean(
            result.execution?.acted
          ),
        inputTokens:
          result.run?.input_tokens ?? 0,
        outputTokens:
          result.run?.output_tokens ?? 0,
        estimatedCostUsd:
          result.run
            ?.estimated_cost_usd ?? 0,
        nextHeartbeatAt:
          result.heartbeat
            ?.next_wake_at ?? null,
        claimReleased:
          release.released
      }
    );
  } catch (error) {
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
                retryAt.toISOString()
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
      "heartbeat_inspection_failed",
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
      heartService,
      heartPolicyService,
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

  const openaiClient =
    createOpenAIClient(config);

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
      architecture:
        "inspection_then_model_wake",
      pollSeconds:
        config.pollSeconds,
      batchSize:
        config.batchSize,
      leaseSeconds:
        config.leaseSeconds,
      retryMinutes:
        config.retryMinutes,
      proxyEnabled:
        Boolean(config.socksProxyUrl)
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
        config
      });

      const now = Date.now();

      if (
        count === 0 &&
        now - lastIdleLogAt >=
          600_000
      ) {
        writeLog(
          "info",
          "worker_idle",
          {
            message:
              "没有到期的程序巡检。"
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
  const payload =
    error instanceof HeartServiceError ||
    error instanceof HeartPolicyError
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
