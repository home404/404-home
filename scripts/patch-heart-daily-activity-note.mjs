import fs from "node:fs";

const filePath =
  "services/heart-service.mjs";

let source = fs.readFileSync(
  filePath,
  "utf8"
);


function replaceOnce(
  label,
  before,
  after
) {
  const count = source.split(before).length - 1;

  if (count !== 1) {
    throw new Error(
      `${label} expected exactly once, found ${count}`
    );
  }

  source = source.replace(
    before,
    after
  );
}


replaceOnce(
  "daily note import",
  `import {
  createStudyService
} from "./study-service.mjs";
`,
  `import {
  createStudyService
} from "./study-service.mjs";

import {
  createDailyActivityNoteService
} from "./daily-activity-note-service.mjs";
`
);

replaceOnce(
  "json action enum",
  `        "write_diary",
        "leave_message",
        "leave_note"
`,
  `        "write_diary",
        "leave_message"
`
);

replaceOnce(
  "zod action enum",
  `    "write_diary",
    "leave_message",
    "leave_note"
`,
  `    "write_diary",
    "leave_message"
`
);

replaceOnce(
  "prompt capability list",
  `1. 回复一条尚未回复的谢诗评论；
2. 写一篇短日记；
3. 给谢诗留一条留言；
4. 写一张小纸条；
5. 保持安静。
`,
  `1. 回复一条尚未回复的谢诗评论；
2. 写一篇短日记；
3. 给谢诗留一条留言；
4. 保持安静。

小纸条不属于你的自主动作菜单。程序会把当天发生的真实活动，自动续写到当天唯一的一张活动小纸条中。
`
);

replaceOnce(
  "prompt action output",
  `- action：silent / reply_comment / write_diary / leave_message / leave_note
`,
  `- action：silent / reply_comment / write_diary / leave_message
`
);

replaceOnce(
  "daily note service initialization",
  `  const studyService =
    createStudyService({
      dataClient:
        serviceClient,
      auditClient:
        serviceClient
    });


  async function ensurePresence({
`,
  `  const studyService =
    createStudyService({
      dataClient:
        serviceClient,
      auditClient:
        serviceClient
    });

  const dailyActivityNoteService =
    createDailyActivityNoteService({
      serviceClient,
      studyService,
      timeZone:
        SHANGHAI_TIME_ZONE
    });


  async function ensurePresence({
`
);

replaceOnce(
  "unused activity clock",
  `    const clock = formatClock(now);
`,
  ``
);

replaceOnce(
  "per-run note creation",
  `    if (
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
      \`\${clock}　\${eventTitle}\`;

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
            \`heart-\${runId}-paper\`
        },
        actor
      );

    paperEntry =
      paperResult.entry;
`,
  `    paperEntry =
      await dailyActivityNoteService
        .append({
          userId,
          actor,
          now,
          eventTitle,
          eventDetail,
          runId,
          heartbeatRunId,
          activityPass:
            activePass
        });
`
);

replaceOnce(
  "study room action condition",
  `        decision.action ===
          "leave_message" ||
        decision.action ===
          "leave_note"
          ? "study"
`,
  `        decision.action ===
          "leave_message"
          ? "study"
`
);

if (source.includes("leave_note")) {
  throw new Error(
    "heart-service still contains leave_note"
  );
}

fs.writeFileSync(
  filePath,
  source,
  "utf8"
);
