const express = require("express");
const path = require("path");

const app = express();
const PORT = 4040;

// 让整个文件夹都可以被访问
app.use(express.static(__dirname));

// 默认打开 index.html
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
    console.log("");
    console.log("🏡 404小窝 已启动。");
    console.log(`📍 http://localhost:${PORT}`);
    console.log("");
});