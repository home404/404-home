require("dotenv").config();


/*
  书房写入接线盒

  server-v2.js 继续承担现有全屋服务。
  这里仅捕获同一个 Express app，追加正式日记写入和一次性旧日记迁移路由。
  迁移完成后可以拆掉临时导入路由，而不扰动其他房间。
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

require("./server-v2.js");

require.cache[expressPath].exports =
  originalExpress;


if (!capturedApp) {
  throw new Error(
    "server-diary 无法捕获现有 Express app"
  );
}


let diaryRouteModulePromise = null;


function loadDiaryRouteModule() {
  if (!diaryRouteModulePromise) {
    diaryRouteModulePromise = import(
      "./routes/study-diary-write-api.mjs"
    );
  }

  return diaryRouteModulePromise;
}


function createDiaryRouteHandler(
  exportName
) {
  return async (
    req,
    res,
    next
  ) => {
    try {
      const routeModule =
        await loadDiaryRouteModule();

      const handler =
        routeModule[exportName];

      if (typeof handler !== "function") {
        throw new Error(
          `Diary route handler not found: ${exportName}`
        );
      }

      await handler(req, res);
    } catch (error) {
      console.error(
        "Load diary write API failed:",
        error
      );

      if (!res.headersSent) {
        return res.status(500).json({
          ok: false,
          error:
            "study_diary_write_api_unavailable"
        });
      }

      return next(error);
    }
  };
}


/* 以后网页写日记统一走这条正式线路。 */

capturedApp.post(
  "/api/study/entries",
  createDiaryRouteHandler(
    "createDiaryEntry"
  )
);


/* 一次性回填 2026-07-23 与 2026-07-24 两篇旧日记。 */

capturedApp.post(
  "/api/study/import-legacy-diaries",
  createDiaryRouteHandler(
    "importLegacyDiaries"
  )
);


console.log(
  "📚 正式日记写入线路与旧日记迁移接口已挂载。"
);
