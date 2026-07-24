require("dotenv").config();


/*
  404 主服务 v2 启动器

  旧 server.js 目前仍承担卧室聊天和既有 API。
  为了不在一次施工里重写整台老机器，这里先捕获它创建的
  Express app，再追加全屋调度器、客厅控制台、卧室消息、文字总账与手机连接桥路由。
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

const createInteractionGuardHandler =
  createLazyRouteLoader({
    modulePath:
      "./routes/interaction-guard-api.mjs",
    label: "Interaction Guard",
    fallbackError:
      "interaction_guard_api_unavailable"
  });

const createActivityClockHandler =
  createLazyRouteLoader({
    modulePath:
      "./routes/activity-clock-api.mjs",
    label: "Activity Clock",
    fallbackError:
      "activity_clock_api_unavailable"
  });

const createLivingRoomHandler =
  createLazyRouteLoader({
    modulePath:
      "./routes/living-room-api.mjs",
    label: "Living Room",
    fallbackError:
      "living_room_api_unavailable"
  });

const createLivingRoomV2Handler =
  createLazyRouteLoader({
    modulePath:
      "./routes/living-room-v2-api.mjs",
    label: "Living Room v2",
    fallbackError:
      "living_room_v2_api_unavailable"
  });

const createBedroomHandler =
  createLazyRouteLoader({
    modulePath:
      "./routes/bedroom-api.mjs",
    label: "Bedroom",
    fallbackError:
      "bedroom_api_unavailable"
  });

const createBedroomMessagesHandler =
  createLazyRouteLoader({
    modulePath:
      "./routes/bedroom-messages-api.mjs",
    label: "Bedroom Messages",
    fallbackError:
      "bedroom_messages_api_unavailable"
  });

const createTextLedgerHandler =
  createLazyRouteLoader({
    modulePath:
      "./routes/text-ledger-api.mjs",
    label: "Text Ledger",
    fallbackError:
      "text_ledger_api_unavailable"
  });

const createShortcutBridgeHandler =
  createLazyRouteLoader({
    modulePath:
      "./routes/shortcut-bridge-api.mjs",
    label: "Shortcut Bridge",
    fallbackError:
      "shortcut_bridge_api_unavailable"
  });

const createHomeWebPresenceHandler =
  createLazyRouteLoader({
    modulePath:
      "./routes/home-web-presence-api.mjs",
    label: "Home Web Presence",
    fallbackError:
      "home_web_presence_api_unavailable"
  });

const createStudyCommentDeleteHandler =
  createLazyRouteLoader({
    modulePath:
      "./routes/study-comment-delete-api.mjs",
    label: "Study Comment Delete",
    fallbackError:
      "study_comment_delete_api_unavailable"
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
  createInteractionGuardHandler(
    "startInteractionBridge"
  )
);

capturedApp.post(
  "/api/home-orchestration/interaction/end",
  createActivityClockHandler(
    "endInteraction"
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
  createActivityClockHandler(
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

/* 客厅 v2：安全调预算、统一活动时钟、完成或取消通行证。 */

capturedApp.patch(
  "/api/living-room-v2/free-activity/:activityPassId",
  createLivingRoomV2Handler(
    "updateLivingRoomPassSafely"
  )
);

capturedApp.post(
  "/api/living-room-v2/free-activity/:activityPassId/finish",
  createLivingRoomV2Handler(
    "finishLivingRoomPass"
  )
);


/* 旧卧室聊天链仍保留小纸条 API，方便已有原文继续安全收尾。 */

capturedApp.post(
  "/api/bedroom/segment-summary",
  createBedroomHandler(
    "createSegmentSummary"
  )
);


/* 新卧室只显示 G 主动发来的独立消息；浏览器实时订阅并用轮询兜底。 */

capturedApp.get(
  "/api/bedroom/messages",
  createBedroomMessagesHandler(
    "listBedroomMessages"
  )
);

capturedApp.post(
  "/api/bedroom/messages/read",
  createBedroomMessagesHandler(
    "markBedroomMessagesRead"
  )
);


/* 手机文字总账：查看正文、归档、取消归档与手动删除。 */

capturedApp.get(
  "/api/text-ledger/items",
  createTextLedgerHandler(
    "listTextItems"
  )
);

capturedApp.get(
  "/api/text-ledger/items/:sourceType/:sourceId",
  createTextLedgerHandler(
    "getTextItem"
  )
);

capturedApp.patch(
  "/api/text-ledger/items/:sourceType/:sourceId/archive",
  createTextLedgerHandler(
    "patchTextItemArchive"
  )
);

capturedApp.delete(
  "/api/text-ledger/items/:sourceType/:sourceId",
  createTextLedgerHandler(
    "deleteTextItem"
  )
);


/* 屋主可在书房长按评论；删除父评论时一并清理它下面的回复。 */

capturedApp.delete(
  "/api/study/comments/:commentId",
  createStudyCommentDeleteHandler(
    "deleteStudyComment"
  )
);


/*
  首页打开后续一张短租约。
  只暂停自动心跳，不结束官端缓冲，也不暂停自由活动。
*/

capturedApp.post(
  "/api/heart/home-presence",
  createHomeWebPresenceHandler(
    "markHomeWebPresence"
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
  "🧠 全屋调度器、客厅、卧室消息、文字总账、书房评论删除与手机连接桥 API 已挂载；自动心跳发布总闸默认关闭。"
);
