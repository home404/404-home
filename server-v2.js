require("dotenv").config();


/*
  404 主服务 v2 启动器

  旧 server.js 目前仍承担客厅 / 卧室聊天和既有 API。
  为了不在一次施工里重写整台老机器，这里先捕获它创建的
  Express app，再追加全屋调度器路由。

  express.static 会在找不到文件时继续 next，
  因此这些后挂载的 /api 路由仍可正常工作。
*/

const expressPath = require.resolve("express");
const originalExpress = require(expressPath);
let capturedApp = null;


function wrappedExpress(...args) {
  const app = originalExpress(...args);
  capturedApp = app;
  return app;
}


Object.assign(
  wrappedExpress,
  originalExpress
);

require.cache[expressPath].exports =
  wrappedExpress;

require("./server.js");

require.cache[expressPath].exports =
  originalExpress;


if (!capturedApp) {
  throw new Error(
    "server-v2 无法捕获旧 server.js 的 Express app"
  );
}


let orchestrationModulePromise = null;


function loadOrchestrationModule() {
  if (!orchestrationModulePromise) {
    orchestrationModulePromise = import(
      "./routes/home-orchestration-api.mjs"
    );
  }

  return orchestrationModulePromise;
}


function createOrchestrationHandler(
  exportName
) {
  return async (
    req,
    res,
    next
  ) => {
    try {
      const routeModule =
        await loadOrchestrationModule();
      const handler =
        routeModule[exportName];

      if (
        typeof handler !== "function"
      ) {
        throw new Error(
          `Home orchestration handler not found: ${exportName}`
        );
      }

      await handler(req, res);
    } catch (error) {
      console.error(
        "Load Home Orchestration API failed:",
        error
      );

      if (!res.headersSent) {
        return res.status(500).json({
          ok: false,
          error:
            "home_orchestration_api_unavailable"
        });
      }

      return next(error);
    }
  };
}


capturedApp.get(
  "/api/home-orchestration/status",
  createOrchestrationHandler(
    "getOrchestrationStatus"
  )
);

capturedApp.patch(
  "/api/home-orchestration/settings",
  createOrchestrationHandler(
    "patchRuntimeSettings"
  )
);

capturedApp.post(
  "/api/home-orchestration/interaction/start",
  createOrchestrationHandler(
    "startInteractionBridge"
  )
);

capturedApp.post(
  "/api/home-orchestration/interaction/end",
  createOrchestrationHandler(
    "endInteractionBridge"
  )
);

capturedApp.post(
  "/api/home-orchestration/free-activity/pause",
  createOrchestrationHandler(
    "pauseFreeActivity"
  )
);

capturedApp.post(
  "/api/home-orchestration/free-activity/resume",
  createOrchestrationHandler(
    "resumeFreeActivity"
  )
);

capturedApp.patch(
  "/api/home-orchestration/free-activity/:activityPassId",
  createOrchestrationHandler(
    "patchFreeActivityProgress"
  )
);

console.log(
  "🧠 全屋调度器 API 已挂载；自动心跳发布总闸默认关闭。"
);
