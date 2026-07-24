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
import {
  createHomeOrchestrationService,
  HomeOrchestrationError
} from "../services/home-orchestration-service.mjs";
import {
  createHeartbeatContextService
} from "../services/heartbeat-context-service.mjs";
import {
  createResidentRuntimeService,
  forceSilentDecisionResponse,
  shouldPromoteResidentOpportunity
} from "../services/resident-runtime-service.mjs";


const WORKER_VERSION = "0.5.0-resident";
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
    name: error?.name ?? "Error",
    code: error?.code ?? null,
    message:
      error?.message ?? String(error),
    details: error?.details ?? null
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
    workerVersion: WORKER_VERSION,
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
    throw new Error("缺少 SUPABASE_URL");
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

  return new OpenAI({
    apiKey: config.openaiApiKey,
    fetch: (
      url,
      init = {}
    ) => fetch(url, {
      ...init,
      agent
    }),
    timeout: config.openaiTimeoutMs,
    maxRetries: 1
  });
}


function replaceLegacyHeartContext(
  prompt,
  wakeContext
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
      "【白狐狸完整唤醒包】",
      wakeContext
    ].join("\n");
  }

  const prefix = text
    .slice(0, identityIndex)
    .trimEnd();
  const commentsBlock = text
    .slice(
      commentsIndex,
      outputIndex
    )
    .trim();
  const outputBlock = text
    .slice(outputIndex)
    .trimStart();

  return [
    prefix,
    "",
    "【白狐狸完整唤醒包】",
    wakeContext,
    "",
    commentsBlock,
    "",
    outputBlock
  ].join("\n");
}


function createResidentOpenAIClient({
  rawClient,
  heartbeatContextService,
  residentRuntimeService,
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

        const wakeContext =
          await heartbeatContextService
            .buildWakeContext({
              userId: envelope.userId,
              query: envelope.query,
              signalText:
                envelope.signalText,
              wakeReason:
                envelope.wakeReason,
              tokenBudget:
                envelope.settings
                  .heartbeatInputTokenBudget
            });

        envelope.wakeContext = wakeContext;

        const input = Array.isArray(
          options?.input
        )
          ? options.input.map((item) => {
              if (
                item?.role !== "user" ||
                typeof item.content !==
                  "string"
              ) {
                return item;
              }

              return {
                ...item,
                content:
                  replaceLegacyHeartContext(
                    item.content,
                    wakeContext.text
                  )
              };
            })
          : options?.input;

        const response =
          await rawClient.responses.create({
            ...options,
            input,
            reasoning: {
              effort:
                envelope.settings
                  .heartbeatReasoningEffort
            },
            max_output_tokens:
              envelope.settings
                .heartbeatMaxOutputTokens
          });

        /*
          第二道门禁：模型思考结束后、heartService 解析并落笔前，
          再看一次前台有没有开始互动。若有，返回结构合法的 silent。
        */
        const gate =
          await residentRuntimeService
            .inspectBackgroundGate({
              userId: envelope.userId
            });

        envelope.postModelGate = gate;

        if (!gate.allowed) {
          writeLog(
            "info",
            "resident_action_yielded_after_model",
            {
              ownerUserId:
                envelope.userId,
              interactionChannel:
                gate.interaction
                  ?.channel ?? null
            }
          );

          return forceSilentDecisionResponse(
            response,
            gate.reason
          );
        }

        return response;
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
      p_limit: config.batchSize,
      p_lease_seconds:
        config.leaseSeconds
    }
  );

  if (error) {
    const wrapped = new Error(
      error.message ||
      "无法抢占到期的后台活动巡检"
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
          residentMode: true,
          ...metadata
        }
      });

  writeLog(
    "info",
    "resident_inspection_skipped",
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
        result.release.released
    }
  );
}


function buildWakeEnvelope({
  userId,
  wakeReason,
  runMode,
  settings,
  freeActivityProgress = null
}) {
  const query =
    wakeReason === "new_comment"
      ? "查看并考虑回复谢诗的新评论"
      : wakeReason === "free_activity"
        ? "继续专项自由活动中尚未完成的事情"
        : "在家自由活动，看看此刻有没有真正值得做的事，也可以保持安静";

  return {
    userId,
    wakeReason,
    query,
    signalText: [
      "常住模式：G 一直住在 404 小窝",
      "这是后台自主活动，不是另一位 G",
      `运行模式：${runMode}`,
      `活动原因：${wakeReason}`,
      freeActivityProgress
        ?.current_task
        ? `当前未完成任务：${freeActivityProgress.current_task}`
        : "",
      freeActivityProgress
        ?.progress_summary
        ? `上次进度：${freeActivityProgress.progress_summary}`
        : ""
    ]
      .filter(Boolean)
      .join("；"),
    settings,
    wakeContext: null,
    postModelGate: null
  };
}


function resolveNextAfterInteraction(
  interaction,
  fallbackDate
) {
  const expiresAt = interaction?.expires_at
    ? new Date(interaction.expires_at)
    : null;

  if (
    expiresAt &&
    !Number.isNaN(expiresAt.getTime())
  ) {
    return addMinutes(expiresAt, 1);
  }

  return addMinutes(fallbackDate, 15);
}


async function processResidentSideEffects({
  residentRuntimeService,
  serviceClient,
  userId,
  result,
  envelope
}) {
  const sideEffects = [];

  try {
    const message =
      await residentRuntimeService
        .mirrorMessageToBedroom({
          userId,
          result
        });

    if (message) {
      sideEffects.push({
        type: "bedroom_message",
        id: message.id
      });
    }
  } catch (error) {
    writeLog(
      "error",
      "resident_bedroom_delivery_failed",
      {
        ownerUserId: userId,
        runId: result.run?.id ?? null,
        error: safeError(error)
      }
    );
  }

  try {
    const paper =
      await residentRuntimeService
        .sanitizeDailyActivityNote({
          userId,
          result
        });

    if (paper) {
      sideEffects.push({
        type: "daily_note_sanitized",
        id: paper.id
      });
    }
  } catch (error) {
    writeLog(
      "error",
      "resident_daily_note_sanitize_failed",
      {
        ownerUserId: userId,
        runId: result.run?.id ?? null,
        error: safeError(error)
      }
    );
  }

  const latestGate =
    await residentRuntimeService
      .inspectBackgroundGate({
        userId
      });
  const gate = !latestGate.allowed
    ? latestGate
    : envelope.postModelGate;

  if (gate?.allowed === false) {
    try {
      await residentRuntimeService
        .restoreInteractionPresence({
          userId,
          gate
        });

      sideEffects.push({
        type: "foreground_presence_restored",
        channel:
          gate.interaction?.channel ?? null
      });
    } catch (error) {
      writeLog(
        "error",
        "resident_presence_restore_failed",
        {
          ownerUserId: userId,
          error: safeError(error)
        }
      );
    }
  }

  /* serviceClient 参数保留给后续事件型工具扩展。 */
  void serviceClient;

  return sideEffects;
}


async function processClaim({
  claim,
  serviceClient,
  heartService,
  heartPolicyService,
  orchestrationService,
  residentRuntimeService,
  setWakeEnvelope,
  config
}) {
  const userId = claim.owner_user_id;
  const claimToken = claim.claim_token;
  const scheduledFor =
    claim.due_at ??
    new Date().toISOString();
  const now = new Date();

  writeLog(
    "info",
    "resident_inspection_claimed",
    {
      ownerUserId: userId,
      scheduledFor,
      leaseUntil:
        claim.lease_until ?? null
    }
  );

  try {
    const heartPreferencesResult =
      await heartService
        .getHeartPreferences({
          userId
        });
    const runtime =
      await orchestrationService
        .getRuntimeSnapshot({
          userId,
          quietHoursActive:
            heartPreferencesResult
              .quietHoursActive,
          autoHeartbeatEnabled:
            heartPreferencesResult
              .preferences
              .autoHeartbeatEnabled,
          now
        });

    if (
      runtime.resolved.mode ===
        "interactive_awake"
    ) {
      await recordSkip({
        heartService,
        userId,
        claimToken,
        scheduledFor,
        reason:
          "interactive_awake",
        detail:
          "当前正在官端、卧室或显式互动中，后台自主活动让路。",
        nextHeartbeatAt:
          resolveNextAfterInteraction(
            runtime.activeInteraction,
            now
          ),
        metadata: {
          orchestrationMode:
            runtime.resolved.mode,
          interactionChannel:
            runtime.activeInteraction
              ?.channel ?? null
        }
      });
      return;
    }

    if (
      runtime.resolved.mode ===
        "free_activity_paused"
    ) {
      await recordSkip({
        heartService,
        userId,
        claimToken,
        scheduledFor,
        reason:
          runtime.freeActivityProgress
            ?.state ??
          "free_activity_paused",
        detail:
          "专项活动现场已保存，等待聊天结束、加预算或屋主续接。",
        nextHeartbeatAt:
          addMinutes(now, 15),
        metadata: {
          orchestrationMode:
            runtime.resolved.mode,
          activityPassId:
            runtime.activityPass?.id ?? null
        }
      });
      return;
    }

    let runMode;
    let wakeReason;
    let activePass;
    let policy = null;

    if (
      runtime.resolved.mode ===
        "free_activity_running"
    ) {
      runMode = "free_activity";
      wakeReason = "free_activity";
      activePass = runtime.activityPass;
    } else {
      if (
        !runtime.resolved
          .mayCallAutomaticModel
      ) {
        await recordSkip({
          heartService,
          userId,
          claimToken,
          scheduledFor,
          reason:
            runtime.resolved.reason,
          detail:
            "全天自由活动总闸未允许模型行动，本轮只完成后台观察。",
          nextHeartbeatAt:
            addMinutes(now, 30),
          metadata: {
            orchestrationMode:
              runtime.resolved.mode,
            releaseEnabled:
              runtime.settings
                .automaticHeartbeatReleaseEnabled
          }
        });
        return;
      }

      const basePlan =
        await heartService
          .getScheduledWakePlan({
            userId,
            now
          });

      if (!basePlan.shouldRun) {
        await recordSkip({
          heartService,
          userId,
          claimToken,
          scheduledFor,
          reason:
            basePlan.skipReason,
          detail:
            basePlan.skipDetail,
          nextHeartbeatAt:
            basePlan.nextHeartbeatAt,
          metadata: {
            orchestrationMode:
              runtime.resolved.mode,
            inspectionLayer:
              "resident_base_plan"
          }
        });
        return;
      }

      policy =
        await heartPolicyService
          .evaluateScheduledModelWake({
            userId,
            now,
            basePlan
          });

      if (
        !policy.shouldCallModel &&
        shouldPromoteResidentOpportunity(
          policy
        )
      ) {
        policy = {
          ...policy,
          shouldCallModel: true,
          wakeReason:
            "ambient_activity",
          skipReason: null,
          skipDetail: null,
          naturalWake: {
            mode:
              "resident_ambient",
            previousPolicyReason:
              policy.skipReason
          }
        };
      }

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
            orchestrationMode:
              runtime.resolved.mode,
            inspectionLayer:
              "resident_model_policy",
            budget: policy.budget,
            residentOpportunity:
              policy.naturalWake
          }
        });
        return;
      }

      runMode = basePlan.runMode;
      wakeReason =
        policy.wakeReason ||
        "ambient_activity";
      activePass =
        basePlan.activePass ?? null;
    }

    /* 第一道临门检查：正式调用模型前再看一次前台。 */
    const preModelGate =
      await residentRuntimeService
        .inspectBackgroundGate({
          userId
        });

    if (!preModelGate.allowed) {
      await recordSkip({
        heartService,
        userId,
        claimToken,
        scheduledFor,
        reason:
          "interaction_started_before_model",
        detail: preModelGate.reason,
        nextHeartbeatAt:
          resolveNextAfterInteraction(
            preModelGate.interaction,
            now
          ),
        metadata: {
          orchestrationMode:
            preModelGate.runtime
              .resolved?.mode ?? null,
          interactionChannel:
            preModelGate.interaction
              ?.channel ?? null
        }
      });
      return;
    }

    const envelope = buildWakeEnvelope({
      userId,
      wakeReason,
      runMode,
      settings: runtime.settings,
      freeActivityProgress:
        runtime.freeActivityProgress
    });

    setWakeEnvelope(envelope);

    writeLog(
      "info",
      "resident_model_activity_allowed",
      {
        ownerUserId: userId,
        wakeReason,
        runMode,
        inputTokenBudget:
          runtime.settings
            .heartbeatInputTokenBudget,
        maxOutputTokens:
          runtime.settings
            .heartbeatMaxOutputTokens,
        reasoningEffort:
          runtime.settings
            .heartbeatReasoningEffort,
        policyBudget:
          policy?.budget ?? null
      }
    );

    let result;

    try {
      result = await heartService.runOnce({
        userId,
        runMode,
        wakeKind: "scheduled",
        source: "worker",
        activityPassId:
          activePass?.id ?? null,
        scheduledFor,
        workerClaimToken:
          claimToken
      });
    } finally {
      setWakeEnvelope(null);
    }

    const sideEffects =
      await processResidentSideEffects({
        residentRuntimeService,
        serviceClient,
        userId,
        result,
        envelope
      });

    if (
      runMode === "free_activity" &&
      activePass?.id
    ) {
      await orchestrationService
        .recordActivityUsage({
          userId,
          activityPassId:
            activePass.id,
          inputTokens:
            result.run?.input_tokens ?? 0,
          outputTokens:
            result.run?.output_tokens ?? 0,
          estimatedCostUsd:
            result.run
              ?.estimated_cost_usd ?? 0,
          progressSummary:
            result.run?.result_summary ??
            result.decision?.reason ??
            null,
          progressData: {
            lastRunId:
              result.run?.id ?? null,
            lastDecision:
              result.decision?.action ?? null,
            lastWakeAt:
              new Date().toISOString()
          }
        });
    }

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
              wakeReason,
            workerVersion:
              WORKER_VERSION,
            residentMode: true,
            residentSideEffects:
              sideEffects,
            wakeContextEstimatedTokens:
              envelope.wakeContext
                ?.estimatedInputTokens ?? null,
            wakeContextMemoryIds:
              envelope.wakeContext
                ?.memories
                ?.map((item) => item.id) ?? []
          }
        });

    writeLog(
      "info",
      "resident_activity_completed",
      {
        ownerUserId: userId,
        runId:
          result.run?.id ?? null,
        decision:
          result.decision?.action ?? null,
        wakeReason,
        inputTokens:
          result.run?.input_tokens ?? 0,
        outputTokens:
          result.run?.output_tokens ?? 0,
        estimatedCostUsd:
          result.run
            ?.estimated_cost_usd ?? 0,
        sideEffects,
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
                WORKER_VERSION,
              residentMode: true
            }
          });
    } catch (releaseError) {
      writeLog(
        "error",
        "resident_claim_release_failed",
        {
          ownerUserId: userId,
          error:
            safeError(releaseError)
        }
      );
    }

    writeLog(
      "error",
      "resident_activity_failed",
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
  orchestrationService,
  residentRuntimeService,
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
      orchestrationService,
      residentRuntimeService,
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
      "resident_worker_disabled",
      {
        message:
          "HEART_WORKER_ENABLED 未开启，常住 Worker 安全退出。"
      }
    );
    return;
  }

  const serviceClient =
    createServiceClient(config);
  const orchestrationService =
    createHomeOrchestrationService({
      serviceClient
    });
  const heartbeatContextService =
    createHeartbeatContextService({
      serviceClient
    });
  const residentRuntimeService =
    createResidentRuntimeService({
      serviceClient,
      orchestrationService
    });

  let wakeEnvelope = null;
  const setWakeEnvelope = (value) => {
    wakeEnvelope = value;
  };

  const rawOpenAIClient =
    createRawOpenAIClient(config);
  const openaiClient =
    createResidentOpenAIClient({
      rawClient: rawOpenAIClient,
      heartbeatContextService,
      residentRuntimeService,
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
    "resident_worker_started",
    {
      mode:
        runOnce ? "once" : "continuous",
      architecture:
        "resident_home_foreground_priority",
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
      "resident_worker_stopping",
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
        orchestrationService,
        residentRuntimeService,
        setWakeEnvelope,
        config
      });
      const currentTime = Date.now();

      if (
        count === 0 &&
        currentTime - lastIdleLogAt >=
          600_000
      ) {
        writeLog(
          "info",
          "resident_worker_idle",
          {
            message:
              "家里暂时没有到期的后台观察。"
          }
        );
        lastIdleLogAt = currentTime;
      }
    } catch (error) {
      writeLog(
        "error",
        "resident_worker_cycle_failed",
        {
          error: safeError(error),
          hint:
            error?.code === "PGRST202"
              ? "请先运行心跳 Worker claim RPC 迁移"
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
    "resident_worker_stopped"
  );
}


main().catch((error) => {
  const knownError =
    error instanceof HeartServiceError ||
    error instanceof HeartPolicyError ||
    error instanceof HomeOrchestrationError;

  writeLog(
    "error",
    "resident_worker_boot_failed",
    {
      error: knownError
        ? {
            ...safeError(error),
            status: error.status
          }
        : safeError(error)
    }
  );

  process.exitCode = 1;
});
