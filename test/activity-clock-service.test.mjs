import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateAlignedPassEnd
} from "../services/activity-clock-service.mjs";


test(
  "续接活动时用剩余实际秒数重算旧通行证结束时间",
  () => {
    const now = new Date(
      "2026-07-23T16:00:00.000Z"
    );

    assert.equal(
      calculateAlignedPassEnd({
        remainingSeconds: 5400,
        now
      }).toISOString(),
      "2026-07-23T17:30:00.000Z"
    );
  }
);


test(
  "负数剩余时间不会把旧通行证倒拨到过去",
  () => {
    const now = new Date(
      "2026-07-23T16:00:00.000Z"
    );

    assert.equal(
      calculateAlignedPassEnd({
        remainingSeconds: -100,
        now
      }).toISOString(),
      now.toISOString()
    );
  }
);
