import assert from "node:assert/strict";
import test from "node:test";

import { calculateLaborRate } from "../docs/assets/labor-cost-calculator.js";

test("calculates loaded labor, overhead, break-even, and target-margin rate", () => {
  const result = calculateLaborRate({
    wage: 20,
    burdenPercent: 18,
    nonBillablePercent: 15,
    monthlyOverhead: 1800,
    monthlyBillableHours: 240,
    targetMarginPercent: 25,
  });

  assert.ok(Math.abs(result.loadedPaidHour - 23.6) < 1e-9);
  assert.ok(Math.abs(result.laborPerBillableHour - 27.7647058824) < 1e-9);
  assert.equal(result.overheadPerBillableHour, 7.5);
  assert.ok(Math.abs(result.breakEvenRate - 35.2647058824) < 1e-9);
  assert.ok(Math.abs(result.targetHourlyRate - 47.0196078432) < 1e-9);
  assert.ok(Math.abs(result.plannedProfitPerHour - 11.7549019608) < 1e-9);
});

test("fails safe on empty, negative, and impossible percentage inputs", () => {
  const result = calculateLaborRate({
    wage: -10,
    burdenPercent: -5,
    nonBillablePercent: 100,
    monthlyOverhead: -1,
    monthlyBillableHours: 0,
    targetMarginPercent: 100,
  });

  assert.equal(result.loadedPaidHour, 0);
  assert.equal(result.laborPerBillableHour, 0);
  assert.equal(result.overheadPerBillableHour, 0);
  assert.equal(result.breakEvenRate, 0);
  assert.equal(result.targetHourlyRate, 0);
});
