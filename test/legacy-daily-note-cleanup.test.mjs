import test from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeDailyActivityBody
} from "../scripts/cleanup-legacy-daily-notes.mjs";


test("daily activity cleanup removes copied detail text", () => {
  const input = [
    "- 06:30 | 给你留了一条留言",
    "- 19:42 | 留了一条晚间问候 — 在安静了一天后的傍晚，给谢诗留一句问候。",
    "- 20:26 | 回复了你的评论 — 这一整段回复不该留在流水账里。"
  ].join("\n");

  assert.equal(
    sanitizeDailyActivityBody(input),
    [
      "- 06:30 | 给你留了一条留言",
      "- 19:42 | 留了一条晚间问候",
      "- 20:26 | 回复了你的评论"
    ].join("\n")
  );
});


test("daily activity cleanup leaves ordinary prose untouched", () => {
  const input =
    "19:52，给小窝贴一张低噪音纸条：今晚不用急着证明什么。";

  assert.equal(
    sanitizeDailyActivityBody(input),
    input
  );
});
