import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateNaturalWakeChance,
  selectDailyNaturalTarget
} from "../services/heart-policy-service.mjs";


test("daily natural target is stable for the same user and day", () => {
  const input = {
    userId: "owner-404",
    dateKey: "2026-07-23",
    minimum: 3,
    maximum: 6
  };

  const first = selectDailyNaturalTarget(input);
  const second = selectDailyNaturalTarget(input);

  assert.equal(first, second);
  assert.ok(first >= 3);
  assert.ok(first <= 6);
});


test("daily natural target respects a fixed range", () => {
  assert.equal(
    selectDailyNaturalTarget({
      userId: "owner-404",
      dateKey: "2026-07-23",
      minimum: 4,
      maximum: 4
    }),
    4
  );
});


test("daily natural target accepts reversed bounds safely", () => {
  const target = selectDailyNaturalTarget({
    userId: "owner-404",
    dateKey: "2026-07-23",
    minimum: 6,
    maximum: 3
  });

  assert.ok(target >= 3);
  assert.ok(target <= 6);
});


test("natural wake chance is zero when no target remains", () => {
  assert.equal(
    calculateNaturalWakeChance({
      remainingTarget: 0,
      minutesRemaining: 600,
      averageInspectionMinutes: 30
    }),
    0
  );
});


test("natural wake chance spreads remaining wakes across inspections", () => {
  assert.equal(
    calculateNaturalWakeChance({
      remainingTarget: 3,
      minutesRemaining: 300,
      averageInspectionMinutes: 30
    }),
    0.3
  );
});


test("natural wake chance never exceeds one", () => {
  assert.equal(
    calculateNaturalWakeChance({
      remainingTarget: 20,
      minutesRemaining: 10,
      averageInspectionMinutes: 30
    }),
    1
  );
});
