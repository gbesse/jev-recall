import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RecallStore, createRecord, type LossAuditPlan } from "../src/index.js";

const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { encoding: "utf8" });

test("audit CLI round trip stays private and rejects missing labels and invalid flags", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loss-radar-cli-"));
  const path = join(directory, "store.jsonl");
  const store = new RecallStore(path);
  for (let index = 0; index < 4; index += 1) await store.append(createRecord({
    sourceId: `SENSITIVE-SOURCE-${index}`, decision: "discard", model: "fixture", policyVersion: "v1",
    evidence: "PRIVATE-TICKET-TEXT", metadata: { secret: "PRIVATE-METADATA" },
  }, { retention: "full" }));
  const result = cli("audit-plan", path, "--budget", "2", "--seed", "test");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.stdout.includes("PRIVATE") && !result.stdout.includes("SENSITIVE"));
  const plan = JSON.parse(result.stdout) as LossAuditPlan;
  const planPath = join(directory, "plan.json"), labelsPath = join(directory, "labels.json");
  await writeFile(planPath, result.stdout, { mode: 0o600 });
  const labels = plan.rows.filter(row => row.selected).map(row => ({ recordId: row.recordId, miss: false }));
  await writeFile(labelsPath, JSON.stringify(labels), { mode: 0o600 });
  const report = cli("audit-report", planPath, "--labels", labelsPath);
  assert.equal(report.status, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).reviewed, 2);
  await writeFile(labelsPath, "[]");
  assert.equal(cli("audit-report", planPath, "--labels", labelsPath).status, 2);
  assert.equal(cli("audit-plan", path, "--budget", "2", "--budget", "3").status, 2);
  assert.equal(cli("audit-plan", path, "--unknown", "2").status, 2);
});

test("audit CLI never echoes malformed JSON payloads into an error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "loss-radar-private-"));
  const planPath = join(directory, "plan.json"), labelsPath = join(directory, "labels.json");
  await writeFile(planPath, "PRIVATE-MALFORMED-CUSTOMER-TEXT");
  await writeFile(labelsPath, "[]");
  const result = cli("audit-report", planPath, "--labels", labelsPath);
  assert.equal(result.status, 2);
  assert.ok(!result.stderr.includes("PRIVATE-MALFORMED"));
  assert.equal(result.stdout, "");
});
