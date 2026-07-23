import test from "node:test";
import assert from "node:assert/strict";

import {
  estimateSolCost
} from "../services/bedroom-summary-service.mjs";


test(
  "卧室小纸条费用估算同时计算输入与输出",
  () => {
    assert.equal(
      estimateSolCost({
        inputTokens: 8000,
        outputTokens: 4000
      }),
      0.16
    );
  }
);


test(
  "无效和负数 token 不会产生负费用",
  () => {
    assert.equal(
      estimateSolCost({
        inputTokens: -100,
        outputTokens: "nope"
      }),
      0
    );
  }
);
