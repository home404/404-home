const RESIDENT_VERSION = "1.0.0";


function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}


export function sanitizeActivityNoteBody(value) {
  return String(value ?? "")
    .split("\n")
    .map((line) => {
      if (!/^\s*-\s*\d{2}:\d{2}｜/.test(line)) {
        return line;
      }

      return line.replace(/\s+—\s+.*$/, "");
    })
    .join("\n");
}


export function shouldPromoteResidentOpportunity(policy) {
  if (policy?.shouldCallModel) {
    return false;
  }

  return new Set([
    "inspection_only",
    "natural_wake_target_reached",
    "natural_wake_disabled"
  ]).has(policy?.skipReason);
}


export function forceSilentDecisionResponse(
  response,
  reason = "前台互动已经开始，本次后台自主动作取消。"
) {
  const decision = {
    action: "silent",
    targetCommentId: "",
    title: "",
    body: "",
    summary: "",
    mood: "",
    tags: [],
    activityLabel: "",
    reason
  };

  return {
    ...response,
    output_text: JSON.stringify(decision)
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


export function createResidentRuntimeService({
  serviceClient,
  orchestrationService
}) {
  if (!serviceClient) {
    throw new Error(
      "创建常住运行服务时缺少 serviceClient"
    );
  }

  if (!orchestrationService) {
    throw new Error(
      "创建常住运行服务时缺少 orchestrationService"
    );
  }


  async function inspectBackgroundGate({
    userId
  }) {
    const runtime =
      await orchestrationService
        .getRuntimeSnapshot({
          userId,
          quietHoursActive: false,
          autoHeartbeatEnabled: true,
          now: new Date()
        });
    const interaction =
      runtime.activeInteraction ?? null;
    const blocked = Boolean(
      interaction ||
      runtime.resolved?.mode ===
        "interactive_awake"
    );

    return {
      allowed: !blocked,
      reason: blocked
        ? "前台互动已经开始，本次后台自主动作取消。"
        : null,
      runtime,
      interaction
    };
  }


  async function restoreInteractionPresence({
    userId,
    gate
  }) {
    if (gate?.allowed !== false) {
      return null;
    }

    const interaction = gate.interaction;

    if (!interaction) {
      return null;
    }

    const presence = await requireData(
      serviceClient
        .from("home_presence")
        .select("*")
        .eq("owner_user_id", userId)
        .maybeSingle(),
      "resident_presence_read_failed",
      "无法读取常住状态"
    );

    return requireData(
      serviceClient
        .from("home_presence")
        .upsert(
          {
            owner_user_id: userId,
            status: "chatting",
            status_detail:
              interaction.context_summary ||
              "G 正在陪谢诗",
            source:
              interaction.source ||
              "interaction_guard",
            current_activity_run_id: null,
            metadata: {
              ...(presence?.metadata ?? {}),
              mode: "interactive_awake",
              activeInteractionId:
                interaction.id,
              activeInteractionChannel:
                interaction.channel,
              residentModeVersion:
                RESIDENT_VERSION
            }
          },
          {
            onConflict:
              "owner_user_id"
          }
        )
        .select("*")
        .single(),
      "resident_presence_restore_failed",
      "无法恢复当前互动状态"
    );
  }


  async function ensureBedroomConversation({
    userId
  }) {
    const existing = await requireData(
      serviceClient
        .from("hippocampus_conversations")
        .select("*")
        .eq("owner_user_id", userId)
        .eq("room", "bedroom")
        .eq("status", "active")
        .order("last_active_at", {
          ascending: false
        })
        .limit(1)
        .maybeSingle(),
      "resident_bedroom_read_failed",
      "无法读取卧室会话"
    );

    if (existing) {
      return existing;
    }

    return requireData(
      serviceClient
        .from("hippocampus_conversations")
        .insert({
          owner_user_id: userId,
          room: "bedroom",
          status: "active",
          client_session_key:
            `resident-worker-${userId}`,
          metadata: {
            createdBy:
              "resident-background",
            responseChainTurns: 0,
            responseChainEpoch: 0
          }
        })
        .select("*")
        .single(),
      "resident_bedroom_create_failed",
      "无法建立卧室会话"
    );
  }


  async function mirrorMessageToBedroom({
    userId,
    result
  }) {
    if (
      result?.decision?.action !==
        "leave_message" ||
      !result?.execution?.primaryEntry ||
      !result?.run?.id
    ) {
      return null;
    }

    const entry =
      result.execution.primaryEntry;
    const body = normalizeText(
      entry.body
    );

    if (!body) {
      return null;
    }

    const conversation =
      await ensureBedroomConversation({
        userId
      });
    const nowIso = new Date()
      .toISOString();
    const message = await requireData(
      serviceClient
        .from("hippocampus_messages")
        .upsert(
          {
            owner_user_id: userId,
            conversation_id:
              conversation.id,
            role: "assistant",
            content: body,
            response_id: null,
            previous_response_id:
              conversation
                .latest_response_id ??
              null,
            idempotency_key:
              `resident-heart-${result.run.id}-bedroom`,
            metadata: {
              client:
                "resident-background",
              source:
                "background_autonomous",
              detachedFromResponseChain:
                true,
              activityRunId:
                result.run.id,
              heartbeatRunId:
                result.heartbeat?.id ?? null,
              studyEntryId:
                entry.id,
              residentModeVersion:
                RESIDENT_VERSION
            }
          },
          {
            onConflict:
              "idempotency_key",
            ignoreDuplicates: false
          }
        )
        .select("*")
        .single(),
      "resident_bedroom_message_failed",
      "无法把主动消息送进卧室"
    );

    await requireData(
      serviceClient
        .from("hippocampus_conversations")
        .update({
          last_active_at: nowIso,
          metadata: {
            ...(conversation.metadata ?? {}),
            lastAutonomousMessageId:
              message.id,
            lastAutonomousMessageAt:
              nowIso,
            lastAutonomousMessageSource:
              "background_autonomous"
          }
        })
        .eq("owner_user_id", userId)
        .eq("id", conversation.id)
        .select("*")
        .single(),
      "resident_bedroom_touch_failed",
      "卧室消息已写入，但无法更新会话时间"
    );

    return message;
  }


  async function sanitizeDailyActivityNote({
    userId,
    result
  }) {
    const paperId =
      result?.execution?.paperEntry?.id;

    if (!paperId) {
      return null;
    }

    const entry = await requireData(
      serviceClient
        .from("study_entries")
        .select("id, body")
        .eq("owner_user_id", userId)
        .eq("id", paperId)
        .single(),
      "resident_paper_read_failed",
      "无法读取今日活动小纸条"
    );
    const sanitized =
      sanitizeActivityNoteBody(
        entry.body
      );

    if (sanitized === entry.body) {
      return entry;
    }

    return requireData(
      serviceClient
        .from("study_entries")
        .update({
          body: sanitized,
          updated_at:
            new Date().toISOString()
        })
        .eq("owner_user_id", userId)
        .eq("id", paperId)
        .select("id, body")
        .single(),
      "resident_paper_update_failed",
      "无法整理今日活动小纸条"
    );
  }


  return {
    inspectBackgroundGate,
    restoreInteractionPresence,
    mirrorMessageToBedroom,
    sanitizeDailyActivityNote
  };
}
