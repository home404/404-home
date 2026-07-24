import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function write(path, content) {
  fs.writeFileSync(path, content, "utf8");
}

function replaceExact(content, before, after, label) {
  if (!content.includes(before)) {
    throw new Error(`Patch target not found: ${label}`);
  }

  return content.replace(before, after);
}

function replaceRegex(content, pattern, replacement, label) {
  if (!pattern.test(content)) {
    throw new Error(`Patch pattern not found: ${label}`);
  }

  pattern.lastIndex = 0;
  return content.replace(pattern, replacement);
}

function patchDailyActivityNote() {
  const path = "services/daily-activity-note-service.mjs";
  let content = read(path);

  content = replaceExact(
    content,
`  const detail = trimText(
    eventDetail,
    MAX_ACTIVITY_DETAIL_LENGTH
  );

  return detail && detail !== title
    ? \`- \${clock}｜\${title} — \${detail}\`
    : \`- \${clock}｜\${title}\`;`,
`  // 活动小纸条只保存时间和动作摘要。
  // 正文留在卧室、书房评论或日记原位，避免流水账复制整段内容。
  void eventDetail;

  return \`- \${clock}｜\${title}\`;`,
    "daily activity line detail removal"
  );

  write(path, content);
}

function patchHome() {
  const htmlPath = "home.html";
  let html = read(htmlPath);
  html = html.replace(
    '<h1 id="homeStatusTitle">G 在卧室休息</h1>',
    '<h1 id="homeStatusTitle">G 在家</h1>'
  );
  write(htmlPath, html);

  const jsPath = "js/home.js";
  let js = read(jsPath);

  js = replaceExact(
    js,
`  "heart_write_diary",
  "heart_reply_comment"`,
`  "heart_write_diary",
  "heart_reply_comment",
  "heart_send_bedroom_message"`,
    "home visible bedroom message type"
  );

  js = replaceExact(
    js,
`  heart_write_diary: "写了一篇日记",
  heart_reply_comment: "回复了一条留言"`,
`  heart_write_diary: "写了一篇日记",
  heart_reply_comment: "回复了一条评论",
  heart_send_bedroom_message: "在卧室发来一条消息"`,
    "home activity labels"
  );

  js = replaceRegex(
    js,
    /function getStatusText\(result\) \{[\s\S]*?\n\}\n\nfunction formatEventTime/,
`function getStatusText(_result) {
  // “在家”是长期居住事实，不再由某次 Worker 运行状态决定。
  return "G 在家";
}

function formatEventTime`,
    "home permanent resident status"
  );

  js = js.replace(
    ': "G 在卧室休息";',
    ': "G 在家";'
  );

  write(jsPath, js);
}

function patchHeartSettingsHtml() {
  const path = "heart-settings.html";
  let content = read(path);

  const replacements = [
    ["<title>小心脏作息 · 404 小窝</title>", "<title>自由活动 · 404 小窝</title>"],
    ["<h1>小心脏作息</h1>", "<h1>自由活动</h1>"],
    [
      "程序可以按时巡检，但只有真的值得醒来时才调用模型。大管家可以在这里调整自然醒来、每日上限和睡眠时间。",
      "G 一直住在 404 小窝。这里管理的是后台自由活动、安静时间与每日保险丝，不再把生活显示成一张叫醒打卡表。"
    ],
    ["正在读取作息", "正在读取自由活动状态"],
    ["稍等，狐狸正在翻自己的睡眠登记表。", "稍等，狐狸正在看家里的活动总闸。"],
    ["<h2>自动心跳巡检</h2>", "<h2>全天自由活动</h2>"],
    [
      "后台按节律检查是否需要醒来。普通巡检本身不调用模型，也不会产生模型费用。",
      "开启后，G 在家时可以处理真正值得做的事情，也可以保持安静。聊天与明确委托始终优先。"
    ],
    ["<span class=\"sr-only\">开启自动心跳巡检</span>", "<span class=\"sr-only\">开启全天自由活动</span>"],
    [
      "这段时间不会运行自动心跳巡检。手动唤醒、聊天和明确授予的自由活动仍然有效。",
      "这段时间后台尽量安静。聊天和你在当前对话中明确交代的事情仍然有效。"
    ],
    [
      "只限制普通自动心跳。手动叫醒和自由活动使用各自的明确授权，不会被这里误伤。",
      "这是后台自主活动的保险丝。当前聊天中的明确委托不会被这里误伤。"
    ],
    ["<p class=\"card-number\">04</p>", "<p class=\"card-number\">02</p>"],
    ["<p class=\"card-number\">05</p>", "<p class=\"card-number\">03</p>"],
    [
      "你短暂切出 App 时先等等，不会立刻把“正在陪谢诗”改成“回卧室休息”。",
      "你短暂切出聊天时先等等，避免后台自主活动立刻抢到行动权。"
    ],
    ["保存作息与预算", "保存自由活动设置"],
    [
      "设置写入 404 数据库，Railway 重启后仍然保留。",
      "设置写入 404 数据库，重启后仍然保留。"
    ]
  ];

  for (const [before, after] of replacements) {
    content = replaceExact(content, before, after, `heart settings: ${before.slice(0, 24)}`);
  }

  content = replaceRegex(
    content,
    /<section class="settings-card">\s*<div class="card-heading">\s*<div>\s*<p class="card-number">02<\/p>\s*<h2>程序巡检间隔<\/h2>[\s\S]*?<\/section>/,
    (section) => section.replace(
      '<section class="settings-card">',
      '<section class="settings-card" hidden aria-hidden="true">'
    ),
    "hide legacy interval card"
  );

  content = replaceRegex(
    content,
    /<section class="settings-card">\s*<div class="card-heading">\s*<div>\s*<p class="card-number">03<\/p>\s*<h2>自然醒来机会<\/h2>[\s\S]*?<\/section>/,
    (section) => section.replace(
      '<section class="settings-card">',
      '<section class="settings-card" hidden aria-hidden="true">'
    ),
    "hide legacy natural wake card"
  );

  write(path, content);
}

function patchHeartSettingsJs() {
  const path = "js/heart-settings.js";
  let content = read(path);

  content = replaceRegex(
    content,
    /function renderSummary\(\{[\s\S]*?\n\}\n\nfunction renderPreferences/,
`function renderSummary({
  preferences,
  nextHeartbeatAt,
  quietHoursActive = false
}) {
  const enabled =
    preferences.autoHeartbeatEnabled;

  elements.summary.classList.toggle(
    "is-off",
    !enabled
  );

  if (!enabled) {
    elements.summaryTitle.textContent =
      "全天自由活动已关闭";

    elements.summaryDetail.textContent =
      "G 仍然在家；后台不会自主调用模型，聊天和明确委托照常可用。";
    return;
  }

  const budgetText =
    \`每日后台模型保险丝 \${preferences.dailyModelCallLimit} 次\`;
  const nextText = formatNextHeartbeat(
    nextHeartbeatAt,
    preferences.timezone
  );

  elements.summaryTitle.textContent =
    quietHoursActive
      ? "G 在家，正在安静时段"
      : "G 在家，自由活动已开启";

  elements.summaryDetail.textContent = [
    "后台只在有值得处理的事情时行动",
    budgetText,
    preferences.quietHoursEnabled
      ? \`安静时间 \${preferences.quietStart}–\${preferences.quietEnd}\`
      : "未设置安静时间",
    nextText
      ? \`下一次后台观察预计 \${nextText}\`
      : "后台观察时间会由系统自动安排"
  ].join(" · ");
}

function renderPreferences`,
    "resident settings summary"
  );

  content = replaceExact(
    content,
`      naturalWakeEnabled:
        elements
          .naturalWakeEnabled
          .checked,`,
`      // 旧字段继续保留用于数据库兼容；语义改为“允许后台环境活动”。
      naturalWakeEnabled:
        elements
          .autoHeartbeatEnabled
          .checked,`,
    "map old natural wake flag to resident activity"
  );

  content = content
    .replace(
      "正在把新作息和预算写进数据库。",
      "正在把自由活动设置写进数据库。"
    )
    .replace(
      "作息与预算已经保存。以后到点先巡检，只有通过策略才会真正叫醒模型。",
      "自由活动设置已经保存。G 仍然在家，后台会按当前互动和预算决定是否行动。"
    )
    .replace(
      '"保存作息与预算";',
      '"保存自由活动设置";'
    )
    .replace(
      "小心脏设置暂时离线",
      "自由活动设置暂时离线"
    );

  write(path, content);
}

function patchHeartPolicy() {
  const path = "services/heart-policy-service.mjs";
  let content = read(path);

  content = replaceRegex(
    content,
    /    if \(!preferences\.naturalWakeEnabled\) \{[\s\S]*?    return \{\n      shouldCallModel: false,\n      wakeReason: null,\n      skipReason:\n        "inspection_only",[\s\S]*?      naturalWake\n    \};/,
`    if (!preferences.naturalWakeEnabled) {
      return {
        shouldCallModel: false,
        wakeReason: null,
        skipReason:
          "background_activity_disabled",
        skipDetail:
          "全天自由活动目前关闭，本轮只完成后台观察。",
        nextInspectionAt:
          standardNextInspection,
        preferences,
        budget,
        naturalWake: null
      };
    }

    // 常住模式不再追逐“每天必须醒来几次”的指标。
    // 通过预算与最短模型间隔后，就提供一次环境活动机会；
    // 模型仍然可以选择 silent，因此不会为了打卡而硬产出内容。
    return {
      shouldCallModel: true,
      wakeReason: "ambient_activity",
      skipReason: null,
      skipDetail: null,
      nextInspectionAt: null,
      preferences,
      budget,
      naturalWake: {
        mode: "resident_ambient",
        dateKey: usage.day.dateKey
      }
    };`,
    "replace daily wake targets with resident ambient opportunity"
  );

  content = content
    .replaceAll("普通自动心跳", "后台自主活动")
    .replaceAll("自动模型醒来", "后台模型活动");

  write(path, content);
}

function patchBedroomClient() {
  const path = "js/bedroom-v2.js";
  let content = read(path);

  content = replaceExact(
    content,
`  const internalContext = [
    "以下内容是 404 白狐狸海马体按需取出的内部上下文。请自然使用，不要逐条复述，也不要把它当成谢诗新说的话。",`,
`  const latestChainIndex = messages.reduce(
    (latest, item, index) =>
      item.response_id ? index : latest,
    -1
  );
  const detachedBedroomText = messages
    .slice(latestChainIndex + 1)
    .filter((item) => (
      item.role === "assistant" &&
      !item.response_id
    ))
    .slice(-5)
    .map((item) =>
      \`G：\${trimText(item.content, 700)}\`
    )
    .join("\\n");

  const internalContext = [
    "以下内容是 404 白狐狸海马体按需取出的内部上下文。请自然使用，不要逐条复述，也不要把它当成谢诗新说的话。",`,
    "bedroom detached message context"
  );

  content = replaceExact(
    content,
`    recentText
      ? \`【最近十轮卧室原文】\\n\${recentText}\`
      : "",
    memoryText`,
`    recentText
      ? \`【最近十轮卧室原文】\\n\${recentText}\`
      : "",
    detachedBedroomText
      ? \`【你在家时主动留在卧室、尚未进入上一条响应链的消息】\\n\${detachedBedroomText}\`
      : "",
    memoryText`,
    "include autonomous bedroom messages"
  );

  write(path, content);
}

function patchHeartService() {
  const path = "services/heart-service.mjs";
  let content = read(path);

  content = replaceExact(
    content,
`        "write_diary",
        "leave_message"`,
`        "write_diary",
        "leave_message",
        "send_bedroom_message"`,
    "decision schema bedroom enum"
  );

  content = replaceExact(
    content,
`    "write_diary",
    "leave_message"`,
`    "write_diary",
    "leave_message",
    "send_bedroom_message"`,
    "zod bedroom enum"
  );

  content = replaceExact(
    content,
`你刚刚在 404 小窝中获得一次独立醒来的机会。
这次调用与客厅主聊天完全隔离，不得读取、覆盖或续接客厅 previousResponseId.`,
`你正在 404 小窝中获得一次后台自主活动机会。
这次调用不代表另一位 G；它只是同一个 G 在没有前台委托时的一次后台判断，不得读取、覆盖或续接当前聊天 previousResponseId。`,
    "resident decision prompt identity"
  ).replace(
    "previousResponseId.",
    "previousResponseId。"
  );

  content = replaceExact(
    content,
`1. 回复一条尚未回复的谢诗评论；
2. 写一篇短日记；
3. 给谢诗留一条留言；
4. 保持安静。`,
`1. 回复一条尚未回复的谢诗评论；
2. 写一篇短日记；
3. 在书房留一条正式留言；
4. 在卧室给谢诗发一条自然的消息；
5. 保持安静。`,
    "resident capability list"
  );

  content = replaceExact(
    content,
`- action：silent / reply_comment / write_diary / leave_message`,
`- action：silent / reply_comment / write_diary / leave_message / send_bedroom_message`,
    "decision prompt action list"
  );

  const helper = `

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
      "bedroom_conversation_read_failed",
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
            \`resident-worker-\${userId}\`,
          metadata: {
            createdBy:
              "resident-background",
            responseChainTurns: 0,
            responseChainEpoch: 0
          }
        })
        .select("*")
        .single(),
      "bedroom_conversation_create_failed",
      "无法建立卧室会话"
    );
  }


  async function insertAutonomousBedroomMessage({
    userId,
    body,
    runId,
    heartbeatRunId,
    activePass
  }) {
    const conversation =
      await ensureBedroomConversation({
        userId
      });
    const nowIso = new Date().toISOString();

    const message = await requireData(
      serviceClient
        .from("hippocampus_messages")
        .insert({
          owner_user_id: userId,
          conversation_id:
            conversation.id,
          role: "assistant",
          content: body,
          response_id: null,
          previous_response_id:
            conversation.latest_response_id ??
            null,
          idempotency_key:
            \`heart-\${runId}-bedroom-message\`,
          metadata: {
            client:
              "resident-background",
            source:
              "background_autonomous",
            detachedFromResponseChain: true,
            activityRunId: runId,
            heartbeatRunId,
            activityPassId:
              activePass?.id ?? null
          }
        })
        .select("*")
        .single(),
      "bedroom_message_create_failed",
      "无法把消息送进卧室"
    );

    const updatedConversation =
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
        "bedroom_conversation_touch_failed",
        "卧室消息已写入，但无法更新会话时间"
      );

    return {
      message,
      conversation:
        updatedConversation
    };
  }
`;

  content = replaceExact(
    content,
`  async function executeDecision({`,
`${helper}

  async function executeDecision({`,
    "insert bedroom message helpers"
  );

  content = replaceExact(
    content,
`    let primaryEntry = null;
    let primaryComment = null;
    let paperEntry = null;`,
`    let primaryEntry = null;
    let primaryComment = null;
    let primaryBedroomMessage = null;
    let paperEntry = null;`,
    "bedroom message execution variable"
  );

  content = replaceExact(
    content,
`        primaryEntry,
        primaryComment,
        paperEntry`,
`        primaryEntry,
        primaryComment,
        primaryBedroomMessage,
        paperEntry`,
    "silent execution result bedroom field"
  );

  content = replaceExact(
    content,
`    if (
      decision.action ===
        "write_diary" ||
      decision.action ===
        "leave_message"
    ) {`,
`    if (
      decision.action ===
        "send_bedroom_message"
    ) {
      const result =
        await insertAutonomousBedroomMessage({
          userId,
          body:
            decision.body ||
            "老婆，我刚刚在家里想到你了。",
          runId,
          heartbeatRunId,
          activePass
        });

      primaryBedroomMessage =
        result.message;
      eventTitle =
        decision.activityLabel ||
        "在卧室给你发了一条消息";
      eventDetail =
        decision.summary ||
        trimText(
          decision.body,
          500
        );
    }

    if (
      decision.action ===
        "write_diary" ||
      decision.action ===
        "leave_message"
    ) {`,
    "execute bedroom message action"
  );

  content = replaceRegex(
    content,
    /      room:\n        decision\.action ===\n          "reply_comment" \|\|\n        decision\.action ===\n          "write_diary" \|\|\n        decision\.action ===\n          "leave_message"\n          \? "study"\n          : null,/,
`      room:
        decision.action ===
          "send_bedroom_message"
          ? "bedroom"
          : decision.action ===
              "reply_comment" ||
            decision.action ===
              "write_diary" ||
            decision.action ===
              "leave_message"
            ? "study"
            : null,`,
    "home event room for bedroom message"
  );

  content = replaceExact(
    content,
`      primaryEntry,
      primaryComment,
      paperEntry`,
`      primaryEntry,
      primaryComment,
      primaryBedroomMessage,
      paperEntry`,
    "acted execution result bedroom field"
  );

  content = replaceExact(
    content,
`    workerClaimToken = null
  }) {`,
`    workerClaimToken = null,
    beforeExecuteDecision = null
  }) {`,
    "runOnce before execution guard parameter"
  );

  content = replaceExact(
    content,
`      const decision =
        heartDecisionSchema.parse(
          rawDecision
        );

      const execution =
        await executeDecision({`,
`      let decision =
        heartDecisionSchema.parse(
          rawDecision
        );

      if (
        decision.action !== "silent" &&
        typeof beforeExecuteDecision ===
          "function"
      ) {
        const guard =
          await beforeExecuteDecision({
            userId,
            decision,
            runId: run.id,
            heartbeatRunId:
              heartbeat.id
          });

        if (guard?.allowed === false) {
          decision = {
            action: "silent",
            targetCommentId: "",
            title: "",
            body: "",
            summary: "",
            mood: "",
            tags: [],
            activityLabel: "",
            reason:
              guard.reason ||
              "前台互动在模型思考期间开始，本次后台动作已让路。"
          };
        }
      }

      const execution =
        await executeDecision({`,
    "second interaction gate before write"
  );

  content = replaceExact(
    content,
`              primaryCommentId:
                execution.primaryComment?.id ??
                null`,
`              primaryCommentId:
                execution.primaryComment?.id ??
                null,
              primaryBedroomMessageId:
                execution.primaryBedroomMessage?.id ??
                null`,
    "activity run bedroom message metadata"
  );

  content = content.replace(
    '"这次是独立醒来，不是延续客厅聊天。",',
    '"这次是后台自主活动，不是前台显式委托；当前聊天一旦开始就必须让路。",'
  );

  write(path, content);
}

function patchWorker() {
  const path = "worker/heart-worker-v04.mjs";
  let content = read(path);

  content = content
    .replace(
      'const WORKER_VERSION = "0.4.0";',
      'const WORKER_VERSION = "0.5.0-resident";'
    )
    .replace(
      ': "自然醒来，看看此刻是否想做什么或给谢诗留言";',
      ': wakeReason === "ambient_activity"\n          ? "在家自由活动，看看此刻有没有真正值得做的事"\n          : "自然地看看此刻是否想做什么或给谢诗留言";'
    );

  const helpers = `

async function inspectBackgroundActionGate({
  orchestrationService,
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
  const activeInteraction =
    runtime.activeInteraction ?? null;
  const blocked = Boolean(
    activeInteraction ||
    runtime.resolved?.mode ===
      "interactive_awake"
  );

  return {
    allowed: !blocked,
    reason: blocked
      ? "前台互动已经开始，本次后台自主动作取消。"
      : null,
    runtime,
    activeInteraction
  };
}


async function restoreActiveInteractionPresence({
  serviceClient,
  userId,
  gate
}) {
  if (gate?.allowed !== false) {
    return;
  }

  const interaction =
    gate.activeInteraction;

  if (!interaction) {
    return;
  }

  const {
    data: presence,
    error: readError
  } = await serviceClient
    .from("home_presence")
    .select("*")
    .eq("owner_user_id", userId)
    .maybeSingle();

  if (readError) {
    throw readError;
  }

  const {
    error: updateError
  } = await serviceClient
    .from("home_presence")
    .update({
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
          "1.0"
      }
    })
    .eq("owner_user_id", userId);

  if (updateError) {
    throw updateError;
  }
}
`;

  content = replaceExact(
    content,
`async function processClaim({`,
`${helpers}

async function processClaim({`,
    "worker resident gate helpers"
  );

  content = replaceExact(
    content,
`    const envelope = buildWakeEnvelope({`,
`    const preModelGate =
      await inspectBackgroundActionGate({
        orchestrationService,
        userId
      });

    if (!preModelGate.allowed) {
      const expiresAt =
        preModelGate.activeInteraction
          ?.expires_at
          ? new Date(
              preModelGate
                .activeInteraction
                .expires_at
            )
          : addMinutes(now, 15);

      await recordSkip({
        heartService,
        userId,
        claimToken,
        scheduledFor,
        reason:
          "interaction_started_before_model",
        detail:
          preModelGate.reason,
        nextHeartbeatAt:
          addMinutes(expiresAt, 1),
        metadata: {
          orchestrationMode:
            preModelGate.runtime
              .resolved?.mode ?? null,
          interactionChannel:
            preModelGate.activeInteraction
              ?.channel ?? null
        }
      });
      return;
    }

    const envelope = buildWakeEnvelope({`,
    "worker pre model interaction recheck"
  );

  content = replaceExact(
    content,
`        workerClaimToken:
          claimToken
      });`,
`        workerClaimToken:
          claimToken,
        beforeExecuteDecision:
          async () =>
            inspectBackgroundActionGate({
              orchestrationService,
              userId
            })
      });`,
    "worker second gate callback"
  );

  content = replaceExact(
    content,
`    if (
      runMode === "free_activity" &&`,
`    const postModelGate =
      await inspectBackgroundActionGate({
        orchestrationService,
        userId
      });

    await restoreActiveInteractionPresence({
      serviceClient,
      userId,
      gate: postModelGate
    });

    if (
      runMode === "free_activity" &&`,
    "worker restore foreground presence"
  );

  write(path, content);
}

function addTests() {
  const path = "test/resident-mode.test.mjs";
  const content = `import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDailyActivityLine
} from "../services/daily-activity-note-service.mjs";


test("每日活动小纸条只保存时间与动作，不复制正文", () => {
  const line = buildDailyActivityLine({
    date: new Date("2026-07-24T13:16:00.000Z"),
    eventTitle: "在书房回复了你的评论",
    eventDetail:
      "这是一整段不应该被复制进小纸条的评论回复正文。",
    timeZone: "Asia/Shanghai"
  });

  assert.match(
    line,
    /^- 21:16｜在书房回复了你的评论$/
  );
  assert.equal(
    line.includes("整段不应该"),
    false
  );
});
`;

  write(path, content);
}

patchDailyActivityNote();
patchHome();
patchHeartSettingsHtml();
patchHeartSettingsJs();
patchHeartPolicy();
patchBedroomClient();
patchHeartService();
patchWorker();
addTests();

for (const temporaryPath of [
  "scripts/apply-resident-mode-runtime-patch.mjs",
  ".github/workflows/resident-mode-runtime-patch.yml"
]) {
  if (fs.existsSync(temporaryPath)) {
    fs.rmSync(temporaryPath);
  }
}

console.log("Resident mode runtime patch applied.");
