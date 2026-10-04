#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { RecallStore, deterministicSample, summarize, planLossAudit, estimateLossAudit, type LossAuditPlan, type LossAuditLabel } from "./index.js";

const [command, path, ...args] = process.argv.slice(2);
if (!command || !path || !["stats", "list", "sample", "compact", "audit-plan", "audit-report"].includes(command)) {
  console.error("Usage: jev-recall stats|list|sample|compact <store.jsonl> [--count N]\n       jev-recall audit-plan <store.jsonl> --budget N [--priority ids.json] [--seed SEED]\n       jev-recall audit-report <plan.json> --labels labels.json");
  process.exit(1);
}
try {
  if (command === "audit-plan" || command === "audit-report") {
    const allowed = command === "audit-plan" ? ["--budget", "--priority", "--seed"] : ["--labels"];
    const flags = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index], value = args[index + 1];
      if (!key || !allowed.includes(key) || value === undefined || value.startsWith("--") || flags.has(key)) throw new Error("Invalid audit arguments");
      flags.set(key, value);
    }
    if (command === "audit-plan") {
      if (!flags.has("--budget")) throw new Error("--budget is required");
      const priorityPath = flags.get("--priority");
      const priorityIds: string[] = priorityPath ? JSON.parse(await readFile(priorityPath, "utf8")) : [];
      if (!Array.isArray(priorityIds) || !priorityIds.every(id => typeof id === "string")) throw new Error("priority file must be an array of record ids");
      const seed = flags.get("--seed");
      const plan = planLossAudit(await new RecallStore(path).list(), {
        budget: Number(flags.get("--budget")), priorityIds, ...(seed === undefined ? {} : { seed }),
      });
      console.log(JSON.stringify(plan, null, 2));
    } else {
      const labelsPath = flags.get("--labels");
      if (!labelsPath) throw new Error("--labels is required");
      const plan = JSON.parse(await readFile(path, "utf8")) as LossAuditPlan;
      const labels = JSON.parse(await readFile(labelsPath, "utf8")) as LossAuditLabel[];
      console.log(JSON.stringify(estimateLossAudit(plan, labels), null, 2));
    }
  } else {
  const store = new RecallStore(path);
  const records = await store.list();
  if (command === "stats") console.log(JSON.stringify(summarize(records), null, 2));
  else if (command === "list") console.log(JSON.stringify(records.map(({ evidence: _evidence, ...record }) => record), null, 2));
  else if (command === "sample") {
    const index = args.indexOf("--count");
    const count = index >= 0 ? Number(args[index + 1]) : undefined;
    console.log(JSON.stringify(deterministicSample(records, count === undefined ? {} : { count }).map(({ evidence: _evidence, ...record }) => record), null, 2));
  } else { await store.compact(); console.log(JSON.stringify({ compacted: true, records: records.length }, null, 2)); }
  }
} catch (error) {
  console.error(command === "audit-plan" || command === "audit-report"
    ? "Audit failed: check the frozen plan, budget, priority ids and complete boolean labels."
    : error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
