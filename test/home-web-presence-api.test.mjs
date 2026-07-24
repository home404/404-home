import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveHomeWebLease
} from "../routes/home-web-presence-api.mjs";


test(
  "网页租约会把过短输入夹到安全下限",
  () => {
    const result = resolveHomeWebLease({
      now: new Date(
        "2026-07-24T12:00:00.000Z"
      ),
      leaseSeconds: 10
    });

    assert.equal(
      result.leaseSeconds,
      60
    );
    assert.equal(
      result.activeUntil,
      "2026-07-24T12:01:00.000Z"
    );
    assert.equal(
      result.heartbeatPausedUntil,
      result.activeUntil
    );
  }
);


test(
  "网页租约不会缩短已有的官端缓冲",
  () => {
    const result = resolveHomeWebLease({
      now: new Date(
        "2026-07-24T12:00:00.000Z"
      ),
      leaseSeconds: 120,
      existingPausedUntil:
        "2026-07-24T12:15:00.000Z"
    });

    assert.equal(
      result.activeUntil,
      "2026-07-24T12:02:00.000Z"
    );
    assert.equal(
      result.heartbeatPausedUntil,
      "2026-07-24T12:15:00.000Z"
    );
  }
);


test(
  "无效时间会被拒绝",
  () => {
    assert.throws(
      () => resolveHomeWebLease({
        now: "not-a-date"
      }),
      /无效时间/
    );
  }
);
