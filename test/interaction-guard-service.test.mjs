import test from "node:test";
import assert from "node:assert/strict";

import {
  startInteractionPreservingActivity
} from "../services/interaction-guard-service.mjs";


function createFakeService({
  previousState,
  resumePolicy = "manual"
}) {
  const calls = [];

  return {
    calls,
    service: {
      async getRuntimeSnapshot() {
        calls.push(["snapshot"]);

        return {
          freeActivityProgress:
            previousState
              ? {
                  state: previousState,
                  resume_policy:
                    resumePolicy,
                  pause_reason:
                    "owner_selected_hold"
                }
              : null
        };
      },

      async startInteraction(options) {
        calls.push([
          "start",
          options.channel
        ]);

        return {
          session: {
            id: "session-1"
          },
          pausedActivity: {
            progress: {
              state:
                "paused_by_chat"
            }
          }
        };
      },

      async pauseFreeActivity(options) {
        calls.push([
          "restore",
          options.state,
          options.resumePolicy
        ]);

        return {
          progress: {
            state: options.state,
            resume_policy:
              options.resumePolicy
          }
        };
      }
    }
  };
}


test(
  "打开聊天时保留大管家选择的手动暂停",
  async () => {
    const fake = createFakeService({
      previousState: "paused_manual",
      resumePolicy: "manual"
    });

    const result =
      await startInteractionPreservingActivity({
        orchestrationService:
          fake.service,
        userId: "user-1",
        channel: "official_chat",
        source: "test"
      });

    assert.equal(
      result.preservedActivityState,
      "paused_manual"
    );
    assert.deepEqual(
      fake.calls,
      [
        ["snapshot"],
        ["start", "official_chat"],
        [
          "restore",
          "paused_manual",
          "manual"
        ]
      ]
    );
  }
);


test(
  "正在运行的自由活动进入聊天时正常暂停为聊天状态",
  async () => {
    const fake = createFakeService({
      previousState: "running",
      resumePolicy: "after_chat"
    });

    const result =
      await startInteractionPreservingActivity({
        orchestrationService:
          fake.service,
        userId: "user-1",
        channel: "bedroom_chat",
        source: "test"
      });

    assert.equal(
      result.preservedActivityState,
      null
    );
    assert.deepEqual(
      fake.calls,
      [
        ["snapshot"],
        ["start", "bedroom_chat"]
      ]
    );
  }
);


test(
  "预算暂停不会因为打开官端而被改成聊完自动继续",
  async () => {
    const fake = createFakeService({
      previousState:
        "paused_by_budget",
      resumePolicy: "manual"
    });

    const result =
      await startInteractionPreservingActivity({
        orchestrationService:
          fake.service,
        userId: "user-1",
        channel: "official_chat",
        source: "test"
      });

    assert.equal(
      result.pausedActivity.progress.state,
      "paused_by_budget"
    );
    assert.deepEqual(
      fake.calls.at(-1),
      [
        "restore",
        "paused_by_budget",
        "manual"
      ]
    );
  }
);
