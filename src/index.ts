import { createHash, randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type RetentionMode = "fingerprint" | "preview" | "full";
export type RecallStatus = "pending" | "confirmed-reject" | "recovered" | "expired";

export interface RejectionInput {
  sourceId: string;
  decision: string;
  score?: number;
  threshold?: number;
  reason?: string;
  model: string;
  policyVersion: string;
  evidence: unknown;
  metadata?: Record<string, string>;
}

export interface RecallRecord {
  schemaVersion: 1;
  id: string;
  sourceId: string;
  createdAt: string;
  decision: string;
  score?: number;
  threshold?: number;
  reason?: string;
  model: string;
  policyVersion: string;
  evidenceFingerprint: string;
  evidence?: unknown;
  preview?: string;
  retention: RetentionMode;
  metadata?: Record<string, string>;
  status: RecallStatus;
}

export interface AuditEvent {
  schemaVersion: 1;
  id: string;
  recordId: string;
  at: string;
  type: "quarantined" | "reviewed" | "replayed";
  status: RecallStatus;
  actor?: string;
  note?: string;
  previousStatus?: RecallStatus;
  evaluation?: { decision: string; score?: number; model: string; policyVersion: string };
}

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function canonical(value: unknown): unknown { return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : value; }
export function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex"); }

function previewOf(value: unknown, max = 240): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function createRecord(input: RejectionInput, options: { retention?: RetentionMode; now?: Date } = {}): RecallRecord {
  assert(input.sourceId?.trim(), "sourceId is required");
  assert(input.model?.trim(), "model is required");
  assert(input.policyVersion?.trim(), "policyVersion is required");
  if (input.score !== undefined) assert(Number.isFinite(input.score) && input.score >= 0 && input.score <= 1, "score must be between zero and one");
  const retention = options.retention ?? "fingerprint";
  const base = {
    schemaVersion: 1 as const, id: randomUUID(), sourceId: input.sourceId,
    createdAt: (options.now ?? new Date()).toISOString(), decision: input.decision,
    ...(input.score === undefined ? {} : { score: input.score }),
    ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    model: input.model, policyVersion: input.policyVersion,
    evidenceFingerprint: fingerprint(input.evidence), retention,
    ...(input.metadata === undefined ? {} : { metadata: structuredClone(input.metadata) }),
    status: "pending" as const,
  };
  if (retention === "full") return { ...base, evidence: structuredClone(input.evidence) };
  if (retention === "preview") return { ...base, preview: previewOf(input.evidence) };
  return base;
}

export function materialize(records: RecallRecord[], events: AuditEvent[]): RecallRecord[] {
  const byId = new Map(records.map(record => [record.id, structuredClone(record)]));
  for (const event of events) {
    const record = byId.get(event.recordId);
    if (record) record.status = event.status;
  }
  return [...byId.values()];
}

export function deterministicSample(records: RecallRecord[], options: { rate?: number; count?: number; seed?: string } = {}): RecallRecord[] {
  const pending = records.filter(record => record.status === "pending");
  const rate = options.rate ?? 0.1;
  assert((options.count !== undefined && Number.isInteger(options.count) && options.count >= 0) || (rate >= 0 && rate <= 1), "Provide a non-negative count or a rate between zero and one");
  const scored = pending.map(record => ({ record, score: fingerprint(`${options.seed ?? "default"}:${record.id}`) })).sort((a, b) => a.score.localeCompare(b.score));
  const count = options.count ?? Math.ceil(pending.length * rate);
  return scored.slice(0, count).map(item => item.record);
}

export interface ReplayEvaluation { decision: string; score?: number; model: string; policyVersion: string; }

export async function replay(records: RecallRecord[], evaluate: (evidence: unknown, record: RecallRecord) => Promise<ReplayEvaluation>, options: { recoverWhen?: (before: RecallRecord, after: ReplayEvaluation) => boolean } = {}): Promise<{ record: RecallRecord; evaluation: ReplayEvaluation; status: RecallStatus }[]> {
  const recoverWhen = options.recoverWhen ?? ((before, after) => after.decision !== before.decision);
  const results = [];
  for (const record of records) {
    assert(record.retention === "full" && Object.hasOwn(record, "evidence"), `${record.id}: replay requires full retained evidence`);
    const evaluation = await evaluate(structuredClone(record.evidence), structuredClone(record));
    assert(evaluation.model && evaluation.policyVersion && evaluation.decision, `${record.id}: invalid replay evaluation`);
    results.push({ record, evaluation, status: recoverWhen(record, evaluation) ? "recovered" as const : "confirmed-reject" as const });
  }
  return results;
}

export function summarize(records: RecallRecord[]) {
  const counts = { pending: 0, "confirmed-reject": 0, recovered: 0, expired: 0 };
  for (const record of records) counts[record.status]++;
  const reviewed = counts["confirmed-reject"] + counts.recovered;
  return {
    total: records.length, ...counts,
    reviewed,
    observedFalseNegativeRate: reviewed ? Math.round((counts.recovered / reviewed) * 1_000_000) / 1_000_000 : null,
  };
}

export class RecallStore {
  readonly path: string;
  readonly eventsPath: string;
  #queue: Promise<void> = Promise.resolve();
  constructor(path: string) { this.path = path; this.eventsPath = `${path}.events`; }

  async #prepare(path: string) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, "a", 0o600);
    await handle.close();
    await chmod(path, 0o600);
  }

  #serialize(work: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => {});
    return next;
  }

  async append(record: RecallRecord): Promise<void> {
    return this.#serialize(async () => { await this.#prepare(this.path); await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 }); });
  }

  async appendEvent(event: AuditEvent): Promise<void> {
    return this.#serialize(async () => { await this.#prepare(this.eventsPath); await appendFile(this.eventsPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 }); });
  }

  async quarantine(input: RejectionInput, options?: { retention?: RetentionMode }): Promise<RecallRecord> {
    const record = createRecord(input, options);
    await this.append(record);
    await this.appendEvent({ schemaVersion: 1, id: randomUUID(), recordId: record.id, at: new Date().toISOString(), type: "quarantined", status: "pending" });
    return record;
  }

  async read(): Promise<{ records: RecallRecord[]; events: AuditEvent[] }> {
    const parse = async <T>(path: string): Promise<T[]> => {
      try {
        const content = await readFile(path, "utf8");
        return content.split("\n").filter(Boolean).map((line, index) => { try { return JSON.parse(line) as T; } catch { throw new Error(`${path}:${index + 1}: invalid JSONL`); } });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    };
    return { records: await parse<RecallRecord>(this.path), events: await parse<AuditEvent>(this.eventsPath) };
  }

  async list(): Promise<RecallRecord[]> { const data = await this.read(); return materialize(data.records, data.events); }

  async review(recordId: string, status: Exclude<RecallStatus, "pending">, options: { actor?: string; note?: string } = {}): Promise<AuditEvent> {
    const records = await this.list();
    const record = records.find(item => item.id === recordId);
    assert(record, `Unknown record: ${recordId}`);
    const event: AuditEvent = { schemaVersion: 1, id: randomUUID(), recordId, at: new Date().toISOString(), type: "reviewed", status, previousStatus: record.status, ...(options.actor ? { actor: options.actor } : {}), ...(options.note ? { note: options.note } : {}) };
    await this.appendEvent(event);
    return event;
  }

  async compact(): Promise<void> {
    const records = await this.list();
    await this.#serialize(async () => {
      await this.#prepare(this.path);
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, records.map(record => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
      // Events remain append-only: the compacted snapshot speeds reads without
      // erasing who reviewed or replayed an original rejection.
      await this.#prepare(this.eventsPath);
    });
  }

  async permissions(): Promise<number | null> { try { return (await stat(this.path)).mode & 0o777; } catch { return null; } }
}
