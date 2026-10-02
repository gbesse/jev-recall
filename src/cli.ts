#!/usr/bin/env node
import { RecallStore, deterministicSample, summarize } from "./index.js";

const [command, path, ...args] = process.argv.slice(2);
if (!command || !path || !["stats", "list", "sample", "compact"].includes(command)) {
  console.error("Usage: jev-recall stats|list|sample|compact <store.jsonl> [--count N]");
  process.exit(1);
}
try {
  const store = new RecallStore(path);
  const records = await store.list();
  if (command === "stats") console.log(JSON.stringify(summarize(records), null, 2));
  else if (command === "list") console.log(JSON.stringify(records.map(({ evidence: _evidence, ...record }) => record), null, 2));
  else if (command === "sample") {
    const index = args.indexOf("--count");
    const count = index >= 0 ? Number(args[index + 1]) : undefined;
    console.log(JSON.stringify(deterministicSample(records, count === undefined ? {} : { count }).map(({ evidence: _evidence, ...record }) => record), null, 2));
  } else { await store.compact(); console.log(JSON.stringify({ compacted: true, records: records.length }, null, 2)); }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
