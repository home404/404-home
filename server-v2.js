require("dotenv").config();


/*
  404 主服务 v2 启动器

  旧 server.js 目前仍承担卧室聊天和既有 API。
  为了不在一次施工里重写整台老机器，这里先捕获它创建的
  Express app，再追加全屋调度器、客厅控制台与手机连接桥路由。

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


function createLazyRouteLoader({
  modulePath,
  label,
  fallbackError
}) {
  let modulePromise = null;

  function loadModule() {
    if (!modulePromise) {
      modulePromise = import(modulePath);
    }

    return modulePromise;
  }

  return function createHandler(
    exportName
  ) {
    return async (
      req,
      res,
      next
    ) => {
      try {
        const routeModule =
          await loadModule();
        const handler =
          routeModule[exportName];

        if (
          typeof handler !== "function"
        ) {
          throw new Error(
            `${label} handler not found: ${exportName}`
          );
        }

        await handler(req, res);
      } catch (error) {
        console.error(
          `Load ${label} API failed:`,
          error
        );

        if (!res.headersSent) {
          return res.status(500).json({
            ok: false,
            error: fallbackError
          });
        }

        return next(error);
      }
    };
  };
}


const createOrchestrationHandler =
  createLazyRouteLoader({
    modulePath:
      "./routes/home-orchestration-api.mjs",
    label: "Home Orchestration",
    fallbackError:
      "home_orchestration_api_unavailable"
  });

const createLivingRoomHandler =
  createLazyRouteLoader({
    modulePath:
      "./routes/living-room-api.mjs",
    label: "Living Room",
    fallbackError:
      "living_room_api_unavailable"
  });

const createShortcutBridgeHandler =
  createLazyRouteLoader({
    modulePath:
      "./routes/shortcut-bridge-api.mjs",
    label: "Shortcut Bridge",
    fallbackError:
      "shortcut_bridge_api_unavailable"
  });


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


/* 客厅日常入口：签发通行证、看进度和随时加预算。 */

capturedApp.get(
  "/api/living-room/status",
  createLivingRoomHandler(
    "getLivingRoomStatus"
  )
);

capturedApp.post(
  "/api/living-room/free-activity",
  createLivingRoomHandler(
    "grantLivingRoomPass"
  )
);

capturedApp.patch(
  "/api/living-room/free-activity/:activityPassId",
  createLivingRoomHandler(
    "updateLivingRoomPass"
  )
);


/*
  iPhone 快捷指令只调用这两条极轻量接口。
  它们只更新 Supabase 状态，不调用 OpenAI。
*/

capturedApp.post(
  "/api/bridge/official/start",
  createShortcutBridgeHandler(
    "startOfficialChatBridge"
  )
);

capturedApp.post(
  "/api/bridge/official/end",
  createShortcutBridgeHandler(
    "endOfficialChatBridge"
  )
);


console.log(
  "🧠 全屋调度器、客厅控制台与手机连接桥 API 已挂载；自动心跳发布总闸默认关闭。"
);
