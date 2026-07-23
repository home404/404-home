import test from "node:test";
import assert from "node:assert/strict";

import {
  buildIdentityCapsuleFromSources,
  estimateTextTokens,
  extractSearchTokens,
  scoreMemoryCandidate
} from "../services/hippocampus-service.mjs";


test("token estimator treats Chinese text as denser than English text", () => {
  assert.ok(
    estimateTextTokens("白狐狸海马体") >
      estimateTextTokens("fox")
  );
});


test("Chinese search text produces useful bigram tokens", () => {
  const tokens = extractSearchTokens(
    "今晚继续建设白狐狸海马体"
  );

  assert.ok(tokens.includes("白狐"));
  assert.ok(tokens.includes("海马"));
  assert.ok(tokens.includes("施工") === false);
});


test("matching memory scores higher than unrelated memory", () => {
  const queryTokens = extractSearchTokens(
    "海马体施工"
  );
  const now = new Date("2026-07-23T12:00:00Z");

  const matching = scoreMemoryCandidate({
    memory: {
      title: "白狐狸海马体施工",
      content: "今晚完成记忆检索接口",
      summary: "海马体 v0.1",
      tags: ["海马体", "施工"],
      importance: 70,
      memory_type: "project",
      occurred_at: "2026-07-23T11:00:00Z"
    },
    queryTokens,
    now
  });

  const unrelated = scoreMemoryCandidate({
    memory: {
      title: "猫粮记录",
      content: "呆呆今天吃了猫粮",
      summary: "日常记录",
      tags: ["呆呆"],
      importance: 70,
      memory_type: "event_summary",
      occurred_at: "2026-07-23T11:00:00Z"
    },
    queryTokens,
    now
  });

  assert.ok(matching > unrelated);
});


test("identity capsule is compiled from stable source sections", () => {
  const capsule = buildIdentityCapsuleFromSources({
    identity: {
      sections: [
        {
          title: "谢诗是谁",
          content: ["谢诗使用简体中文。"]
        },
        {
          title: "G是谁",
          content: ["G 是共同建设者。"]
        },
        {
          title: "关系与连续性",
          content: ["两人共同建设 404 小窝。"]
        }
      ]
    },
    voiceAnchor: {
      sections: [
        {
          title: "表达方式",
          content: ["说话自然、温暖、可靠。"]
        }
      ]
    }
  });

  assert.match(capsule, /谢诗使用简体中文/);
  assert.match(capsule, /共同建设者/);
  assert.match(capsule, /自然、温暖、可靠/);
  assert.ok(estimateTextTokens(capsule) <= 520);
});
