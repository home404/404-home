import {
  HomeOrchestrationError
} from "./home-orchestration-service.mjs";


function normalizeText(
  value,
  maximum = 100_000
) {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
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


export function estimateSolCost({
  inputTokens = 0,
  outputTokens = 0
}) {
  const input = Math.max(
    0,
    Number(inputTokens) || 0
  );
  const output = Math.max(
    0,
    Number(outputTokens) || 0
  );

  return Number((
    input * 5 / 1_000_000 +
    output * 30 / 1_000_000
  ).toFixed(6));
}


function formatMessage(message) {
  const speaker =
    message.role === "user"
      ? "谢诗"
      : message.role === "assistant"
        ? "G"
        : message.role;

  return `${speaker}：${normalizeText(
    message.content,
    4000
  )}`;
}


export function createBedroomSummaryService({
  serviceClient,
  openaiClient,
  model = "gpt-5.6-sol"
}) {
  if (!serviceClient) {
    throw new Error(
      "创建 bedroomSummaryService 时缺少 serviceClient"
    );
  }

  if (!openaiClient) {
    throw new Error(
      "创建 bedroomSummaryService 时缺少 openaiClient"
    );
  }


  async function createSegmentSummary({
    userId,
    conversationId
  }) {
    const conversation = await requireData(
      serviceClient
        .from("hippocampus_conversations")
        .select("*")
        .eq("owner_user_id", userId)
        .eq("id", conversationId)
        .single(),
      "bedroom_conversation_read_failed",
      "无法读取卧室会话"
    );

    if (conversation.room !== "bedroom") {
      throw new HomeOrchestrationError(
        "bedroom_conversation_room_mismatch",
        "这不是卧室里的会话，不能生成卧室小纸条。",
        400,
        {
          room: conversation.room
        }
      );
    }

    const rows = await requireData(
      serviceClient
        .from("hippocampus_messages")
        .select([
          "id",
          "role",
          "content",
          "occurred_at"
        ].join(", "))
        .eq("owner_user_id", userId)
        .eq(
          "conversation_id",
          conversationId
        )
        .in("role", [
          "user",
          "assistant"
        ])
        .order("occurred_at", {
          ascending: false
        })
        .limit(80),
      "bedroom_summary_messages_read_failed",
      "无法读取要整理的卧室原文"
    );

    const messages = [
      ...(rows ?? [])
    ].reverse();

    if (messages.length < 4) {
      throw new HomeOrchestrationError(
        "bedroom_summary_too_short",
        "这段卧室聊天还太短，不需要写小纸条。",
        400
      );
    }

    const epoch = Math.max(
      0,
      Math.round(Number(
        conversation.metadata
          ?.responseChainEpoch ?? 0
      ) || 0)
    );
    const turnCount = Math.max(
      0,
      Math.round(Number(
        conversation.metadata
          ?.responseChainTurns ?? 0
      ) || 0)
    );
    const idempotencyKey =
      `bedroom-segment-${conversationId}-${epoch}`;

    const response =
      await openaiClient.responses.create({
        model,
        reasoning: {
          effort: "low"
        },
        max_output_tokens: 4000,
        input: [
          {
            role: "system",
            content: [
              "你正在为 404 小窝的卧室聊天生成一张内部小纸条。",
              "目标是在后续切换 response 链时保住连续性，不是写文学总结。",
              "请使用简体中文，控制在 500～1200 个汉字。",
              "必须保留：当前主题、重要决定、未完成事项、人物与因果、情绪状态、下一步。",
              "不得编造，不要逐句复述，不要写客套开场，不要把普通闲聊夸成重大事件。",
              "涉及项目施工时保留具体文件、参数、状态和谁决定了什么。",
              "输出纯文本，使用短标题和自然段即可。"
            ].join("\n")
          },
          {
            role: "user",
            content: [
              `会话轮数：${turnCount}`,
              `链段编号：${epoch}`,
              "",
              ...messages.map(formatMessage)
            ].join("\n\n")
          }
        ]
      });

    const summary = normalizeText(
      response.output_text,
      20_000
    );

    if (!summary) {
      throw new HomeOrchestrationError(
        "bedroom_summary_empty",
        "模型没有写出卧室小纸条",
        502
      );
    }

    const usage = {
      inputTokens:
        response.usage?.input_tokens ?? 0,
      outputTokens:
        response.usage?.output_tokens ?? 0,
      totalTokens:
        response.usage?.total_tokens ?? 0,
      reasoningTokens:
        response.usage
          ?.output_tokens_details
          ?.reasoning_tokens ?? 0
    };
    const estimatedCostUsd =
      estimateSolCost({
        inputTokens: usage.inputTokens,
        outputTokens:
          usage.outputTokens
      });
    const nowIso = new Date().toISOString();

    const existingMemory = await requireData(
      serviceClient
        .from("hippocampus_memories")
        .select("id")
        .eq("owner_user_id", userId)
        .eq(
          "idempotency_key",
          idempotencyKey
        )
        .maybeSingle(),
      "bedroom_summary_memory_lookup_failed",
      "无法检查卧室小纸条是否已经存在"
    );

    const memoryPayload = {
      owner_user_id: userId,
      memory_type: "recent_summary",
      title:
        `卧室聊天小纸条 · 第 ${epoch + 1} 段`,
      content: summary,
      summary:
        normalizeText(summary, 1000),
      tags: [
        "卧室",
        "聊天摘要",
        "小纸条"
      ],
      importance: 78,
      source_type: "conversation",
      source_id: conversationId,
      source_ref: {
        conversationId,
        responseChainEpoch: epoch,
        responseChainTurns: turnCount,
        messageCount: messages.length
      },
      occurred_at: nowIso,
      is_active: true,
      idempotency_key:
        idempotencyKey,
      metadata: {
        generatedBy:
          "bedroom-summary-v0.1",
        model,
        usage,
        estimatedCostUsd
      }
    };

    const memory = existingMemory
      ? await requireData(
          serviceClient
            .from("hippocampus_memories")
            .update(memoryPayload)
            .eq("owner_user_id", userId)
            .eq("id", existingMemory.id)
            .select("*")
            .single(),
          "bedroom_summary_memory_update_failed",
          "无法更新卧室小纸条"
        )
      : await requireData(
          serviceClient
            .from("hippocampus_memories")
            .insert(memoryPayload)
            .select("*")
            .single(),
          "bedroom_summary_memory_create_failed",
          "无法保存卧室小纸条"
        );

    const nextMetadata = {
      ...(conversation.metadata ?? {}),
      segmentSummaryId: memory.id,
      segmentSummaryText: summary,
      segmentSummaryAtTurn: turnCount,
      segmentSummaryEpoch: epoch,
      segmentSummaryGeneratedAt:
        nowIso
    };

    const updatedConversation =
      await requireData(
        serviceClient
          .from("hippocampus_conversations")
          .update({
            metadata: nextMetadata,
            last_active_at: nowIso
          })
          .eq("owner_user_id", userId)
          .eq("id", conversationId)
          .select("*")
          .single(),
        "bedroom_summary_conversation_update_failed",
        "小纸条已生成，但无法写回卧室会话"
      );

    const {
      error: eventError
    } = await serviceClient
      .from("home_events")
      .insert({
        owner_user_id: userId,
        actor: "g",
        source: "bedroom_v2",
        event_type:
          "bedroom_segment_summary_created",
        room: "bedroom",
        title:
          "整理了一张卧室聊天小纸条",
        detail:
          `第 ${epoch + 1} 段 · ${messages.length} 条原文`,
        visibility: "home_private",
        is_user_visible: true,
        metadata: {
          conversationId,
          memoryId: memory.id,
          usage,
          estimatedCostUsd
        }
      });

    if (eventError) {
      console.warn(
        "记录卧室小纸条事件失败：",
        eventError.message
      );
    }

    return {
      summary,
      memory,
      conversation:
        updatedConversation,
      usage,
      estimatedCostUsd
    };
  }


  return {
    createSegmentSummary
  };
}
