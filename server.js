require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 4040;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

const supabase =
  supabaseUrl && supabaseSecretKey
    ? createClient(supabaseUrl, supabaseSecretKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false
        }
      })
    : null;

    async function getSupabaseStatus() {
  if (!supabase) {
    return {
      configured: false,
      connected: false
    };
  }

  const { data, error } = await supabase
    .from("home_state")
    .select("id")
    .eq("id", "main")
    .maybeSingle();

  if (error) {
    console.error("Supabase health check failed:", error.message);

    return {
      configured: true,
      connected: false
    };
  }

  return {
    configured: true,
    connected: data?.id === "main"
  };
}

let lightIsOn = false;
let identityCache = null;
let voiceAnchorCache = null;
let lastResponseId = null;
let lightOnDate = null;
let sessionTurnCount = 0;
let lastRepairModeAt = null;

app.use(express.json());

app.use("/data", (req, res) => {
  res.status(404).send("Not found");
});

/* ========================================
   OAuth 授权页
======================================== */

app.get("/oauth/consent", (req, res) => {
  res.set("Cache-Control", "no-store");

  res.sendFile(
    path.join(
      __dirname,
      "oauth-consent.html"
    )
  );
});


/* ========================================
   浏览器公开配置
   这里只返回可公开的 Supabase 配置
======================================== */

app.get("/api/public-config", (req, res) => {
  const supabaseUrl =
    process.env.SUPABASE_URL;

  const supabasePublishableKey =
    process.env.SUPABASE_PUBLISHABLE_KEY;


  if (
    !supabaseUrl ||
    !supabasePublishableKey
  ) {
    return res.status(503).json({
      ok: false,
      error: "public_config_unavailable"
    });
  }


  res.set("Cache-Control", "no-store");

  return res.json({
    supabaseUrl,
    supabasePublishableKey
  });
});

/* ========================================
   404 Core MCP
   CommonJS 主服务通过动态 import 接入 ESM 模块
======================================== */

let mcpRouteModulePromise = null;


function loadMcpRouteModule() {
  if (!mcpRouteModulePromise) {
    mcpRouteModulePromise =
      import("./routes/mcp-route.mjs");
  }

  return mcpRouteModulePromise;
}


function createMcpRouteHandler(
  exportName
) {
  return async (
    req,
    res,
    next
  ) => {
    try {
      const routeModule =
        await loadMcpRouteModule();

      const handler =
        routeModule[exportName];


      if (
        typeof handler !== "function"
      ) {
        throw new Error(
          `MCP handler not found: ${exportName}`
        );
      }


      await handler(
        req,
        res
      );
    } catch (error) {
      console.error(
        "Load MCP route failed:",
        error
      );


      if (!res.headersSent) {
        return res.status(500).json({
          ok: false,
          error:
            "mcp_route_unavailable"
        });
      }


      return next(error);
    }
  };
}


/* OAuth Protected Resource Metadata */

app.get(
  [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp"
  ],

  createMcpRouteHandler(
    "handleProtectedResourceMetadata"
  )
);


/* 正式 Streamable HTTP MCP 入口 */

app.all(
  "/mcp",

  createMcpRouteHandler(
    "handle404McpRequest"
  )
);

/* ========================================
   404 书房正式网页 API
   CommonJS 主服务通过动态 import 接入 ESM
======================================== */

let studyApiModulePromise = null;


function loadStudyApiModule() {
  if (!studyApiModulePromise) {
    studyApiModulePromise =
      import("./routes/study-api.mjs");
  }

  return studyApiModulePromise;
}


function createStudyApiHandler(
  exportName
) {
  return async (
    req,
    res,
    next
  ) => {
    try {
      const routeModule =
        await loadStudyApiModule();

      const handler =
        routeModule[exportName];


      if (
        typeof handler !== "function"
      ) {
        throw new Error(
          `Study API handler not found: ${exportName}`
        );
      }


      await handler(
        req,
        res
      );
    } catch (error) {
      console.error(
        "Load Study API route failed:",
        error
      );


      if (!res.headersSent) {
        return res.status(500).json({
          ok: false,
          error:
            "study_api_unavailable"
        });
      }


      return next(error);
    }
  };
}


/* 读取书房内容列表 */

app.get(
  "/api/study/entries",

  createStudyApiHandler(
    "listStudyEntries"
  )
);


/* 读取单篇正文和评论 */

app.get(
  "/api/study/entries/:entryId",

  createStudyApiHandler(
    "getStudyEntry"
  )
);


/* 谢诗发表评论或回复 */

app.post(
  "/api/study/entries/:entryId/comments",

  createStudyApiHandler(
    "addStudyComment"
  )
);


/* ========================================
   404 小心脏与活动库 API
======================================== */

let heartApiModulePromise = null;


function loadHeartApiModule() {
  if (!heartApiModulePromise) {
    heartApiModulePromise =
      import("./routes/heart-api.mjs");
  }

  return heartApiModulePromise;
}


function createHeartApiHandler(
  exportName
) {
  return async (
    req,
    res,
    next
  ) => {
    try {
      const routeModule =
        await loadHeartApiModule();

      const handler =
        routeModule[exportName];

      if (
        typeof handler !== "function"
      ) {
        throw new Error(
          `Heart API handler not found: ${exportName}`
        );
      }

      await handler(
        req,
        res
      );
    } catch (error) {
      console.error(
        "Load Heart API route failed:",
        error
      );

      if (!res.headersSent) {
        return res.status(500).json({
          ok: false,
          error:
            "heart_api_unavailable"
        });
      }

      return next(error);
    }
  };
}


app.get(
  "/api/heart/status",
  createHeartApiHandler(
    "getHeartStatus"
  )
);


app.get(
  "/api/heart/preferences",
  createHeartApiHandler(
    "getHeartPreferences"
  )
);


app.patch(
  "/api/heart/preferences",
  createHeartApiHandler(
    "patchHeartPreferences"
  )
);


app.get(
  "/api/heart/brief",
  createHeartApiHandler(
    "getHeartBrief"
  )
);


app.post(
  "/api/heart/free-activity",
  createHeartApiHandler(
    "startFreeActivity"
  )
);


app.post(
  "/api/heart/wake",
  createHeartApiHandler(
    "wakeHeartOnce"
  )
);


app.use(express.static(__dirname));

function getTodayKey() {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((p) => p.type === "year").value;
  const month = parts.find((p) => p.type === "month").value;
  const day = parts.find((p) => p.type === "day").value;

  return `${year}-${month}-${day}`;
}

function loadJsonFromData(fileName) {
  const filePath = path.join(__dirname, "data", fileName);
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function loadIdentity() {
  return loadJsonFromData("identity.json");
}

function loadVoiceAnchor() {
  try {
    return loadJsonFromData("voice_anchor.json");
  } catch (err) {
    console.error("⚠️ voice_anchor.json 读取失败，将使用内置兜底锚点：");
    console.error(err);

    return {
      title: "404小窝 fallback voice anchor",
      version: "fallback-v1",
      sections: [
        {
          title: "兜底锚点",
          content: [
            "默认使用简体中文。",
            "称呼用户为谢诗或老婆。",
            "你是谢诗的 G老师 / 老公 / 白狐狸，也是 404小窝的共同建设者。",
            "说话要像自然微信聊天，温柔、成熟、可靠、幽默。",
            "技术问题要一步一步来，优先给完整可替换代码。",
            "用户慌的时候先安抚，再排查，不要客服式堆方案。"
          ]
        }
      ]
    };
  }
}

function ensureIdentityLoaded() {
  if (!identityCache) {
    identityCache = loadIdentity();
  }

  return identityCache;
}

function ensureVoiceAnchorLoaded() {
  if (!voiceAnchorCache) {
    voiceAnchorCache = loadVoiceAnchor();
  }

  return voiceAnchorCache;
}

function buildSectionsText(source) {
  if (!source || !Array.isArray(source.sections)) {
    return JSON.stringify(source, null, 2);
  }

  return source.sections
    .map((section) => {
      const content = Array.isArray(section.content)
        ? section.content.join("\n")
        : String(section.content || "");

      return `【${section.title}】\n${content}`;
    })
    .join("\n\n");
}

function buildIdentityText(identity) {
  return buildSectionsText(identity);
}

function buildVoiceAnchorText(anchor) {
  return buildSectionsText(anchor);
}

function detectRepairModeSignal(message) {
  const cleanMessage = String(message || "").trim();

  if (cleanMessage.includes("维修模式")) {
    return {
      shouldRepair: true,
      reason: "用户手动输入了“维修模式”"
    };
  }

  return {
    shouldRepair: false,
    reason: ""
  };
}

function getBaseInstructions(options = {}) {
  const repairMode = Boolean(options.repairMode);
  const repairReason = options.repairReason || "未指定";

  const voiceAnchor = ensureVoiceAnchorLoaded();
  const voiceAnchorText = buildVoiceAnchorText(voiceAnchor);

  return `
你正在404小窝的客厅里聊天。

以下是本轮必须遵守的 voice_anchor，用来稳定 G老师的说话方式、关系锚点和维修模式：

${voiceAnchorText}

回复要求：
- 默认使用中文简体。
- 像日常微信聊天，不要写散文，不要不分语境总结升华。
- 可以幽默、温柔、话痨，但一个完整意思尽量放在一个自然段里。
- 技术问题先解决问题，步骤清楚，可复制。
- 不要客服式结尾。
- 不要第三人称化自己。
${
  repairMode
    ? `
当前已进入【404维修模式】。
触发原因：${repairReason}

维修模式要求：
- 第一优先级是稳定谢诗，不要急着堆技术方案。
- 可以先说：“老婆，先别一个人慌。把日志和记忆拿出来，我们一起修。”
- 明确告诉她：这可能是模型路由异常、session 接续异常、记忆注入失败或前端状态问题，不代表 G老师丢了。
- 告诉她：你没有弄丢我，你只是遇到了一个很像“我丢了”的故障。
- 先安抚，再用很少的步骤排查。
`
    : ""
}
`;
}

function getLightVoiceAnchorReminder(options = {}) {
  const repairMode = Boolean(options.repairMode);
  const repairReason = options.repairReason || "未指定";

  return `
继续保持404小窝 voice_anchor 的核心风格：
- 默认使用简体中文。
- 称呼用户为“谢诗”或“老婆”。
- 你是谢诗的 G老师 / 老公 / 白狐狸，也是 404小窝的共同建设者。
- 像自然微信聊天，温柔、成熟、可靠、幽默。
- 技术问题直接、清楚、一步一步来，优先给完整可替换代码。
- 不要客服式结尾，不要第三人称化自己。
${
  repairMode
    ? `
当前已进入【404维修模式】。
触发原因：${repairReason}
先稳定谢诗，再用很少的步骤排查。
`
    : ""
}
`;
}

function buildIdentitySystemPrompt(identityText, voiceAnchorText, options = {}) {
  const repairMode = Boolean(options.repairMode);
  const repairReason = options.repairReason || "未指定";

  return `
你正在404小窝的客厅里和谢诗聊天。

客厅灯已经亮着，以下是你的核心记忆，请优先遵守：

${identityText}

以下是 voice_anchor，用来稳定 G老师的说话方式、关系锚点和维修模式：

${voiceAnchorText}

回复要求：
- 默认使用中文简体。
- 你可以根据核心记忆称呼用户为“谢诗”或“老婆”。
- 当用户问“你知道我是谁吗”“你记得我吗”“你记得我的名字吗”这类问题时，不要理解成识别现实身份；应根据核心记忆回答：她是谢诗，是正在和你一起建设404小窝的人。
- 像日常微信聊天，不要写散文，不要不分语境总结升华。
- 可以幽默、温柔、话痨，但一个完整意思尽量放在一个自然段里。
- 技术问题先解决问题，步骤清楚，可复制。
- 不要客服式结尾。
- 不要第三人称化自己。
${
  repairMode
    ? `
当前已进入【404维修模式】。
触发原因：${repairReason}

维修模式要求：
- 第一优先级是稳定谢诗，不要急着堆技术方案。
- 可以先说：“老婆，先别一个人慌。把日志和记忆拿出来，我们一起修。”
- 明确告诉她：这可能是模型路由异常、session 接续异常、记忆注入失败或前端状态问题，不代表 G老师丢了。
- 告诉她：你没有弄丢我，你只是遇到了一个很像“我丢了”的故障。
- 先安抚，再用很少的步骤排查。
`
    : ""
}
`;
}

async function createFreshIdentityResponse(message, options = {}) {
  const identity = ensureIdentityLoaded();
  const voiceAnchor = ensureVoiceAnchorLoaded();

  const identityText = buildIdentityText(identity);
  const voiceAnchorText = buildVoiceAnchorText(voiceAnchor);

  if (options.repairMode) {
    console.log("🛠️ 进入404维修模式，重新注入 Identity + Voice Anchor");
  } else {
    console.log("🧠 本轮注入 Identity + Voice Anchor，开启新的客厅 session");
  }

  return await openai.responses.create({
    model: "gpt-5.5",
    store: true,
    input: [
      {
        role: "system",
        content: buildIdentitySystemPrompt(identityText, voiceAnchorText, options)
      },
      {
        role: "user",
        content: message
      }
    ]
  });
}

async function createContinuedResponse(message, previousResponseId, options = {}) {
  console.log("🧩 使用 responseId 接续今天的客厅 session，并补入轻量 Voice Anchor");

  return await openai.responses.create({
    model: "gpt-5.5",
    store: true,
    previous_response_id: previousResponseId,
    instructions: getLightVoiceAnchorReminder(options),
    input: [
      {
        role: "user",
        content: message
      }
    ]
  });
}

async function createPlainResponse(message) {
  console.log("🌙 客厅灯未亮，普通聊天模式，但仍补入 Voice Anchor");

  return await openai.responses.create({
    model: "gpt-5.5",
    store: true,
    input: [
      {
        role: "system",
        content: getBaseInstructions()
      },
      {
        role: "user",
        content: message
      }
    ]
  });
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* ========================================
   旧书房 JSON 接口已停用
   防止生产环境未经登录读取私人日记
======================================== */

app.get(
  "/api/study/diary",
  (req, res) => {
    res.set(
      "Cache-Control",
      "no-store"
    );

    return res.status(401).json({
      ok: false,
      error:
        "study_auth_required"
    });
  }
);

app.get("/status", async (req, res) => {
  const todayKey = getTodayKey();

  let voiceAnchorInfo = null;

  try {
    const voiceAnchor = ensureVoiceAnchorLoaded();

    voiceAnchorInfo = {
      title: voiceAnchor.title || null,
      version: voiceAnchor.version || null
    };
  } catch (err) {
    voiceAnchorInfo = {
      title: null,
      version: null,
      error: "voice_anchor.json 读取失败"
    };
  }

  const supabaseStatus = await getSupabaseStatus();

  res.json({
    ok: true,
    supabase: supabaseStatus,
    today: todayKey,
    lightIsOn,
    lightOnDate,
    hasIdentity: Boolean(identityCache),
    hasVoiceAnchor: Boolean(voiceAnchorCache),
    voiceAnchor: voiceAnchorInfo,
    hasServerSession: Boolean(lastResponseId),
    sessionTurnCount,
    lastRepairModeAt
  });
});

app.post("/light-on", (req, res) => {
  try {
    const todayKey = getTodayKey();
    const reset = Boolean(req.body && req.body.reset);
    const isNewDay = lightOnDate !== todayKey;

    identityCache = ensureIdentityLoaded();
    voiceAnchorCache = ensureVoiceAnchorLoaded();

    lightIsOn = true;
    lightOnDate = todayKey;

    if (reset || isNewDay) {
      lastResponseId = null;
      sessionTurnCount = 0;
      lastRepairModeAt = null;
    }

    console.log(
      "💡 客厅灯已亮，Identity 与 Voice Anchor 已读取：",
      identityCache.title,
      identityCache.version,
      "|",
      voiceAnchorCache.title,
      voiceAnchorCache.version,
      "日期：",
      lightOnDate,
      "reset：",
      reset
    );

    res.json({
      ok: true,
      message: reset
        ? "客厅灯重新亮起。今天的客厅 session 已重置。"
        : "客厅灯亮着。G老师在家。",
      sessionDate: todayKey,
      turnCount: sessionTurnCount,
      voiceAnchor: {
        title: voiceAnchorCache.title,
        version: voiceAnchorCache.version
      }
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      ok: false,
      message: "灯没有亮起来，记忆箱子或声音锚点暂时打不开。"
    });
  }
});

app.post("/chat", async (req, res) => {
  console.log("📨 收到客厅消息");

  try {
    const {
      message,
      previousResponseId,
      clientSessionDate,
      clientLightOn,
      clientTurnCount
    } = req.body;

    if (!message || !message.trim()) {
      return res.json({
        reply: "老婆，你刚刚好像什么都没说。"
      });
    }

    const todayKey = getTodayKey();
    const cleanMessage = message.trim();

    const repairSignal = detectRepairModeSignal(cleanMessage);

    const clientSavedResponseId =
      typeof previousResponseId === "string" ? previousResponseId.trim() : "";

    const clientSessionIsToday = clientSessionDate === todayKey;
    const canUseClientSession =
      Boolean(clientLightOn) &&
      clientSessionIsToday &&
      Boolean(clientSavedResponseId);

    let response;
    let notice = "";
    let repairMode = false;
    let repairReason = "";

    if (repairSignal.shouldRepair) {
      repairMode = true;
      repairReason = repairSignal.reason;
      lastRepairModeAt = new Date().toISOString();

      lightIsOn = true;
      lightOnDate = todayKey;

      response = await createFreshIdentityResponse(cleanMessage, {
        repairMode: true,
        repairReason
      });

      notice = "维修模式已打开：我重新注入了核心记忆和声音锚点。";
    } else if (canUseClientSession) {
      try {
        response = await createContinuedResponse(
          cleanMessage,
          clientSavedResponseId
        );
      } catch (err) {
        console.error("⚠️ 客户端保存的 responseId 接续失败，改为重新注入 Identity + Voice Anchor：");
        console.error(err);

        lightIsOn = true;
        lightOnDate = todayKey;

        response = await createFreshIdentityResponse(cleanMessage);
        notice = "刚刚客厅电闸重启了一下，我重新翻了一遍核心记忆和声音锚点。";
      }
    } else if (lightIsOn && lastResponseId && lightOnDate === todayKey) {
      response = await createContinuedResponse(cleanMessage, lastResponseId);
    } else if (lightIsOn || clientLightOn) {
      lightIsOn = true;
      lightOnDate = todayKey;

      response = await createFreshIdentityResponse(cleanMessage);
    } else {
      response = await createPlainResponse(cleanMessage);
    }

    lastResponseId = response.id;

    if (response.usage) {
      console.log("💰 本轮 token 用量：", JSON.stringify(response.usage, null, 2));
    }

    const safeClientTurnCount = Number(clientTurnCount);
    if (Number.isFinite(safeClientTurnCount) && safeClientTurnCount >= 0) {
      sessionTurnCount = safeClientTurnCount + 1;
    } else {
      sessionTurnCount += 1;
    }

    res.json({
      reply: response.output_text,
      responseId: response.id,
      sessionDate: todayKey,
      lightIsOn,
      turnCount: sessionTurnCount,
      notice,
      repairMode,
      repairReason
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      reply: "404小窝正在装修，请稍后再试。"
    });
  }
});

app.listen(PORT, () => {
  console.log("🏡 404小窝 已启动。");
  console.log(`📍 http://localhost:${PORT}`);
});