# Jev Recall

Quarantine, audit and replay rejected AI decisions before evidence is lost. Recall addresses the asymmetric failure where a false negative disappears from memory, retrieval or an operational queue and can no longer be corrected later.

## Safe default

```ts
import { RecallStore } from "@gbesse/jev-recall";

const store = new RecallStore(".local/recall.jsonl");
await store.quarantine({
  sourceId: message.id,
  decision: "discard",
  score: 0.78,
  model: "jev-1.13.0",
  policyVersion: "memory-v3",
  evidence: message,
});
```

The default retention mode stores only a SHA-256 evidence fingerprint. Choose `preview` for a bounded textual preview or `full` only when replay is required and local retention is authorized. Store and event files are created with mode `600`.

## Audit and replay

- `deterministicSample` creates repeatable review samples from pending rejects.
- `summarize` reports the observed false-negative rate among reviewed records.
- `replay` re-evaluates full retained evidence against a new model or policy.
- `RecallStore.review` appends an audit event instead of overwriting the original record.
- `RecallStore.compact` materializes current state while keeping the append-only event history.

```sh
jev-recall stats .local/recall.jsonl
jev-recall sample .local/recall.jsonl --count 20
```

The CLI never prints retained full evidence.

## Limits

The observed false-negative rate is meaningful only for a representative audit sample. Fingerprints prove identity but cannot reconstruct discarded evidence. Full retention may create privacy and compliance obligations; encryption, deletion policy and access control remain the operator's responsibility. One `RecallStore` instance serializes writes, but multiple processes require an external transactional writer.

```sh
npm install
npm run release:check
```

MIT licensed and provider-independent.
