import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDailyActivityLine,
  getDailyActivityDateKey
} from "../services/daily-activity-note-service.mjs";


test(
  "daily activity date follows Asia/Shanghai local day",
  () => {
    assert.equal(
      getDailyActivityDateKey(
        new Date("2026-07-23T16:05:00.000Z")
      ),
      "2026-07-24"
    );
  }
);


test(
  "daily activity line includes local clock and concise detail",
  () => {
    assert.equal(
      buildDailyActivityLine({
        date: new Date(
          "2026-07-23T22:30:00.000Z"
        ),
        eventTitle:
          "给你留了一条留言",
        eventDetail:
          "早，老婆。今天先慢慢醒来。"
      }),
      "- 06:30｜给你留了一条留言 — 早，老婆。今天先慢慢醒来。"
    );
  }
);


test(
  "daily activity line does not repeat identical title and detail",
  () => {
    assert.equal(
      buildDailyActivityLine({
        date: new Date(
          "2026-07-23T22:30:00.000Z"
        ),
        eventTitle:
          "回复了你的评论",
        eventDetail:
          "回复了你的评论"
      }),
      "- 06:30｜回复了你的评论"
    );
  }
);
