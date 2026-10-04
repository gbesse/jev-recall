import { randomBytes } from "node:crypto";
import { fingerprint, type RecallRecord } from "./index.js";

type Stratum = "priority" | "ordinary";
export interface LossAuditRow {
  recordId: string;
  stratum: Stratum;
  selected: boolean;
  inclusionProbability: number;
}
export interface LossAuditPlan {
  schemaVersion: 1;
  method: "stratified-fixed-budget-v1";
  seed: string;
  populationFingerprint: string;
  populationSize: number;
  reviewCount: number;
  rows: LossAuditRow[];
  planFingerprint: string;
}
export interface LossAuditLabel { recordId: string; miss: boolean; }
export interface LossAuditEstimate {
  populationSize: number;
  reviewed: number;
  observedSampleMissRate: number | null;
  estimatedPopulationMissRate: number | null;
  estimatedMissedRecords: number | null;
  confidenceLevel: number;
  interval: [number, number] | null;
  intervalMethod: "fixed-sample-stratified-hoeffding";
  strata: { name: Stratum; population: number; reviewed: number; misses: number }[];
}

function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TypeError(message);
}
const names: Stratum[] = ["priority", "ordinary"];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function ranked(rows: LossAuditRow[], seed: string): LossAuditRow[] {
  return [...rows].sort((a, b) =>
    compare(fingerprint([seed, a.stratum, a.recordId]), fingerprint([seed, b.stratum, b.recordId])) ||
    compare(a.recordId, b.recordId));
}

/** Freeze the pending population before labels; priority is caller-owned, not model confidence. */
export function planLossAudit(records: RecallRecord[], options: {
  budget: number; priorityIds?: string[]; priorityShare?: number; seed?: string;
}): LossAuditPlan {
  require(Number.isSafeInteger(options.budget) && options.budget >= 0, "budget must be a non-negative integer");
  const share = options.priorityShare ?? 0.7;
  require(Number.isFinite(share) && share > 0 && share < 1, "priorityShare must be strictly between zero and one");
  const seed = options.seed ?? randomBytes(32).toString("hex");
  require(typeof seed === "string" && seed.length > 0, "seed must be non-empty");
  const ids = new Set<string>();
  for (const record of records) {
    require(typeof record.id === "string" && record.id.length > 0 && !ids.has(record.id), "records need unique non-empty ids");
    ids.add(record.id);
  }
  const population = records.filter(record => record.status === "pending").sort((a, b) => compare(a.id, b.id));
  const pendingIds = new Set(population.map(record => record.id));
  const priority = new Set(options.priorityIds ?? []);
  require(priority.size === (options.priorityIds ?? []).length, "priorityIds must be unique");
  for (const id of priority) require(pendingIds.has(id), "priorityIds must belong to the pending population");
  const sizes = { priority: priority.size, ordinary: population.length - priority.size };
  const count = Math.min(options.budget, population.length);
  const nonempty = names.filter(name => sizes[name] > 0);
  require(count >= nonempty.length, "budget must sample every non-empty stratum");
  let priorityCount = sizes.ordinary === 0 ? count : sizes.priority === 0 ? 0 :
    Math.max(1, Math.min(sizes.priority, count - 1, Math.round(count * share)));
  if (count - priorityCount > sizes.ordinary) priorityCount = count - sizes.ordinary;
  const counts = { priority: priorityCount, ordinary: count - priorityCount };
  const rows: LossAuditRow[] = population.map(record => {
    const stratum = priority.has(record.id) ? "priority" : "ordinary";
    return { recordId: record.id, stratum, selected: false, inclusionProbability: counts[stratum] / sizes[stratum] };
  });
  for (const name of names) {
    for (const row of ranked(rows.filter(row => row.stratum === name), seed).slice(0, counts[name])) row.selected = true;
  }
  const body = {
    schemaVersion: 1 as const, method: "stratified-fixed-budget-v1" as const, seed,
    populationFingerprint: fingerprint(population.map(record => ({
      id: record.id, evidenceFingerprint: record.evidenceFingerprint, model: record.model,
      policyVersion: record.policyVersion, decision: record.decision, status: record.status,
      recordFingerprint: fingerprint(record),
    }))),
    populationSize: population.length, reviewCount: count, rows,
  };
  return { ...body, planFingerprint: fingerprint(body) };
}

function validatePlan(plan: LossAuditPlan): void {
  require(plan?.schemaVersion === 1 && plan.method === "stratified-fixed-budget-v1", "unsupported audit plan");
  require(Array.isArray(plan.rows) && plan.populationSize === plan.rows.length, "invalid population size");
  require(typeof plan.seed === "string" && plan.seed.length > 0, "invalid seed");
  require(typeof plan.populationFingerprint === "string" && /^[a-f0-9]{64}$/.test(plan.populationFingerprint), "invalid population fingerprint");
  const { planFingerprint, ...body } = plan;
  require(planFingerprint === fingerprint(body), "audit plan fingerprint mismatch");
  const ids = new Set<string>();
  for (const row of plan.rows) {
    require(typeof row.recordId === "string" && row.recordId.length > 0 && !ids.has(row.recordId), "invalid or duplicate audit id");
    ids.add(row.recordId);
    require(names.includes(row.stratum) && typeof row.selected === "boolean", "invalid audit row");
  }
  require(plan.reviewCount === plan.rows.filter(row => row.selected).length, "invalid review count");
  for (const name of names) {
    const rows = plan.rows.filter(row => row.stratum === name);
    if (rows.length === 0) continue;
    const count = rows.filter(row => row.selected).length;
    require(count > 0, "every non-empty stratum must be sampled");
    const selected = new Set(ranked(rows, plan.seed).slice(0, count).map(row => row.recordId));
    for (const row of rows) {
      require(row.inclusionProbability === count / rows.length, "invalid inclusion probability");
      require(row.selected === selected.has(row.recordId), "selection does not match the frozen seed");
    }
  }
}

/** Human labels must cover the complete frozen sample; a replay flip is not ground truth. */
export function estimateLossAudit(plan: LossAuditPlan, labels: LossAuditLabel[], options: {
  confidenceLevel?: number;
} = {}): LossAuditEstimate {
  validatePlan(plan);
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  require(Number.isFinite(confidenceLevel) && confidenceLevel > 0 && confidenceLevel < 1, "invalid confidence level");
  require(Array.isArray(labels), "labels must be an array");
  const selectedIds = new Set(plan.rows.filter(row => row.selected).map(row => row.recordId));
  const byId = new Map<string, boolean>();
  for (const label of labels) {
    require(label && selectedIds.has(label.recordId), "label does not belong to the selected sample");
    require(!byId.has(label.recordId) && typeof label.miss === "boolean", "labels need unique ids and explicit boolean miss values");
    byId.set(label.recordId, label.miss);
  }
  require(byId.size === selectedIds.size, "complete human labels are required; missing labels cannot count as correct");
  const strata = names.map(name => {
    const rows = plan.rows.filter(row => row.stratum === name);
    const selected = rows.filter(row => row.selected);
    return { name, population: rows.length, reviewed: selected.length,
      misses: selected.filter(row => byId.get(row.recordId)).length };
  }).filter(stratum => stratum.population > 0);
  let rate = 0;
  let squaredRanges = 0;
  let misses = 0;
  for (const stratum of strata) {
    const weight = stratum.population / plan.populationSize;
    rate += weight * stratum.misses / stratum.reviewed;
    misses += stratum.misses;
    // A census is exact; other strata use a conservative without-replacement Hoeffding bound.
    if (stratum.reviewed < stratum.population) squaredRanges += weight ** 2 / stratum.reviewed;
  }
  const radius = Math.sqrt(Math.log(2 / (1 - confidenceLevel)) * squaredRanges / 2);
  return {
    populationSize: plan.populationSize, reviewed: plan.reviewCount,
    observedSampleMissRate: plan.reviewCount ? misses / plan.reviewCount : null,
    estimatedPopulationMissRate: plan.populationSize ? rate : null,
    estimatedMissedRecords: plan.populationSize ? rate * plan.populationSize : null,
    confidenceLevel, interval: plan.populationSize ? [Math.max(0, rate - radius), Math.min(1, rate + radius)] : null,
    intervalMethod: "fixed-sample-stratified-hoeffding", strata,
  };
}
