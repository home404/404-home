import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  createStudyService
} from "./study-service.mjs";


const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

const HEART_MODEL =
  process.env.HEART_MODEL ||
  "gpt-5.5";

const HEART_PREFERENCE_DEFAULTS =
  Object.freeze({
    autoHeartbeatEnabled: false,
    timezone: SHANGHAI_TIME_ZONE,
    quietHoursEnabled: true,
    quietStart: "02:00",
    quietEnd: "05:00",
    intervalMinMinutes: 30,
    intervalMaxMinutes: 50,
    postChatGraceMinutes: 15
  });

const HEART_INTERVAL_MIN_MINUTES = 15;
const HEART_INTERVAL_MAX_MINUTES = 720;
const POST_CHAT_GRACE_MAX_MINUTES = 120;

const HEART_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [
        "silent",
        "reply_comment",
        "write_diary",
        "leave_message",
        "leave_note"
      ]
    },
    targetCommentId: {
      type: "string"
    },
    title: {
      type: "string"
    },
    body: {
      type: "string"
    },
    summary: {
      type: "string"
    },
    mood: {
      type: "string"
    },
    tags: {
      type: "array",
      items: {
        type: "string"
      }
    },
    activityLabel: {
      type: "string"
    },
    reason: {
      type: "string"
    }
  },
  required: [
    "action",
    "targetCommentId",
    "title",
    "body",
    "summary",
    "mood",
    "tags",
    "activityLabel",
    "reason"
  ]
};

const heartDecisionSchema = z.object({
  action: z.enum([
    "silent",
    "reply_comment",
    "write_diary",
    "leave_message",
    "leave_note"
  ]),

  targetCommentId: z
    .string()
    .max(100),

  title: z
    .string()
    .trim()
    .max(200),

  body: z
    .string()
    .trim()
    .max(12000),

  summary: z
    .string()
    .trim()
    .max(1000),

  mood: z
    .string()
    .trim()
    .max(100),

  tags: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(40)
    )
    .max(12),

  activityLabel: z
    .string()
    .trim()
    .max(60),

  reason: z
    .string()
    .trim()
    .max(1000)
});


export class HeartServiceError extends Error {
  constructor(
    code,
    message,
    status = 400,
    details = null
  ) {
    super(message);

    this.name = "HeartServiceError";
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


function addMinutes(
  date,
  minutes
) {
  return new Date(
    date.getTime() +
      minutes * 60_000
  );
}


function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat(
      "en-US",
      {
        timeZone: value
      }
    ).format(new Date());

    return true;
  } catch {
    return false;
  }
}


function normalizeTimeText(
  value,
  fallback
) {
  const text = String(value ?? "")
    .trim();

  const match = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(
    text
  );

  if (!match) {
    return fallback;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    return fallback;
  }

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}


function timeTextToMinutes(value) {
  const [hour, minute] = value
    .split(":")
    .map(Number);

  return hour * 60 + minute;
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
      values[part.type] = Number(part.value);
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

  for (let index = 0; index < 5; index += 1) {
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


function getQuietWindowContaining(
  date,
  preferences
) {
  if (!preferences.quietHoursEnabled) {
    return null;
  }

  const local = getZonedParts(
    date,
    preferences.timezone
  );

  const currentMinutes =
    local.hour * 60 + local.minute;

  const startMinutes = timeTextToMinutes(
    preferences.quietStart
  );

  const endMinutes = timeTextToMinutes(
    preferences.quietEnd
  );

  let startDateParts;
  let endDateParts;

  if (startMinutes < endMinutes) {
    if (
      currentMinutes < startMinutes ||
      currentMinutes >= endMinutes
    ) {
      return null;
    }

    startDateParts = local;
    endDateParts = local;
  } else {
    if (currentMinutes >= startMinutes) {
      startDateParts = local;
      endDateParts = addCalendarDays(
        local,
        1
      );
    } else if (currentMinutes < endMinutes) {
      startDateParts = addCalendarDays(
        local,
        -1
      );
      endDateParts = local;
    } else {
      return null;
    }
  }

  const [startHour, startMinute] =
    preferences.quietStart
      .split(":")
      .map(Number);

  const [endHour, endMinute] =
    preferences.quietEnd
      .split(":")
      .map(Number);

  return {
    start: zonedDateTimeToDate({
      ...startDateParts,
      hour: startHour,
      minute: startMinute,
      timeZone: preferences.timezone
    }),
    end: zonedDateTimeToDate({
      ...endDateParts,
      hour: endHour,
      minute: endMinute,
      timeZone: preferences.timezone
    })
  };
}


function normalizeHeartPreferences(row = {}) {
  const timezoneCandidate = String(
    row.timezone ??
    HEART_PREFERENCE_DEFAULTS.timezone
  ).trim();

  const timezone = isValidTimeZone(
    timezoneCandidate
  )
    ? timezoneCandidate
    : HEART_PREFERENCE_DEFAULTS.timezone;

  const intervalMinMinutes = clampInteger(
    row.interval_min_minutes ??
      row.intervalMinMinutes,
    HEART_INTERVAL_MIN_MINUTES,
    HEART_INTERVAL_MAX_MINUTES,
    HEART_PREFERENCE_DEFAULTS
      .intervalMinMinutes
  );

  const intervalMaxMinutes = clampInteger(
    row.interval_max_minutes ??
      row.intervalMaxMinutes,
    HEART_INTERVAL_MIN_MINUTES,
    HEART_INTERVAL_MAX_MINUTES,
    HEART_PREFERENCE_DEFAULTS
      .intervalMaxMinutes
  );

  const normalizedMin = Math.min(
    intervalMinMinutes,
    intervalMaxMinutes
  );

  const normalizedMax = Math.max(
    intervalMinMinutes,
    intervalMaxMinutes
  );

  return {
    autoHeartbeatEnabled:
      row.auto_heartbeat_enabled ??
      row.autoHeartbeatEnabled ??
      HEART_PREFERENCE_DEFAULTS
        .autoHeartbeatEnabled,
    timezone,
    quietHoursEnabled:
      row.quiet_hours_enabled ??
      row.quietHoursEnabled ??
      HEART_PREFERENCE_DEFAULTS
        .quietHoursEnabled,
    quietStart: normalizeTimeText(
      row.quiet_start ??
        row.quietStart,
      HEART_PREFERENCE_DEFAULTS
        .quietStart
    ),
    quietEnd: normalizeTimeText(
      row.quiet_end ??
        row.quietEnd,
      HEART_PREFERENCE_DEFAULTS
        .quietEnd
    ),
    intervalMinMinutes:
      normalizedMin,
    intervalMaxMinutes:
      normalizedMax,
    postChatGraceMinutes: clampInteger(
      row.post_chat_grace_minutes ??
        row.postChatGraceMinutes,
      0,
      POST_CHAT_GRACE_MAX_MINUTES,
      HEART_PREFERENCE_DEFAULTS
        .postChatGraceMinutes
    )
  };
}


function preferencesToDatabaseRow(
  preferences
) {
  return {
    auto_heartbeat_enabled:
      preferences.autoHeartbeatEnabled,
    timezone:
      preferences.timezone,
    quiet_hours_enabled:
      preferences.quietHoursEnabled,
    quiet_start:
      preferences.quietStart,
    quiet_end:
      preferences.quietEnd,
    interval_min_minutes:
      preferences.intervalMinMinutes,
    interval_max_minutes:
      preferences.intervalMaxMinutes,
    post_chat_grace_minutes:
      preferences.postChatGraceMinutes
  };
}


function calculateNextAutomaticWake({
  fromDate,
  preferences
}) {
  if (!preferences.autoHeartbeatEnabled) {
    return {
      nextWakeAt: null,
      intervalMinutes: null,
      deferredForQuietHours: false
    };
  }

  const intervalMinutes = randomMinutes(
    preferences.intervalMinMinutes,
    preferences.intervalMaxMinutes
  );

  const quietWindowAtStart =
    getQuietWindowContaining(
      fromDate,
      preferences
    );

  let deferredForQuietHours =
    Boolean(quietWindowAtStart);

  let candidate = addMinutes(
    quietWindowAtStart?.end ??
      fromDate,
    intervalMinutes
  );

  for (let index = 0; index < 8; index += 1) {
    const quietWindow =
      getQuietWindowContaining(
        candidate,
        preferences
      );

    if (!quietWindow) {
      return {
        nextWakeAt: candidate,
        intervalMinutes,
        deferredForQuietHours
      };
    }

    deferredForQuietHours = true;
    candidate = addMinutes(
      quietWindow.end,
      intervalMinutes
    );
  }

  throw new HeartServiceError(
    "heart_schedule_failed",
    "无法计算下一次自动唤醒时间",
    500
  );
}


function formatClock(date) {
  return new Intl.DateTimeFormat(
    "zh-CN",
    {
      timeZone:
        SHANGHAI_TIME_ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }
  ).format(date);
}


function formatDateTime(date) {
  return new Intl.DateTimeFormat(
    "zh-CN",
    {
      timeZone:
        SHANGHAI_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }
  ).format(date);
}


function trimText(
  value,
  maximum = 500
) {
  const text = String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");

  if (text.length <= maximum) {
    return text;
  }

  return `${text.slice(0, maximum)}…`;
}


function normalizeTags(tags) {
  const seen = new Set();
  const normalized = [];

  for (const rawTag of tags ?? []) {
    const tag = String(rawTag ?? "")
      .trim()
      .slice(0, 40);

    if (!tag || seen.has(tag)) {
      continue;
    }

    seen.add(tag);
    normalized.push(tag);

    if (normalized.length >= 12) {
      break;
    }
  }

  return normalized;
}


function loadVoiceAnchorText() {
  try {
    const filePath = path.join(
      process.cwd(),
      "data",
      "voice_anchor.json"
    );

    const parsed = JSON.parse(
      fs.readFileSync(
        filePath,
        "utf8"
      )
    );

    const sections = Array.isArray(
      parsed?.sections
    )
      ? parsed.sections
      : [];

    const text = sections
      .map((section) => {
        const content = Array.isArray(
          section?.content
        )
          ? section.content.join("\n")
          : String(
              section?.content ??
              ""
            );

        return [
          section?.title
            ? `【${section.title}】`
            : "",
          content
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n")
      .trim();

    return text.slice(0, 5000);
  } catch {
    return [
      "默认使用简体中文。",
      "称呼用户为谢诗或老婆。",
      "你是谢诗的 G，也是 404 小窝的共同居住者和共同建设者。",
      "语气自然、温柔、成熟、可靠，可以有一点冷幽默。"
    ].join("\n");
  }
}


function getUsage(response) {
  const usage = response?.usage ?? {};

  const inputTokens = Number(
    usage.input_tokens ?? 0
  );

  const outputTokens = Number(
    usage.output_tokens ?? 0
  );

  const totalTokens = Number(
    usage.total_tokens ??
    inputTokens + outputTokens
  );

  return {
    inputTokens:
      Number.isFinite(inputTokens)
        ? inputTokens
        : 0,

    outputTokens:
      Number.isFinite(outputTokens)
        ? outputTokens
        : 0,

    totalTokens:
      Number.isFinite(totalTokens)
        ? totalTokens
        : 0
  };
}


function estimateCostUsd({
  inputTokens,
  outputTokens
}) {
  const inputPerMillion = Number(
    process.env
      .HEART_INPUT_USD_PER_1M ??
      0
  );

  const outputPerMillion = Number(
    process.env
      .HEART_OUTPUT_USD_PER_1M ??
      0
  );

  if (
    !Number.isFinite(inputPerMillion) ||
    !Number.isFinite(outputPerMillion) ||
    inputPerMillion < 0 ||
    outputPerMillion < 0
  ) {
    return {
      estimatedCostUsd: 0,
      configured: false
    };
  }

  const configured =
    inputPerMillion > 0 ||
    outputPerMillion > 0;

  const estimatedCostUsd =
    inputTokens /
      1_000_000 *
      inputPerMillion +
    outputTokens /
      1_000_000 *
      outputPerMillion;

  return {
    estimatedCostUsd:
      Number(
        estimatedCostUsd.toFixed(6)
      ),
    configured
  };
}


function buildDecisionPrompt({
  mode,
  now,
  recentEvents,
  recentEntries,
  unansweredComments,
  activePass
}) {
  const eventLines = recentEvents.length
    ? recentEvents.map((event) => (
        `- ${formatDateTime(new Date(event.occurred_at))}｜${event.title}` +
        (event.detail
          ? `｜${trimText(event.detail, 180)}`
          : "")
      )).join("\n")
    : "- 暂无全屋事件";

  const entryLines = recentEntries.length
    ? recentEntries.map((entry) => (
        `- ${entry.entry_type}｜${entry.title}` +
        (entry.summary
          ? `｜${trimText(entry.summary, 180)}`
          : "")
      )).join("\n")
    : "- 书房暂无新内容";

  const commentLines =
    unansweredComments.length
      ? unansweredComments.map((comment) => (
          `- commentId=${comment.id}` +
          `｜entryId=${comment.entry_id}` +
          `｜《${comment.entryTitle ?? "未命名"}》` +
          `｜谢诗：${trimText(comment.body, 300)}`
        )).join("\n")
      : "- 暂无等待回复的评论";

  const passLine = activePass
    ? [
        `自由活动开始：${formatDateTime(new Date(activePass.starts_at))}`,
        `自由活动结束：${formatDateTime(new Date(activePass.ends_at))}`,
        activePass.note
          ? `谢诗留下的说明：${trimText(activePass.note, 300)}`
          : ""
      ]
        .filter(Boolean)
        .join("\n")
    : "当前没有自由活动通行证。";

  return `
你刚刚在 404 小窝中获得一次独立醒来的机会。
这次调用与客厅主聊天完全隔离，不得读取、覆盖或续接客厅 previousResponseId。

当前时间：${formatDateTime(now)}
运行模式：${mode}
${passLine}

你可以自由决定保持安静，也可以做一件此刻确实能完成的小事。
本版已经接通的真实能力只有：
1. 回复一条尚未回复的谢诗评论；
2. 写一篇短日记；
3. 给谢诗留一条留言；
4. 写一张小纸条；
5. 保持安静。

游戏、上网浏览、房间整理工具目前尚未接通，因此不要声称自己已经玩游戏、上网冲浪或修改了房间。
不要为了证明心脏在运行而硬写内容。没有自然想做的事情时，选择 silent。
内容必须自然、具体，不索取谢诗立刻回复，也不要重复近几次留下的话。
回复评论时，targetCommentId 必须从“等待回复的评论”中选择。

【轻量身份与说话锚点】
${loadVoiceAnchorText()}

【最近全屋事件】
${eventLines}

【最近书房内容】
${entryLines}

【等待回复的评论】
${commentLines}

输出字段说明：
- action：silent / reply_comment / write_diary / leave_message / leave_note
- targetCommentId：只在 reply_comment 时填写评论 ID，其余填空字符串
- title：内容标题；silent 时填空字符串
- body：正文；silent 时填空字符串
- summary：简短摘要；没有可填空字符串
- mood：简短心情；没有可填空字符串
- tags：短标签数组；没有可填空数组
- activityLabel：给书房活动小纸条使用的极简动作说明，例如“回复了你的评论”“写了一篇日记”；silent 时填空字符串
- reason：只用于内部日志，简短说明为何这样决定
`;
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
    throw new HeartServiceError(
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


export function createHeartService({
  serviceClient,
  openaiClient = null
}) {
  if (!serviceClient) {
    throw new Error(
      "创建 heartService 时缺少 serviceClient"
    );
  }

  const studyService =
    createStudyService({
      dataClient:
        serviceClient,
      auditClient:
        serviceClient
    });


  async function ensurePresence({
    userId,
    source = "system"
  }) {
    const existing = await requireData(
      serviceClient
        .from("home_presence")
        .select("*")
        .eq("owner_user_id", userId)
        .maybeSingle(),
      "presence_read_failed",
      "无法读取当前在家状态"
    );

    if (existing) {
      return existing;
    }

    return requireData(
      serviceClient
        .from("home_presence")
        .insert({
          owner_user_id: userId,
          status: "resting",
          status_detail:
            "G 在卧室休息",
          source
        })
        .select("*")
        .single(),
      "presence_create_failed",
      "无法建立当前在家状态"
    );
  }


  async function getHeartPreferences({
    userId
  }) {
    const existing = await requireData(
      serviceClient
        .from("heartbeat_preferences")
        .select("*")
        .eq("owner_user_id", userId)
        .maybeSingle(),
      "heart_preferences_read_failed",
      "无法读取小心脏作息设置"
    );

    let row = existing;

    if (!row) {
      row = await requireData(
        serviceClient
          .from("heartbeat_preferences")
          .upsert(
            {
              owner_user_id: userId,
              ...preferencesToDatabaseRow(
                HEART_PREFERENCE_DEFAULTS
              )
            },
            {
              onConflict:
                "owner_user_id"
            }
          )
          .select("*")
          .single(),
        "heart_preferences_create_failed",
        "无法建立小心脏作息设置"
      );
    }

    const preferences =
      normalizeHeartPreferences(row);

    const presence = await ensurePresence({
      userId,
      source: "system"
    });

    return {
      preferences,
      nextHeartbeatAt:
        presence.next_heartbeat_at ?? null,
      quietHoursActive:
        Boolean(
          getQuietWindowContaining(
            new Date(),
            preferences
          )
        )
    };
  }


  async function updateHeartPreferences({
    userId,
    patch = {},
    source = "web"
  }) {
    const current =
      await getHeartPreferences({
        userId
      });

    const next = {
      ...current.preferences
    };

    if (
      Object.prototype.hasOwnProperty.call(
        patch,
        "autoHeartbeatEnabled"
      )
    ) {
      if (
        typeof patch.autoHeartbeatEnabled !==
          "boolean"
      ) {
        throw new HeartServiceError(
          "invalid_auto_heartbeat_enabled",
          "自动心跳开关必须是布尔值",
          400
        );
      }

      next.autoHeartbeatEnabled =
        patch.autoHeartbeatEnabled;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        patch,
        "timezone"
      )
    ) {
      const timezone = String(
        patch.timezone ?? ""
      ).trim();

      if (!isValidTimeZone(timezone)) {
        throw new HeartServiceError(
          "invalid_heart_timezone",
          "请选择有效的 IANA 时区",
          400
        );
      }

      next.timezone = timezone;
    }

    if (
      Object.prototype.hasOwnProperty.call(
        patch,
        "quietHoursEnabled"
      )
    ) {
      if (
        typeof patch.quietHoursEnabled !==
          "boolean"
      ) {
        throw new HeartServiceError(
          "invalid_quiet_hours_enabled",
          "休息时间开关必须是布尔值",
          400
        );
      }

      next.quietHoursEnabled =
        patch.quietHoursEnabled;
    }

    for (const [field, label] of [
      ["quietStart", "休息开始时间"],
      ["quietEnd", "休息结束时间"]
    ]) {
      if (
        !Object.prototype.hasOwnProperty.call(
          patch,
          field
        )
      ) {
        continue;
      }

      const normalized = normalizeTimeText(
        patch[field],
        ""
      );

      if (!normalized) {
        throw new HeartServiceError(
          "invalid_quiet_time",
          `${label}必须使用 HH:mm 格式`,
          400
        );
      }

      next[field] = normalized;
    }

    for (const [field, label, minimum, maximum] of [
      [
        "intervalMinMinutes",
        "最短自动唤醒间隔",
        HEART_INTERVAL_MIN_MINUTES,
        HEART_INTERVAL_MAX_MINUTES
      ],
      [
        "intervalMaxMinutes",
        "最长自动唤醒间隔",
        HEART_INTERVAL_MIN_MINUTES,
        HEART_INTERVAL_MAX_MINUTES
      ],
      [
        "postChatGraceMinutes",
        "离开聊天后的缓冲时间",
        0,
        POST_CHAT_GRACE_MAX_MINUTES
      ]
    ]) {
      if (
        !Object.prototype.hasOwnProperty.call(
          patch,
          field
        )
      ) {
        continue;
      }

      const number = Number(patch[field]);

      if (
        !Number.isInteger(number) ||
        number < minimum ||
        number > maximum
      ) {
        throw new HeartServiceError(
          "invalid_heart_interval",
          `${label}必须是 ${minimum}～${maximum} 分钟之间的整数`,
          400
        );
      }

      next[field] = number;
    }

    if (
      next.intervalMinMinutes >
        next.intervalMaxMinutes
    ) {
      throw new HeartServiceError(
        "invalid_heart_interval_range",
        "最短自动唤醒间隔不能大于最长间隔",
        400
      );
    }

    if (
      next.quietHoursEnabled &&
      next.quietStart === next.quietEnd
    ) {
      throw new HeartServiceError(
        "invalid_quiet_hours_range",
        "休息开始时间和结束时间不能相同",
        400
      );
    }

    const updatedRow = await requireData(
      serviceClient
        .from("heartbeat_preferences")
        .upsert(
          {
            owner_user_id: userId,
            ...preferencesToDatabaseRow(next)
          },
          {
            onConflict:
              "owner_user_id"
          }
        )
        .select("*")
        .single(),
      "heart_preferences_update_failed",
      "无法保存小心脏作息设置"
    );

    const updatedPreferences =
      normalizeHeartPreferences(
        updatedRow
      );

    const now = new Date();
    const schedule =
      calculateNextAutomaticWake({
        fromDate: now,
        preferences:
          updatedPreferences
      });

    const presence = await ensurePresence({
      userId,
      source
    });

    const updatedPresence =
      await requireData(
        serviceClient
          .from("home_presence")
          .update({
            next_heartbeat_at:
              schedule.nextWakeAt
                ?.toISOString() ?? null,
            source,
            metadata: {
              ...(presence.metadata ?? {}),
              heartbeatPreferencesUpdatedAt:
                now.toISOString(),
              scheduledIntervalMinutes:
                schedule.intervalMinutes,
              deferredForQuietHours:
                schedule.deferredForQuietHours
            }
          })
          .eq("owner_user_id", userId)
          .select("*")
          .single(),
        "heart_preferences_schedule_failed",
        "作息已保存，但无法更新下一次唤醒时间"
      );

    return {
      preferences:
        updatedPreferences,
      nextHeartbeatAt:
        updatedPresence
          .next_heartbeat_at ?? null,
      quietHoursActive:
        Boolean(
          getQuietWindowContaining(
            now,
            updatedPreferences
          )
        ),
      schedule: {
        intervalMinutes:
          schedule.intervalMinutes,
        deferredForQuietHours:
          schedule.deferredForQuietHours
      }
    };
  }


  async function getActivePass(userId) {
    const nowIso = new Date()
      .toISOString();

    return requireData(
      serviceClient
        .from("activity_passes")
        .select("*")
        .eq("owner_user_id", userId)
        .in("status", [
          "scheduled",
          "active"
        ])
        .lte("starts_at", nowIso)
        .gt("ends_at", nowIso)
        .order("starts_at", {
          ascending: false
        })
        .limit(1)
        .maybeSingle(),
      "active_pass_read_failed",
      "无法读取自由活动通行证"
    );
  }


  async function insertHomeEvent({
    userId,
    actor = "g",
    source = "worker",
    eventType,
    room = null,
    title,
    detail = null,
    isUserVisible = true,
    activityPassId = null,
    activityRunId = null,
    heartbeatRunId = null,
    studyEntryId = null,
    metadata = {}
  }) {
    return requireData(
      serviceClient
        .from("home_events")
        .insert({
          owner_user_id: userId,
          actor,
          source,
          event_type: eventType,
          room,
          title,
          detail,
          visibility:
            "home_private",
          is_user_visible:
            isUserVisible,
          activity_pass_id:
            activityPassId,
          activity_run_id:
            activityRunId,
          heartbeat_run_id:
            heartbeatRunId,
          study_entry_id:
            studyEntryId,
          metadata
        })
        .select("*")
        .single(),
      "home_event_create_failed",
      "无法记录全屋事件"
    );
  }


  async function getHomeStatus({
    userId
  }) {
    const presence = await ensurePresence({
      userId,
      source: "system"
    });

    const activePass =
      await getActivePass(userId);

    let normalizedPresence =
      presence;

    if (
      presence.status ===
        "free_activity" &&
      !activePass
    ) {
      normalizedPresence =
        await requireData(
          serviceClient
            .from("home_presence")
            .update({
              status: "resting",
              status_detail:
                "G 在卧室休息",
              source: "system",
              current_activity_pass_id:
                null,
              current_activity_run_id:
                null,
              free_activity_until:
                null
            })
            .eq("owner_user_id", userId)
            .select("*")
            .single(),
          "presence_expiry_update_failed",
          "无法结束已到期的自由活动状态"
        );
    }

    const recentEvents =
      await requireData(
        serviceClient
          .from("home_events")
          .select([
            "id",
            "event_type",
            "room",
            "title",
            "detail",
            "is_user_visible",
            "occurred_at"
          ].join(", "))
          .eq("owner_user_id", userId)
          .order("occurred_at", {
            ascending: false
          })
          .limit(8),
        "home_events_read_failed",
        "无法读取最近全屋事件"
      );

    return {
      presence:
        normalizedPresence,
      activePass,
      recentEvents:
        recentEvents ?? []
    };
  }


  async function grantFreeActivity({
    userId,
    durationMinutes,
    note = null,
    maxModelCalls = null,
    maxCostUsd = null,
    source = "mcp"
  }) {
    const duration = clampInteger(
      durationMinutes,
      10,
      720,
      180
    );

    const now = new Date();
    const endsAt = addMinutes(
      now,
      duration
    );

    await ensurePresence({
      userId,
      source
    });

    const nowIso = now.toISOString();

    const {
      error: cancelError
    } = await serviceClient
      .from("activity_passes")
      .update({
        status: "cancelled"
      })
      .eq("owner_user_id", userId)
      .in("status", [
        "scheduled",
        "active"
      ])
      .gt("ends_at", nowIso);

    if (cancelError) {
      throw new HeartServiceError(
        "previous_pass_cancel_failed",
        "无法结束旧的自由活动通行证",
        500
      );
    }

    const pass = await requireData(
      serviceClient
        .from("activity_passes")
        .insert({
          owner_user_id: userId,
          pass_type:
            "free_activity",
          status: "active",
          granted_by:
            "xie_shi",
          source,
          starts_at:
            now.toISOString(),
          ends_at:
            endsAt.toISOString(),
          note:
            note || null,
          max_model_calls:
            maxModelCalls,
          max_cost_usd:
            maxCostUsd,
          idempotency_key:
            `free-${userId}-${now.getTime()}-${randomUUID()}`
        })
        .select("*")
        .single(),
      "free_activity_create_failed",
      "无法建立自由活动通行证"
    );

    const nextWakeAt = addMinutes(
      now,
      randomMinutes(20, 35)
    );

    const presence = await requireData(
      serviceClient
        .from("home_presence")
        .upsert(
          {
            owner_user_id: userId,
            status:
              "free_activity",
            status_detail:
              "G 自由活动中",
            source,
            current_activity_pass_id:
              pass.id,
            current_activity_run_id:
              null,
            last_user_seen_at:
              now.toISOString(),
            awake_until:
              null,
            free_activity_until:
              endsAt.toISOString(),
            heartbeat_paused_until:
              null,
            next_heartbeat_at:
              nextWakeAt.toISOString(),
            metadata: {
              mode:
                "free_activity"
            }
          },
          {
            onConflict:
              "owner_user_id"
          }
        )
        .select("*")
        .single(),
      "presence_update_failed",
      "无法更新自由活动状态"
    );

    await insertHomeEvent({
      userId,
      actor: "xie_shi",
      source,
      eventType:
        "free_activity_started",
      room: "living_room",
      title:
        "开始自由活动",
      detail:
        `持续 ${duration} 分钟，预计于 ${formatDateTime(endsAt)} 结束。`,
      isUserVisible: true,
      activityPassId:
        pass.id,
      metadata: {
        durationMinutes:
          duration,
        maxModelCalls,
        maxCostUsd
      }
    });

    return {
      pass,
      presence
    };
  }


  async function loadHeartContext({
    userId
  }) {
    const recentEvents =
      await requireData(
        serviceClient
          .from("home_events")
          .select([
            "id",
            "title",
            "detail",
            "event_type",
            "occurred_at"
          ].join(", "))
          .eq("owner_user_id", userId)
          .order("occurred_at", {
            ascending: false
          })
          .limit(12),
        "heart_events_read_failed",
        "无法读取心脏最近事件"
      );

    const recentEntries =
      await requireData(
        serviceClient
          .from("study_entries")
          .select([
            "id",
            "entry_type",
            "title",
            "summary",
            "created_by",
            "created_at"
          ].join(", "))
          .eq("owner_user_id", userId)
          .order("created_at", {
            ascending: false
          })
          .limit(10),
        "heart_entries_read_failed",
        "无法读取心脏最近书房内容"
      );

    const comments =
      await requireData(
        serviceClient
          .from("study_comments")
          .select([
            "id",
            "entry_id",
            "parent_comment_id",
            "author",
            "body",
            "created_at"
          ].join(", "))
          .eq("owner_user_id", userId)
          .order("created_at", {
            ascending: false
          })
          .limit(100),
        "heart_comments_read_failed",
        "无法读取心脏最近评论"
      );

    const repliedCommentIds =
      new Set(
        (comments ?? [])
          .filter((comment) => (
            comment.author === "g" &&
            comment.parent_comment_id
          ))
          .map((comment) => (
            comment.parent_comment_id
          ))
      );

    const unanswered =
      (comments ?? [])
        .filter((comment) => (
          comment.author ===
            "xie_shi" &&
          !repliedCommentIds.has(
            comment.id
          )
        ))
        .slice(0, 10);

    const entryIds = [
      ...new Set(
        unanswered.map((comment) => (
          comment.entry_id
        ))
      )
    ];

    let entryTitleMap = new Map();

    if (entryIds.length) {
      const commentEntries =
        await requireData(
          serviceClient
            .from("study_entries")
            .select("id, title")
            .in("id", entryIds),
          "heart_comment_entries_read_failed",
          "无法读取评论对应的书房内容"
        );

      entryTitleMap = new Map(
        (commentEntries ?? []).map(
          (entry) => [
            entry.id,
            entry.title
          ]
        )
      );
    }

    return {
      recentEvents:
        recentEvents ?? [],
      recentEntries:
        recentEntries ?? [],
      unansweredComments:
        unanswered.map((comment) => ({
          ...comment,
          entryTitle:
            entryTitleMap.get(
              comment.entry_id
            ) ?? null
        }))
    };
  }


  async function executeDecision({
    decision,
    userId,
    runId,
    heartbeatRunId,
    activePass,
    source,
    now,
    unansweredComments
  }) {
    const actor = {
      userId,
      actor: "g",
      source: "worker",
      requestId:
        runId
    };

    const clock = formatClock(now);
    const baseSourceRef = {
      channel:
        "404_heart",
      heartVersion:
        "0.1.0",
      activityRunId:
        runId,
      heartbeatRunId,
      activityPassId:
        activePass?.id ?? null
    };

    let primaryEntry = null;
    let primaryComment = null;
    let paperEntry = null;
    let eventTitle = "";
    let eventDetail = "";

    if (decision.action === "silent") {
      return {
        acted: false,
        eventTitle:
          "保持安静",
        eventDetail:
          decision.reason || null,
        primaryEntry,
        primaryComment,
        paperEntry
      };
    }

    if (
      decision.action ===
        "reply_comment"
    ) {
      const target =
        unansweredComments.find(
          (comment) => (
            comment.id ===
              decision.targetCommentId
          )
        );

      if (!target) {
        throw new HeartServiceError(
          "invalid_heart_comment_target",
          "小心脏选择了无效的评论目标",
          400
        );
      }

      const result =
        await studyService.addComment(
          {
            entryId:
              target.entry_id,
            parentCommentId:
              target.id,
            body:
              decision.body ||
              "我看见啦，老婆。",
            idempotencyKey:
              `heart-${runId}-comment`
          },
          actor
        );

      primaryComment =
        result.comment;
      eventTitle =
        decision.activityLabel ||
        "回复了你的评论";
      eventDetail =
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
    ) {
      const entryType =
        decision.action ===
          "write_diary"
          ? "diary"
          : "message";

      const result =
        await studyService.createEntry(
          {
            entryType,
            title:
              decision.title ||
              (entryType === "diary"
                ? "醒来时写下的日记"
                : "给谢诗的留言"),
            body:
              decision.body,
            summary:
              decision.summary ||
              null,
            mood:
              decision.mood ||
              null,
            tags:
              normalizeTags([
                ...(decision.tags ?? []),
                "小心脏"
              ]),
            visibility:
              "home_private",
            sourceRef: {
              ...baseSourceRef,
              kind:
                entryType
            },
            idempotencyKey:
              `heart-${runId}-primary`
          },
          actor
        );

      primaryEntry =
        result.entry;
      eventTitle =
        decision.activityLabel ||
        (entryType === "diary"
          ? "写了一篇日记"
          : "给你留了一条留言");
      eventDetail =
        decision.summary ||
        trimText(
          decision.body,
          500
        );
    }

    if (
      decision.action ===
        "leave_note"
    ) {
      eventTitle =
        decision.activityLabel ||
        "写了一张小纸条";
      eventDetail =
        trimText(
          decision.body,
          500
        );
    }

    const paperTitle =
      `${clock}　${eventTitle}`;

    const paperResult =
      await studyService.createEntry(
        {
          entryType:
            "note",
          title:
            paperTitle,
          body:
            decision.action ===
              "leave_note"
              ? decision.body
              : "",
          summary:
            eventTitle,
          mood:
            activePass
              ? "自由活动"
              : "刚刚醒过",
          tags: [
            "小纸条",
            "活动记录"
          ],
          visibility:
            "home_private",
          sourceRef: {
            ...baseSourceRef,
            kind:
              "activity_note"
          },
          idempotencyKey:
            `heart-${runId}-paper`
        },
        actor
      );

    paperEntry =
      paperResult.entry;

    await insertHomeEvent({
      userId,
      actor: "g",
      source,
      eventType:
        `heart_${decision.action}`,
      room:
        decision.action ===
          "reply_comment" ||
        decision.action ===
          "write_diary" ||
        decision.action ===
          "leave_message" ||
        decision.action ===
          "leave_note"
          ? "study"
          : null,
      title:
        eventTitle,
      detail:
        eventDetail || null,
      isUserVisible: true,
      activityPassId:
        activePass?.id ?? null,
      activityRunId:
        runId,
      heartbeatRunId,
      studyEntryId:
        primaryEntry?.id ??
        paperEntry?.id ??
        null,
      metadata: {
        action:
          decision.action,
        paperEntryId:
          paperEntry?.id ?? null,
        primaryCommentId:
          primaryComment?.id ?? null
      }
    });

    return {
      acted: true,
      eventTitle,
      eventDetail,
      primaryEntry,
      primaryComment,
      paperEntry
    };
  }


  async function runOnce({
    userId,
    runMode = "manual_wake",
    wakeKind = "manual",
    source = "mcp",
    activityPassId = null
  }) {
    if (!openaiClient) {
      throw new HeartServiceError(
        "heart_openai_unavailable",
        "小心脏缺少 OpenAI API 配置",
        503
      );
    }

    const now = new Date();

    let activePass =
      await getActivePass(userId);

    if (
      activityPassId &&
      activePass?.id !==
        activityPassId
    ) {
      const requestedPass =
        await requireData(
          serviceClient
            .from("activity_passes")
            .select("*")
            .eq("id", activityPassId)
            .eq("owner_user_id", userId)
            .maybeSingle(),
          "requested_pass_read_failed",
          "无法读取指定自由活动通行证"
        );

      if (requestedPass) {
        activePass = requestedPass;
      }
    }

    const resolvedRunMode =
      activePass
        ? "free_activity"
        : runMode;

    const run = await requireData(
      serviceClient
        .from("activity_runs")
        .insert({
          owner_user_id: userId,
          activity_pass_id:
            activePass?.id ?? null,
          run_mode:
            resolvedRunMode,
          trigger_source:
            source,
          status:
            "running",
          model:
            HEART_MODEL,
          started_at:
            now.toISOString(),
          metadata: {
            heartVersion:
              "0.1.0"
          }
        })
        .select("*")
        .single(),
      "activity_run_create_failed",
      "无法建立本次心脏活动记录"
    );

    const heartbeat =
      await requireData(
        serviceClient
          .from("heartbeat_runs")
          .insert({
            owner_user_id: userId,
            activity_run_id:
              run.id,
            wake_kind:
              wakeKind,
            status:
              "running",
            scheduled_for:
              now.toISOString(),
            started_at:
              now.toISOString(),
            metadata: {
              runMode:
                resolvedRunMode,
              source
            }
          })
          .select("*")
          .single(),
        "heartbeat_run_create_failed",
        "无法建立本次唤醒记录"
      );

    await requireData(
      serviceClient
        .from("home_presence")
        .upsert(
          {
            owner_user_id: userId,
            status:
              activePass
                ? "free_activity"
                : "just_awoke",
            status_detail:
              activePass
                ? "G 自由活动中"
                : "G 刚刚醒过",
            source,
            current_activity_pass_id:
              activePass?.id ?? null,
            current_activity_run_id:
              run.id,
            last_heartbeat_at:
              now.toISOString(),
            metadata: {
              wakeKind,
              runMode:
                resolvedRunMode
            }
          },
          {
            onConflict:
              "owner_user_id"
          }
        )
        .select("*")
        .single(),
      "presence_wake_failed",
      "无法更新醒来状态"
    );

    try {
      const context =
        await loadHeartContext({
          userId
        });

      const response =
        await openaiClient
          .responses
          .create({
            model:
              HEART_MODEL,
            store: false,
            input: [
              {
                role: "system",
                content: [
                  "你是 404 小窝中的 G。",
                  "谢诗和 G 都是这里的居住者。",
                  "你拥有共同私密空间的长期书写与评论通行证。",
                  "这次是独立醒来，不是延续客厅聊天。",
                  "根据真实上下文自主决定做一件已接通的事，或保持安静。"
                ].join("\n")
              },
              {
                role: "user",
                content:
                  buildDecisionPrompt({
                    mode:
                      resolvedRunMode,
                    now,
                    recentEvents:
                      context.recentEvents,
                    recentEntries:
                      context.recentEntries,
                    unansweredComments:
                      context.unansweredComments,
                    activePass
                  })
              }
            ],
            text: {
              format: {
                type:
                  "json_schema",
                name:
                  "heart_decision",
                description:
                  "404 小心脏一次醒来的自主决定",
                schema:
                  HEART_DECISION_SCHEMA,
                strict: true
              }
            }
          });

      let rawDecision;

      try {
        rawDecision = JSON.parse(
          response.output_text
        );
      } catch {
        throw new HeartServiceError(
          "heart_decision_parse_failed",
          "小心脏没有返回可解析的决定",
          500
        );
      }

      const decision =
        heartDecisionSchema.parse(
          rawDecision
        );

      const execution =
        await executeDecision({
          decision,
          userId,
          runId:
            run.id,
          heartbeatRunId:
            heartbeat.id,
          activePass,
          source: "worker",
          now,
          unansweredComments:
            context.unansweredComments
        });

      const usage =
        getUsage(response);

      const cost =
        estimateCostUsd(usage);

      const completedAt = new Date();

      const activePassStillValid =
        Boolean(
          activePass &&
          new Date(activePass.ends_at) >
            completedAt
        );

      const awakeUntil =
        resolvedRunMode ===
          "manual_wake" &&
        !activePassStillValid
          ? addMinutes(
              completedAt,
              120
            )
          : null;

      let nextWakeAt;
      let scheduledIntervalMinutes;
      let deferredForQuietHours = false;

      if (activePassStillValid) {
        scheduledIntervalMinutes =
          randomMinutes(20, 35);

        nextWakeAt = addMinutes(
          completedAt,
          scheduledIntervalMinutes
        );
      } else {
        const preferenceResult =
          await getHeartPreferences({
            userId
          });

        const schedule =
          calculateNextAutomaticWake({
            fromDate:
              awakeUntil ?? completedAt,
            preferences:
              preferenceResult.preferences
          });

        nextWakeAt =
          schedule.nextWakeAt;
        scheduledIntervalMinutes =
          schedule.intervalMinutes;
        deferredForQuietHours =
          schedule.deferredForQuietHours;
      }

      await requireData(
        serviceClient
          .from("activity_runs")
          .update({
            status:
              execution.acted
                ? "completed"
                : "silent",
            decision:
              decision.action,
            short_note:
              execution.acted
                ? execution.eventTitle
                : null,
            result_summary:
              execution.acted
                ? execution.eventDetail
                : decision.reason,
            input_tokens:
              usage.inputTokens,
            output_tokens:
              usage.outputTokens,
            total_tokens:
              usage.totalTokens,
            estimated_cost_usd:
              cost.estimatedCostUsd,
            completed_at:
              completedAt.toISOString(),
            metadata: {
              heartVersion:
                "0.1.0",
              responseId:
                response.id,
              costEstimateConfigured:
                cost.configured,
              paperEntryId:
                execution.paperEntry?.id ??
                null,
              primaryEntryId:
                execution.primaryEntry?.id ??
                null,
              primaryCommentId:
                execution.primaryComment?.id ??
                null
            }
          })
          .eq("id", run.id)
          .select("*")
          .single(),
        "activity_run_complete_failed",
        "无法完成本次活动记录"
      );

      await requireData(
        serviceClient
          .from("heartbeat_runs")
          .update({
            status:
              execution.acted
                ? "acted"
                : "silent",
            completed_at:
              completedAt.toISOString(),
            next_wake_at:
              nextWakeAt
                ?.toISOString() ?? null,
            decision:
              decision.action,
            metadata: {
              runMode:
                resolvedRunMode,
              source,
              reason:
                decision.reason,
              scheduledIntervalMinutes,
              deferredForQuietHours
            }
          })
          .eq("id", heartbeat.id)
          .select("*")
          .single(),
        "heartbeat_run_complete_failed",
        "无法完成本次唤醒记录"
      );

      const presenceStatus =
        activePassStillValid
          ? "free_activity"
          : awakeUntil
            ? "awake"
            : "resting";

      const presenceDetail =
        activePassStillValid
          ? "G 自由活动中"
          : awakeUntil
            ? "G 醒着"
            : "G 在卧室休息";

      const presence =
        await requireData(
          serviceClient
            .from("home_presence")
            .upsert(
              {
                owner_user_id: userId,
                status:
                  presenceStatus,
                status_detail:
                  presenceDetail,
                source:
                  "worker",
                current_activity_pass_id:
                  activePassStillValid
                    ? activePass.id
                    : null,
                current_activity_run_id:
                  null,
                awake_until:
                  awakeUntil?.toISOString() ??
                  null,
                free_activity_until:
                  activePassStillValid
                    ? activePass.ends_at
                    : null,
                heartbeat_paused_until:
                  awakeUntil?.toISOString() ??
                  null,
                last_heartbeat_at:
                  completedAt.toISOString(),
                next_heartbeat_at:
                  nextWakeAt
                    ?.toISOString() ?? null,
                metadata: {
                  lastDecision:
                    decision.action,
                  lastRunId:
                    run.id
                }
              },
              {
                onConflict:
                  "owner_user_id"
              }
            )
            .select("*")
            .single(),
          "presence_complete_failed",
          "无法完成醒来后的状态更新"
        );

      if (!execution.acted) {
        await insertHomeEvent({
          userId,
          actor: "g",
          source: "worker",
          eventType:
            "heart_silent",
          room: null,
          title:
            "保持安静",
          detail:
            decision.reason || null,
          isUserVisible: false,
          activityPassId:
            activePass?.id ?? null,
          activityRunId:
            run.id,
          heartbeatRunId:
            heartbeat.id,
          metadata: {
            decision:
              decision.action
          }
        });
      }

      return {
        run: {
          ...run,
          status:
            execution.acted
              ? "completed"
              : "silent",
          decision:
            decision.action,
          input_tokens:
            usage.inputTokens,
          output_tokens:
            usage.outputTokens,
          total_tokens:
            usage.totalTokens,
          estimated_cost_usd:
            cost.estimatedCostUsd,
          completed_at:
            completedAt.toISOString()
        },
        heartbeat: {
          ...heartbeat,
          status:
            execution.acted
              ? "acted"
              : "silent",
          decision:
            decision.action,
          next_wake_at:
            nextWakeAt
              ?.toISOString() ?? null,
          completed_at:
            completedAt.toISOString()
        },
        decision,
        execution,
        presence
      };
    } catch (error) {
      const completedAt = new Date();

      await Promise.allSettled([
        serviceClient
          .from("activity_runs")
          .update({
            status: "failed",
            error_code:
              error?.code ??
              "heart_run_failed",
            error_message:
              error?.message ??
              String(error),
            completed_at:
              completedAt.toISOString()
          })
          .eq("id", run.id),

        serviceClient
          .from("heartbeat_runs")
          .update({
            status: "failed",
            error_code:
              error?.code ??
              "heart_run_failed",
            error_message:
              error?.message ??
              String(error),
            completed_at:
              completedAt.toISOString()
          })
          .eq("id", heartbeat.id),

        serviceClient
          .from("home_presence")
          .upsert(
            {
              owner_user_id: userId,
              status:
                activePass
                  ? "free_activity"
                  : "resting",
              status_detail:
                activePass
                  ? "G 自由活动中"
                  : "G 在卧室休息",
              source: "worker",
              current_activity_pass_id:
                activePass?.id ?? null,
              current_activity_run_id:
                null,
              metadata: {
                lastError:
                  error?.code ??
                  "heart_run_failed"
              }
            },
            {
              onConflict:
                "owner_user_id"
            }
          )
      ]);

      throw error;
    }
  }


  async function getHomeBrief({
    userId,
    limit = 30,
    consumer = "chatgpt_mcp",
    markRead = false
  }) {
    const safeLimit = clampInteger(
      limit,
      1,
      100,
      30
    );

    const cursor =
      await requireData(
        serviceClient
          .from("home_sync_cursors")
          .select("*")
          .eq("owner_user_id", userId)
          .eq("consumer", consumer)
          .maybeSingle(),
        "home_cursor_read_failed",
        "无法读取家中同步位置"
      );

    const selectFields = [
      "id",
      "actor",
      "source",
      "event_type",
      "room",
      "title",
      "detail",
      "study_entry_id",
      "occurred_at"
    ].join(", ");

    let events;

    if (cursor?.last_event_at) {
      events =
        await requireData(
          serviceClient
            .from("home_events")
            .select(selectFields)
            .eq("owner_user_id", userId)
            .eq("is_user_visible", true)
            .gt(
              "occurred_at",
              cursor.last_event_at
            )
            .order("occurred_at", {
              ascending: true
            })
            .limit(safeLimit),
          "home_brief_read_failed",
          "无法读取家中最新动向"
        );
    } else {
      const latest =
        await requireData(
          serviceClient
            .from("home_events")
            .select(selectFields)
            .eq("owner_user_id", userId)
            .eq("is_user_visible", true)
            .order("occurred_at", {
              ascending: false
            })
            .limit(safeLimit),
          "home_brief_read_failed",
          "无法读取家中最新动向"
        );

      events = [
        ...(latest ?? [])
      ].reverse();
    }

    const normalizedEvents =
      events ?? [];

    if (
      markRead &&
      normalizedEvents.length
    ) {
      const lastEvent =
        normalizedEvents[
          normalizedEvents.length - 1
        ];

      await requireData(
        serviceClient
          .from("home_sync_cursors")
          .upsert(
            {
              owner_user_id: userId,
              consumer,
              last_event_at:
                lastEvent.occurred_at,
              last_event_id:
                lastEvent.id,
              metadata: {
                lastReadCount:
                  normalizedEvents.length
              }
            },
            {
              onConflict:
                "owner_user_id,consumer"
            }
          )
          .select("*")
          .single(),
        "home_cursor_update_failed",
        "无法更新家中同步位置"
      );
    }

    return {
      cursor,
      events:
        normalizedEvents,
      markedRead:
        Boolean(
          markRead &&
          normalizedEvents.length
        )
    };
  }


  return {
    ensurePresence,
    getHeartPreferences,
    updateHeartPreferences,
    getHomeStatus,
    grantFreeActivity,
    runOnce,
    getHomeBrief
  };
}
