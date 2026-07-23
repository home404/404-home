import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateExpandedBudget
} from "../services/living-room-service.mjs";


test(
  "追加活动时间时保留原预算并增加分钟数",
  () => {
    assert.equal(
      calculateExpandedBudget({
        currentBudget: 7200,
        addMinutesValue: 30,
        usedSeconds: 1800
      }),
      9000
    );
  }
);


test(
  "新的活动预算不能小于已经实际使用的时间",
  () => {
    assert.equal(
      calculateExpandedBudget({
        currentBudget: 1200,
        addMinutesValue: 0,
        usedSeconds: 1500
      }),
      1500
    );
  }
);


test(
  "负数追加时间不会倒扣活动预算",
  () => {
    assert.equal(
      calculateExpandedBudget({
        currentBudget: 3600,
        addMinutesValue: -90,
        usedSeconds: 600
      }),
      3600
    );
  }
);
