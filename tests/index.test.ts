import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecallStore, createRecord, deterministicSample, replay, summarize } from "../src/index.js";

const input = { sourceId: "message-1", decision: "discard", score: .82, model: "jev-test", policyVersion: "1", evidence: { text: "A material contract change" } };

test("defaults to fingerprint-only retention", () => {
  const record = createRecord(input);
  assert.equal(record.retention, "fingerprint");
  assert.equal(Object.hasOwn(record, "evidence"), false);
  assert.equal(record.evidenceFingerprint.length, 64);
});

test("persists private JSONL and materializes review events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "recall-"));
  const store = new RecallStore(join(directory, "quarantine.jsonl"));
  const record = await store.quarantine(input, { retention: "full" });
  assert.equal(await store.permissions(), 0o600);
  await store.review(record.id, "recovered", { actor: "reviewer" });
  const records = await store.list();
  assert.equal(records[0]?.status, "recovered");
  assert.equal(summarize(records).observedFalseNegativeRate, 1);
  await store.compact();
  const afterCompaction = await store.read();
  assert.equal(afterCompaction.events.some(event => event.type === "reviewed"), true);
  assert.equal((await store.list())[0]?.status, "recovered");
});

test("samples pending records deterministically", () => {
  const records = ["a", "b", "c"].map(sourceId => createRecord({ ...input, sourceId }));
  const first = deterministicSample(records, { count: 2, seed: "audit" }).map(x => x.sourceId);
  const second = deterministicSample(records, { count: 2, seed: "audit" }).map(x => x.sourceId);
  assert.deepEqual(first, second);
});

test("replays only full evidence and detects recovered decisions", async () => {
  const full = createRecord(input, { retention: "full" });
  const results = await replay([full], async evidence => ({ decision: (evidence as { text: string }).text.includes("material") ? "keep" : "discard", score: .91, model: "jev-new", policyVersion: "2" }));
  assert.equal(results[0]?.status, "recovered");
  await assert.rejects(() => replay([createRecord(input)], async () => ({ decision: "keep", model: "x", policyVersion: "2" })), /full retained evidence/);
});
