import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateActiveSecondsUsed,
  calculateFreeActivityRemaining,
  resolveHomeMode
} from "../services/home-orchestration-service.mjs";


test("interactive chat has the highest priority", () => {
  const resolved = resolveHomeMode({
    activeInteraction: {
      channel: "official_chat"
    },
    freeActivity: {
      state: "running"
    },
    quietHoursActive: true,
    automaticHeartbeatReleaseEnabled: true,
    autoHeartbeatEnabled: true
  });

  assert.equal(
    resolved.mode,
    "interactive_awake"
  );
  assert.equal(
    resolved.mayCallAutomaticModel,
    false
  );
});


test("running free activity blocks automatic heartbeat", () => {
  const resolved = resolveHomeMode({
    activeInteraction: null,
    freeActivity: {
      state: "running"
    },
    quietHoursActive: false,
    automaticHeartbeatReleaseEnabled: true,
    autoHeartbeatEnabled: true
  });

  assert.equal(
    resolved.mode,
    "free_activity_running"
  );
  assert.equal(
    resolved.mayCallAutomaticModel,
    false
  );
});


test("paused unfinished activity remains visible and blocks fallback wake", () => {
  const resolved = resolveHomeMode({
    freeActivity: {
      state: "paused_by_chat"
    },
    quietHoursActive: false,
    automaticHeartbeatReleaseEnabled: true,
    autoHeartbeatEnabled: true
  });

  assert.equal(
    resolved.mode,
    "free_activity_paused"
  );
  assert.equal(
    resolved.reason,
    "paused_by_chat"
  );
});


test("quiet hours block automatic wake", () => {
  const resolved = resolveHomeMode({
    quietHoursActive: true,
    automaticHeartbeatReleaseEnabled: true,
    autoHeartbeatEnabled: true
  });

  assert.equal(
    resolved.mode,
    "resting"
  );
  assert.equal(
    resolved.reason,
    "quiet_hours"
  );
});


test("automatic heartbeat remains locked until release switch is enabled", () => {
  const locked = resolveHomeMode({
    quietHoursActive: false,
    automaticHeartbeatReleaseEnabled: false,
    autoHeartbeatEnabled: true
  });

  assert.equal(
    locked.mode,
    "resting"
  );
  assert.equal(
    locked.reason,
    "automatic_heartbeat_locked"
  );

  const released = resolveHomeMode({
    quietHoursActive: false,
    automaticHeartbeatReleaseEnabled: true,
    autoHeartbeatEnabled: true
  });

  assert.equal(
    released.mode,
    "auto_wake_eligible"
  );
  assert.equal(
    released.mayCallAutomaticModel,
    true
  );
});


test("paused free activity does not consume wall clock time", () => {
  const used = calculateActiveSecondsUsed({
    activeSecondsUsed: 600,
    lastResumedAt:
      "2026-07-23T10:00:00.000Z",
    state: "paused_by_chat",
    now:
      "2026-07-23T12:00:00.000Z",
    activeSecondsBudget: 7200
  });

  assert.equal(used, 600);
});


test("running free activity only counts active elapsed seconds", () => {
  const remaining =
    calculateFreeActivityRemaining({
      activeSecondsBudget: 7200,
      activeSecondsUsed: 600,
      lastResumedAt:
        "2026-07-23T10:00:00.000Z",
      state: "running",
      now:
        "2026-07-23T10:10:00.000Z"
    });

  assert.equal(
    remaining.activeSecondsUsed,
    1200
  );
  assert.equal(
    remaining.remainingSeconds,
    6000
  );
  assert.equal(
    remaining.exhausted,
    false
  );
});


test("active time is capped at the pass budget", () => {
  const remaining =
    calculateFreeActivityRemaining({
      activeSecondsBudget: 3600,
      activeSecondsUsed: 3500,
      lastResumedAt:
        "2026-07-23T10:00:00.000Z",
      state: "running",
      now:
        "2026-07-23T10:10:00.000Z"
    });

  assert.equal(
    remaining.activeSecondsUsed,
    3600
  );
  assert.equal(
    remaining.remainingSeconds,
    0
  );
  assert.equal(
    remaining.exhausted,
    true
  );
});
