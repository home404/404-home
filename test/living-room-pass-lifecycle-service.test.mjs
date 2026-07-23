import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveCurrentBudgetStop,
  resolveSafeModelCallBudget
} from "../services/living-room-pass-lifecycle-service.mjs";


test(
  "模型调用上限不能低于已经使用的次数",
  () => {
    assert.equal(
      resolveSafeModelCallBudget({
        requestedBudget: 3,
        usedCalls: 5
      }),
      5
    );
  }
);


test(
  "留空可以取消模型调用次数上限",
  () => {
    assert.equal(
      resolveSafeModelCallBudget({
        requestedBudget: null,
        usedCalls: 5
      }),
      null
    );
  }
);


test(
  "未提交调用次数调整时保持 undefined",
  () => {
    assert.equal(
      resolveSafeModelCallBudget({
        requestedBudget: undefined,
        usedCalls: 5
      }),
      undefined
    );
  }
);


test(
  "当前输入 token 已碰到新上限时立即要求暂停",
  () => {
    assert.equal(
      resolveCurrentBudgetStop({
        progress: {
          input_token_budget: 8000,
          input_tokens_used: 8000,
          output_token_budget: 24000,
          output_tokens_used: 1000,
          max_cost_usd: 3,
          estimated_cost_usd: 0.2
        },
        pass: {
          max_model_calls: 6
        },
        modelCallsUsed: 1
      }),
      "input_token_budget_exhausted"
    );
  }
);


test(
  "当前模型调用次数已碰到上限时立即要求暂停",
  () => {
    assert.equal(
      resolveCurrentBudgetStop({
        progress: {
          input_token_budget: 8000,
          input_tokens_used: 1000,
          output_token_budget: 24000,
          output_tokens_used: 1000,
          max_cost_usd: 3,
          estimated_cost_usd: 0.2
        },
        pass: {
          max_model_calls: 4
        },
        modelCallsUsed: 4
      }),
      "model_call_budget_exhausted"
    );
  }
);


test(
  "所有当前用量都低于保险丝时不暂停",
  () => {
    assert.equal(
      resolveCurrentBudgetStop({
        progress: {
          input_token_budget: 8000,
          input_tokens_used: 1000,
          output_token_budget: 24000,
          output_tokens_used: 2000,
          max_cost_usd: 3,
          estimated_cost_usd: 0.2
        },
        pass: {
          max_model_calls: 6
        },
        modelCallsUsed: 1
      }),
      null
    );
  }
);
