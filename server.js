require("dotenv").config();

const express = require("express");
const OpenAI = require("openai");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 4040;

// 创建 OpenAI 客户端
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// 客厅状态
let lightIsOn = false;
let identityCache = null;
let lastResponseId = null;

// 允许网页发送 JSON
app.use(express.json());

// 静态网页
app.use(express.static(__dirname));

// 首页
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// 开灯接口：读取核心记忆，但不调用 OpenAI，所以这一步本身不花 token
app.post("/light-on", (req, res) => {
    try {
        const identityRaw = fs.readFileSync(
            path.join(__dirname, "data", "identity.json"),
            "utf-8"
        );

        identityCache = JSON.parse(identityRaw);
        lightIsOn = true;
        lastResponseId = null;

        console.log("💡 客厅灯已亮，Identity 已读取：", identityCache.title, identityCache.version);

        res.json({
            ok: true,
            message: "客厅灯亮着。G老师在家。"
        });
    } catch (err) {
        console.error(err);

        res.status(500).json({
            ok: false,
            message: "灯没有亮起来，记忆箱子暂时打不开。"
        });
    }
});

// 聊天接口
app.post("/chat", async (req, res) => {
    console.log("📨 收到客厅消息");

    try {
        const { message } = req.body;

        if (!message || !message.trim()) {
            return res.json({
                reply: "老婆，你刚刚好像什么都没说。"
            });
        }

        let response;

        const baseInstructions = `
你正在404小窝的客厅里聊天。

回复要求：
- 默认使用中文简体。
- 像日常微信聊天，不要写散文，不要不分语境总结升华。
- 可以幽默、温柔、话痨，但一个完整意思尽量放在一个自然段里。
- 技术问题先解决问题，步骤清楚，可复制。
`;

        // 情况一：灯亮了，但还没有 session
        // 这是开灯后的第一轮聊天：注入完整 Identity，并开启新的客厅 session
        if (lightIsOn && identityCache && !lastResponseId) {
            const identityText = identityCache.sections
                .map(section => {
                    const content = section.content.join("\n");
                    return `【${section.title}】\n${content}`;
                })
                .join("\n\n");

            console.log("🧠 本轮注入 Identity，开启新的客厅 session");

            response = await openai.responses.create({
                model: "gpt-5.5",
                store: true,
                input: [
                    {
                        role: "system",
                        content: `
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
`
                    },
                    {
                        role: "user",
                        content: message
                    }
                ]
            });
        }

        // 情况二：灯亮了，而且已经有 session
        // 后续聊天接着上一轮，不重复注入完整 Identity
        else if (lightIsOn && lastResponseId) {
            console.log("🧵 使用已有客厅 session，不重复注入 Identity");

            response = await openai.responses.create({
                model: "gpt-5.5",
                store: true,
                previous_response_id: lastResponseId,
                instructions: baseInstructions,
                input: [
                    {
                        role: "user",
                        content: message
                    }
                ]
            });
        }

        // 情况三：没开灯
        // 普通聊天，不带 Identity
        else {
            console.log("🌙 客厅灯未亮，普通聊天模式");

            response = await openai.responses.create({
                model: "gpt-5.5",
                store: true,
                input: [
                    {
                        role: "system",
                        content: baseInstructions
                    },
                    {
                        role: "user",
                        content: message
                    }
                ]
            });
        }

        lastResponseId = response.id;

        res.json({
            reply: response.output_text
        });

    } catch (err) {
        console.error(err);

        res.status(500).json({
            reply: "404小窝正在装修，请稍后再试。"
        });
    }
});

app.listen(PORT, () => {
    console.log("");
    console.log("🏡 404小窝 已启动。");
    console.log(`📍 http://localhost:${PORT}`);
    console.log("");
});