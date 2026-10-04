import test from "node:test";
import assert from "node:assert/strict";
import { createRecord, estimateLossAudit, planLossAudit, fingerprint } from "../src/index.js";

function population(size = 100) {
  return Array.from({ length: size }, (_, index) => ({
    ...createRecord({ sourceId: `ticket-${index}`, decision: "discard", score: 0.99,
      model: "fixture", policyVersion: "v1", evidence: { secret: "DO-NOT-EXPORT" } }),
    id: `id-${index.toString().padStart(3, "0")}`,
  }));
}

test("fixed budget, reproducible order-independent sample, and positive inclusion everywhere", () => {
  const records = population();
  const options = { budget: 20, priorityIds: records.slice(0, 10).map(row => row.id), seed: "precommitted" };
  const plan = planLossAudit(records, options);
  assert.deepEqual(plan, planLossAudit([...records].reverse(), options));
  assert.equal(plan.reviewCount, 20);
  assert.equal(plan.rows.filter(row => row.selected).length, 20);
  assert.equal(plan.rows.filter(row => row.stratum === "priority" && row.selected).length, 10);
  assert.ok(plan.rows.every(row => row.inclusionProbability > 0));
  assert.ok(!JSON.stringify(plan).includes("DO-NOT-EXPORT"));
  assert.ok(!JSON.stringify(plan).includes("ticket-"));
});

test("oversampled high-risk decisions do not bias the population estimate", () => {
  const records = population();
  const plan = planLossAudit(records, { budget: 20, priorityIds: records.slice(0, 10).map(row => row.id), seed: "pilot" });
  const labels = plan.rows.filter(row => row.selected).map(row => ({ recordId: row.recordId, miss: row.stratum === "priority" }));
  const report = estimateLossAudit(plan, labels);
  assert.equal(report.observedSampleMissRate, 0.5);
  assert.equal(report.estimatedPopulationMissRate, 0.1);
  assert.equal(report.estimatedMissedRecords, 10);
  assert.ok(report.interval![1] > 0.1);
});

test("zero sampled misses is not zero certified population error", () => {
  const plan = planLossAudit(population(), { budget: 10, seed: "zero" });
  const report = estimateLossAudit(plan, plan.rows.filter(row => row.selected).map(row => ({ recordId: row.recordId, miss: false })));
  assert.equal(report.estimatedPopulationMissRate, 0);
  assert.ok(report.interval![1] > 0);
});

test("a census is exact and empty populations have no fabricated metric", () => {
  const plan = planLossAudit(population(4), { budget: 20, seed: "all" });
  const report = estimateLossAudit(plan, plan.rows.map((row, index) => ({ recordId: row.recordId, miss: index === 0 })));
  assert.deepEqual(report.interval, [0.25, 0.25]);
  assert.equal(estimateLossAudit(planLossAudit([], { budget: 0 }), []).estimatedPopulationMissRate, null);
});

test("duplicate records, undersampled strata, bad budgets and unknown priorities fail closed", () => {
  const records = population(3);
  assert.throws(() => planLossAudit([records[0]!, records[0]!], { budget: 2 }), /unique/);
  assert.throws(() => planLossAudit(records, { budget: 1, priorityIds: [records[0]!.id] }), /every non-empty/);
  for (const budget of [0, -1, NaN, Infinity, 0.5]) assert.throws(() => planLossAudit(records, { budget }));
  assert.throws(() => planLossAudit(records, { budget: 2, priorityIds: ["unknown"] }), /pending/);
  assert.throws(() => planLossAudit(records, { budget: 2, priorityShare: 1 }), /priorityShare/);
  assert.throws(() => planLossAudit(records, { budget: 2, seed: "" }), /seed/);
});

test("non-pending decisions are outside the frozen population", () => {
  const records = population(2);
  records[0]!.status = "recovered";
  assert.equal(planLossAudit(records, { budget: 2 }).populationSize, 1);
});

test("missing, duplicate, unsolicited or non-human-shaped labels cannot create a report", () => {
  const plan = planLossAudit(population(3), { budget: 2 });
  const labels = plan.rows.filter(row => row.selected).map(row => ({ recordId: row.recordId, miss: false }));
  assert.throws(() => estimateLossAudit(plan, labels.slice(0, 1)), /complete human/);
  assert.throws(() => estimateLossAudit(plan, [...labels, labels[0]!]), /unique/);
  assert.throws(() => estimateLossAudit(plan, [{ recordId: "unknown", miss: false }]), /selected/);
  assert.throws(() => estimateLossAudit(plan, [{ recordId: labels[0]!.recordId, miss: "false" } as never]), /boolean/);
  assert.throws(() => estimateLossAudit(plan, labels, { confidenceLevel: NaN }), /confidence/);
});

test("plan tampering is rejected, including rehashed invalid inclusion probabilities", () => {
  const plan = planLossAudit(population(3), { budget: 2, seed: "frozen" });
  plan.rows[0]!.inclusionProbability = 0.9;
  assert.throws(() => estimateLossAudit(plan, []), /fingerprint/);
  const { planFingerprint: _ignored, ...body } = plan;
  plan.planFingerprint = fingerprint(body);
  assert.throws(() => estimateLossAudit(plan, []), /inclusion/);
});

test("weighted estimation recovers a known finite-population rate across prespecified seeds", () => {
  const records = population(20);
  const priorityIds = records.slice(0, 5).map(row => row.id);
  const misses = new Set([records[0]!.id, records[1]!.id, records[19]!.id]);
  let sum = 0;
  for (let index = 0; index < 500; index += 1) {
    const plan = planLossAudit(records, { budget: 8, priorityIds, priorityShare: 0.5, seed: `simulation-${index}` });
    const labels = plan.rows.filter(row => row.selected).map(row => ({ recordId: row.recordId, miss: misses.has(row.recordId) }));
    sum += estimateLossAudit(plan, labels).estimatedPopulationMissRate!;
  }
  assert.ok(Math.abs(sum / 500 - 3 / 20) < 0.02);
});
