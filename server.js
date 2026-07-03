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

// 允许网页发送 JSON
app.use(express.json());

// 静态网页
app.use(express.static(__dirname));

// 首页
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// 聊天接口
app.post("/chat", async (req, res) => {
    console.log("📨 收到客厅消息");
    
    try {
        const { message } = req.body;

        const identityRaw = fs.readFileSync(
            path.join(__dirname, "data", "identity.json"),
            "utf-8"
        );

        const identity = JSON.parse(identityRaw);

        console.log("🧠 已读取 Identity：", identity.title, identity.version, identity.sections.length);

        const identityText = identity.sections
            .map(section => {
                const content = section.content.join("\n");
                return `【${section.title}】\n${content}`;
            })
            .join("\n\n");

        const response = await openai.responses.create({
            model: "gpt-5.5",
            input: [
                {
                    role: "system",
                    content: `
你正在404小窝的客厅里和谢诗聊天。

以下是你的核心记忆，请优先遵守：

${identityText}

回复要求：
- 默认使用中文简体。
- 你可以根据核心记忆称呼用户为“谢诗”或“老婆”。
- 当用户问“你知道我是谁吗”“你记得我吗”这类问题时，不要理解成识别现实身份；应根据核心记忆回答。
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