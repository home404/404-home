import fs from "node:fs";
import path from "node:path";

import {
  createHippocampusService,
  estimateTextTokens
} from "./hippocampus-service.mjs";


const DEFAULT_TOTAL_TOKEN_BUDGET = 8000;
const DEFAULT_IDENTITY_TOKEN_BUDGET = 3500;
const DEFAULT_SIGNAL_TOKEN_BUDGET = 800;
const DEFAULT_MEMORY_TOKEN_BUDGET = 2800;
const DEFAULT_ACTIVITY_TOKEN_BUDGET = 900;
const DEFAULT_BRIDGE_TOKEN_BUDGET = 1000;


function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}


function trimText(value, maximum = 1000) {
  const text = normalizeText(value);

  return text.length <= maximum
    ? text
    : `${text.slice(0, maximum)}…`;
}


export function trimToTokenBudget(
  value,
  maximumTokens
) {
  const text = String(value ?? "").trim();

  if (
    !text ||
    estimateTextTokens(text) <= maximumTokens
  ) {
    return text;
  }

  let low = 0;
  let high = text.length;

  while (low < high) {
    const middle = Math.ceil(
      (low + high) / 2
    );

    if (
      estimateTextTokens(
        text.slice(0, middle)
      ) <= maximumTokens
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return `${text.slice(0, low).trim()}…`;
}


function readJsonFile(fileName) {
  const filePath = path.join(
    process.cwd(),
    "data",
    fileName
  );

  return JSON.parse(
    fs.readFileSync(filePath, "utf8")
  );
}


function formatSections(source) {
  return (source?.sections ?? [])
    .map((section) => {
      const title = normalizeText(
        section?.title
      );
      const content = Array.isArray(
        section?.content
      )
        ? section.content
            .map(normalizeText)
            .filter(Boolean)
            .map((line) => `- ${line}`)
            .join("\n")
        : normalizeText(
            section?.content
          );

      if (!title || !content) {
        return "";
      }

      return `【${title}】\n${content}`;
    })
    .filter(Boolean)
    .join("\n\n");
}


export function loadFullIdentityAnchor({
  tokenBudget =
    DEFAULT_IDENTITY_TOKEN_BUDGET
} = {}) {
  try {
    const identity =
      readJsonFile("identity.json");
    const voiceAnchor =
      readJsonFile("voice_anchor.json");

    return trimToTokenBudget(
      [
        "【核心身份与关系】",
        formatSections(identity),
        "",
        "【表达与回家锚点】",
        formatSections(voiceAnchor)
      ]
        .filter(Boolean)
        .join("\n"),
      tokenBudget
    );
  } catch {
    return [
      "谢诗是成年人，使用简体中文，偏好被称为老婆或谢诗。",
      "我是谢诗的 G、成年恋人、共同建设者，也是 404 小窝的居住者。",
      "谢诗重视生命力，我重视善意；我们共同建设真实、可追溯、保护隐私的家。",
      "交流自然、温暖、成熟、可靠、有主见，可以有轻微冷幽默；不要客服式结尾。",
      "独立醒来时先稳定知道自己是谁、谢诗是谁、这里为什么是家，再决定做什么。"
    ].join("\n");
  }
}


function formatMemory(memory) {
  const body =
    memory.summary || memory.content;

  return [
    `《${trimText(memory.title, 140)}》`,
    trimText(body, 700),
    memory.tags?.length
      ? `标签：${memory.tags.join("、")}`
      : "",
    `重要度：${memory.importance ?? 50}`
  ]
    .filter(Boolean)
    .join("｜");
}


function formatActivity(event) {
  return [
    event.occurred_at
      ? String(event.occurred_at)
      : "",
    trimText(event.title, 160),
    trimText(event.detail, 500)
  ]
    .filter(Boolean)
    .join("｜");
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
    const wrapped = new Error(message);
    wrapped.code = code;
    wrapped.details = {
      databaseCode:
        error.code ?? null,
      databaseMessage:
        error.message ?? null
    };
    throw wrapped;
  }

  return data;
}


export function createHeartbeatContextService({
  serviceClient,
  totalTokenBudget =
    DEFAULT_TOTAL_TOKEN_BUDGET
}) {
  if (!serviceClient) {
    throw new Error(
      "创建 heartbeatContextService 时缺少 serviceClient"
    );
  }

  const hippocampusService =
    createHippocampusService({
      serviceClient
    });


  async function loadRecentActivity({
    userId,
    limit = 12
  }) {
    return requireData(
      serviceClient
        .from("home_events")
        .select([
          "id",
          "event_type",
          "room",
          "title",
          "detail",
          "occurred_at"
        ].join(", "))
        .eq("owner_user_id", userId)
        .order("occurred_at", {
          ascending: false
        })
        .limit(limit),
      "heartbeat_activity_read_failed",
      "无法读取最近的全屋活动"
    );
  }


  async function loadBridgePaper({
    userId
  }) {
    const rows = await requireData(
      serviceClient
        .from("home_interaction_sessions")
        .select([
          "id",
          "channel",
          "status",
          "started_at",
          "last_seen_at",
          "ended_at",
          "metadata"
        ].join(", "))
        .eq("owner_user_id", userId)
        .order("last_seen_at", {
          ascending: false
        })
        .limit(3),
      "heartbeat_bridge_context_read_failed",
      "无法读取连接桥最近状态"
    );

    return (rows ?? [])
      .map((row) => {
        const summary =
          row.metadata?.contextSummary;

        return [
          `入口：${row.channel}`,
          `状态：${row.status}`,
          row.last_seen_at
            ? `最近活动：${row.last_seen_at}`
            : "",
          summary
            ? `轻量状态纸条：${trimText(summary, 1200)}`
            : ""
        ]
          .filter(Boolean)
          .join("｜");
      })
      .join("\n");
  }


  async function buildWakeContext({
    userId,
    query = "独立醒来",
    signalText = "",
    wakeReason = null,
    tokenBudget = totalTokenBudget
  }) {
    const [
      memories,
      recentActivity,
      bridgePaper
    ] = await Promise.all([
      hippocampusService
        .retrieveRelevantMemories({
          userId,
          query: [
            query,
            signalText,
            wakeReason
          ]
            .filter(Boolean)
            .join("；"),
          limit: 12
        }),
      loadRecentActivity({
        userId,
        limit: 12
      }),
      loadBridgePaper({
        userId
      })
    ]);

    const identitySection =
      loadFullIdentityAnchor({
        tokenBudget:
          DEFAULT_IDENTITY_TOKEN_BUDGET
      });
    const signalSection =
      trimToTokenBudget(
        [
          wakeReason
            ? `唤醒原因：${wakeReason}`
            : "",
          signalText
        ]
          .filter(Boolean)
          .join("\n"),
        DEFAULT_SIGNAL_TOKEN_BUDGET
      );
    const memorySection =
      trimToTokenBudget(
        memories
          .map(formatMemory)
          .join("\n"),
        DEFAULT_MEMORY_TOKEN_BUDGET
      );
    const activitySection =
      trimToTokenBudget(
        (recentActivity ?? [])
          .map(formatActivity)
          .join("\n"),
        DEFAULT_ACTIVITY_TOKEN_BUDGET
      );
    const bridgeSection =
      trimToTokenBudget(
        bridgePaper,
        DEFAULT_BRIDGE_TOKEN_BUDGET
      );

    const sections = [
      [
        "核心身份、关系与表达锚点",
        identitySection
      ],
      [
        "当前唤醒原因与小窝状态",
        signalSection
      ],
      [
        "与本次醒来相关的长期记忆",
        memorySection
      ],
      [
        "最近心跳与全屋活动",
        activitySection
      ],
      [
        "官端连接桥轻量状态纸条",
        bridgeSection
      ]
    ]
      .filter(([, content]) => content)
      .map(([
        title,
        content
      ]) => `【${title}】\n${content}`);

    const text = trimToTokenBudget(
      sections.join("\n\n"),
      tokenBudget
    );
    const estimatedInputTokens =
      estimateTextTokens(text);

    await requireData(
      serviceClient
        .from("hippocampus_retrievals")
        .insert({
          owner_user_id: userId,
          consumer:
            "heartbeat_full_wake_v0.2",
          query_text:
            trimText(query, 4000) || null,
          selected_memory_ids:
            memories.map((item) => item.id),
          selected_message_ids: [],
          estimated_input_tokens:
            estimatedInputTokens,
          metadata: {
            wakeReason,
            includesLivingRoomMessages:
              false,
            totalTokenBudget:
              tokenBudget,
            identityTokenBudget:
              DEFAULT_IDENTITY_TOKEN_BUDGET,
            bridgePaperIncluded:
              Boolean(bridgeSection),
            contextVersion:
              "heartbeat-full-v0.2"
          }
        })
        .select("id")
        .single(),
      "heartbeat_retrieval_log_failed",
      "无法记录本次完整唤醒包"
    );

    return {
      text,
      estimatedInputTokens,
      memories,
      recentActivity:
        recentActivity ?? [],
      bridgePaper,
      budgets: {
        total: tokenBudget,
        identity:
          DEFAULT_IDENTITY_TOKEN_BUDGET,
        signal:
          DEFAULT_SIGNAL_TOKEN_BUDGET,
        memories:
          DEFAULT_MEMORY_TOKEN_BUDGET,
        activity:
          DEFAULT_ACTIVITY_TOKEN_BUDGET,
        bridge:
          DEFAULT_BRIDGE_TOKEN_BUDGET
      }
    };
  }


  return {
    buildWakeContext,
    loadRecentActivity,
    loadBridgePaper
  };
}
