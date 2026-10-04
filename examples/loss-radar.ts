import assert from "node:assert/strict";
import { createRecord, estimateLossAudit, planLossAudit } from "../src/index.js";

// Synthetic human labels only. This demonstrates weighting, not measured Jev quality.
const records = Array.from({ length: 100 }, (_, index) => ({
  ...createRecord({ sourceId: `fixture-${index}`, decision: "discard", score: 0.99,
    model: "fixture", policyVersion: "fixture-v1", evidence: "synthetic" }),
  id: `fixture-${index}`,
}));
const plan = planLossAudit(records, {
  budget: 20, priorityIds: records.slice(0, 10).map(row => row.id), seed: "synthetic-demo-only",
});
const labels = plan.rows.filter(row => row.selected).map(row => ({ recordId: row.recordId, miss: row.stratum === "priority" }));
const report = estimateLossAudit(plan, labels);
assert.equal(report.reviewed, 20);
assert.equal(report.estimatedPopulationMissRate, 0.1);
assert.equal(report.observedSampleMissRate, 0.5);
console.log(JSON.stringify({ synthetic: true, networkCalls: 0, report }, null, 2));
