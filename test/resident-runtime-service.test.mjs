import test from "node:test";
import assert from "node:assert/strict";

import {
  forceSilentDecisionResponse,
  sanitizeActivityNoteBody,
  shouldPromoteResidentOpportunity
} from "../services/resident-runtime-service.mjs";


test(
  "每日活动小纸条只保留时间与动作摘要",
  () => {
    const body = [
      "- 09:42｜给你留了一条留言 — 这是一整段不该出现在流水账里的正文。",
      "- 13:16｜在书房回复了你的评论 — 回复正文也不能被复制。",
      "普通说明行保持原样"
    ].join("\n");

    assert.equal(
      sanitizeActivityNoteBody(body),
      [
        "- 09:42｜给你留了一条留言",
        "- 13:16｜在书房回复了你的评论",
        "普通说明行保持原样"
      ].join("\n")
    );
  }
);


test(
  "常住模式只升级普通环境机会",
  () => {
    for (const skipReason of [
      "inspection_only",
      "natural_wake_target_reached",
      "natural_wake_disabled"
    ]) {
      assert.equal(
        shouldPromoteResidentOpportunity({
          shouldCallModel: false,
          skipReason
        }),
        true
      );
    }

    for (const skipReason of [
      "daily_model_call_limit_reached",
      "daily_model_cost_limit_reached",
      "minimum_model_wake_interval",
      "interactive_awake",
      "quiet_hours"
    ]) {
      assert.equal(
        shouldPromoteResidentOpportunity({
          shouldCallModel: false,
          skipReason
        }),
        false
      );
    }

    assert.equal(
      shouldPromoteResidentOpportunity({
        shouldCallModel: true,
        skipReason: null
      }),
      false
    );
  }
);


test(
  "模型返回后发现前台互动时强制改为合法静默决定",
  () => {
    const original = {
      id: "resp_test",
      usage: {
        input_tokens: 120,
        output_tokens: 30
      },
      output_text:
        JSON.stringify({
          action: "leave_message"
        })
    };
    const response =
      forceSilentDecisionResponse(
        original,
        "官端互动已经开始"
      );
    const decision = JSON.parse(
      response.output_text
    );

    assert.equal(response.id, original.id);
    assert.deepEqual(
      response.usage,
      original.usage
    );
    assert.equal(decision.action, "silent");
    assert.equal(
      decision.reason,
      "官端互动已经开始"
    );
    assert.equal(
      decision.targetCommentId,
      ""
    );
    assert.deepEqual(decision.tags, []);
  }
);
