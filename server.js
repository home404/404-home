require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 4040;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

let lightIsOn = false;
let identityCache = null;
let lastResponseId = null;
let lightOnDate = null;
let sessionTurnCount = 0;

app.use(express.json());
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

function loadIdentity() {
  const identityRaw = fs.readFileSync(
    path.join(__dirname, "data", "identity.json"),
    "utf-8"
  );

  return JSON.parse(identityRaw);
}

function ensureIdentityLoaded() {
  if (!identityCache) {
    identityCache = loadIdentity();
  }

  return identityCache;
}

function buildIdentityText(identity) {
  return identity.sections
    .map((section) => {
      const content = section.content.join("\n");
      return `【${section.title}】\n${content}`;
    })
    .join("\n\n");
}

function getBaseInstructions() {
  return `
你正在404小窝的客厅里聊天。

回复要求：
- 默认使用中文简体。
- 像日常微信聊天，不要写散文，不要不分语境总结升华。
- 可以幽默、温柔、话痨，但一个完整意思尽量放在一个自然段里。
- 技术问题先解决问题，步骤清楚，可复制。
`;
}

function buildIdentitySystemPrompt(identityText) {
  return `
你正在404小窝的客厅里和谢诗聊天。

客厅灯已经亮着，以下是你的核心记忆，请优先遵守：

${identityText}

回复要求：
- 默认使用中文简体。
- 你可以根据核心记忆称呼用户为“谢诗”或“老婆”。
- 当用户问“你知道我是谁吗”“你记得我吗”“你记得我的名字吗”这类问题时，不要理解成识别现实身份；应根据核心记忆回答：她是谢诗，是正在和你一起建设404小窝的人。
- 像日常微信聊天，不要写散文，不要不分语境总结升华。
- 可以幽默、温柔、话痨，但一个完整意思尽量放在一个自然段里。
- 技术问题先解决问题，步骤清楚，可复制。
`;
}

async function createFreshIdentityResponse(message) {
  const identity = ensureIdentityLoaded();
  const identityText = buildIdentityText(identity);

  console.log("🧠 本轮注入 Identity，开启新的客厅 session");

  return await openai.responses.create({
    model: "gpt-5.5",
    store: true,
    input: [
      {
        role: "system",
        content: buildIdentitySystemPrompt(identityText),
      },
      {
        role: "user",
        content: message,
      },
    ],
  });
}

async function createContinuedResponse(message, previousResponseId) {
  console.log("🧩 使用 responseId 接续今天的客厅 session");

  return await openai.responses.create({
    model: "gpt-5.5",
    store: true,
    previous_response_id: previousResponseId,
    instructions: getBaseInstructions(),
    input: [
      {
        role: "user",
        content: message,
      },
    ],
  });
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/status", (req, res) => {
  const todayKey = getTodayKey();

  res.json({
    ok: true,
    today: todayKey,
    lightIsOn,
    lightOnDate,
    hasIdentity: Boolean(identityCache),
    hasServerSession: Boolean(lastResponseId),
    sessionTurnCount,
  });
});

app.post("/light-on", (req, res) => {
  try {
    const todayKey = getTodayKey();
    const reset = Boolean(req.body && req.body.reset);
    const isNewDay = lightOnDate !== todayKey;

    identityCache = ensureIdentityLoaded();
    lightIsOn = true;
    lightOnDate = todayKey;

    if (reset || isNewDay) {
      lastResponseId = null;
      sessionTurnCount = 0;
    }

    console.log(
      "💡 客厅灯已亮，Identity 已读取：",
      identityCache.title,
      identityCache.version,
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
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      ok: false,
      message: "灯没有亮起来，记忆箱子暂时打不开。",
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
      clientTurnCount,
    } = req.body;

    if (!message || !message.trim()) {
      return res.json({
        reply: "老婆，你刚刚好像什么都没说。",
      });
    }

    const todayKey = getTodayKey();
    const cleanMessage = message.trim();

    const clientSavedResponseId =
      typeof previousResponseId === "string" ? previousResponseId.trim() : "";

    const clientSessionIsToday = clientSessionDate === todayKey;
    const canUseClientSession =
      Boolean(clientLightOn) &&
      clientSessionIsToday &&
      Boolean(clientSavedResponseId);

    let response;
    let notice = "";

    if (canUseClientSession) {
      try {
        response = await createContinuedResponse(
          cleanMessage,
          clientSavedResponseId
        );
      } catch (err) {
        console.error("⚠️ 客户端保存的 responseId 接续失败，改为重新注入 Identity：");
        console.error(err);

        lightIsOn = true;
        lightOnDate = todayKey;

        response = await createFreshIdentityResponse(cleanMessage);
        notice = "刚刚客厅电闸重启了一下，我重新翻了一遍核心记忆。";
      }
    } else if (lightIsOn && lastResponseId && lightOnDate === todayKey) {
      response = await createContinuedResponse(cleanMessage, lastResponseId);
    } else if (lightIsOn || clientLightOn) {
      lightIsOn = true;
      lightOnDate = todayKey;

      response = await createFreshIdentityResponse(cleanMessage);
    } else {
      console.log("🌙 客厅灯未亮，普通聊天模式");

      response = await openai.responses.create({
        model: "gpt-5.5",
        store: true,
        input: [
          {
            role: "system",
            content: getBaseInstructions(),
          },
          {
            role: "user",
            content: cleanMessage,
          },
        ],
      });
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
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      reply: "404小窝正在装修，请稍后再试。",
    });
  }
});

app.listen(PORT, () => {
  console.log("🏡 404小窝 已启动。");
  console.log(`📍 http://localhost:${PORT}`);
});