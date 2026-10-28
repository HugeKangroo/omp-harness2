import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibraryStore, RunLockedError, RunStore, StoreConflictError, StoreCorruptionError } from "../src/store.ts";
import type { LibraryEntry, RunRecord } from "../src/types.ts";

const temporary: string[] = [];
async function directory(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "harness2-store-")); temporary.push(root); return root; }
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function record(id = "run-1"): RunRecord {
  return {
    schemaVersion: 1, id, revision: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    workspace: "/work", task: "fix the parser", status: "queued",
    config: { mode: "product", model: "provider/solver", improverModel: "provider/editor", maxCostUsd: 3, maxDurationMs: 60000, stageTimeoutMs: 10000, domain: "code", ompCommand: "omp" },
    baseHarness: { schemaVersion: 1, id: "base", promptAppend: "", toolGuidance: "", skills: [], rationale: "" },
    libraryEntries: [], stages: {},
  };
}
function entry(id = "lesson-1"): LibraryEntry {
  return { schemaVersion: 1, id, runId: "run-1", domain: "../../code", model: "provider/model", createdAt: "2026-01-01T00:00:00.000Z", harness: record().baseHarness,
    lesson: { cue: "parser tasks", lesson: "exercise malformed inputs", evidence: ["baseline failed a malformed input"], confidence: "medium", limitations: "one task" } };
}

describe("RunStore", () => {
  test("creation persists revision zero, uses private files, and refuses duplicate IDs", async () => {
    const root = await directory(); const store = new RunStore(join(root, "runs"));
    const created = await store.create({ ...record(), revision: 77 });
    expect(created.revision).toBe(0); expect(await store.get(created.id)).toEqual(created);
    expect((await store.list()).map(run => run.id)).toEqual([created.id]);
    expect((await stat(store.root)).mode & 0o777).toBe(0o700);
    expect((await stat(store.runDir(created.id))).mode & 0o777).toBe(0o700);
    expect((await stat(join(store.runDir(created.id), "run.json"))).mode & 0o777).toBe(0o600);
    await expect(store.create(record())).rejects.toBeInstanceOf(StoreConflictError);
  });

  test("concurrent CAS writers cannot overwrite each other, including across store instances", async () => {
    const root = await directory(); const first = new RunStore(root); const second = new RunStore(root);
    const original = await first.create(record());
    const results = await Promise.allSettled([
      first.save({ ...original, status: "running" }, 0),
      second.save({ ...original, status: "cancelled" }, 0),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await first.get(original.id))?.revision).toBe(1);
    expect(JSON.parse(await readFile(join(first.runDir(original.id), "run.json.bak"), "utf8")).revision).toBe(0);
    await expect(first.save({ ...original, revision: 1 }, 0)).rejects.toBeInstanceOf(StoreConflictError);
  });

  test("a whole-run lease excludes another owner but permits persistence; release is idempotent", async () => {
    const store = new RunStore(await directory()); const run = await store.create(record());
    const release = await store.acquire(run.id);
    await expect(store.acquire(run.id)).rejects.toBeInstanceOf(RunLockedError);
    await store.save({ ...run, status: "running" }, 0);
    await release(); await release(); const next = await store.acquire(run.id); await next();
  });

  test("dead-PID locks can be reclaimed but malformed owner records are never silently removed", async () => {
    const store = new RunStore(await directory()); await store.create(record());
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(dead.status).toBe(0); expect(dead.pid).toBeGreaterThan(0);
    const path = join(store.runDir("run-1"), ".run.lock"); await mkdir(path);
    await writeFile(join(path, "owner.json"), JSON.stringify({ pid: dead.pid, token: "stale-owner", createdAt: "2026-01-01T00:00:00Z" }));
    const release = await store.acquire("run-1"); await release();
    await mkdir(path); await writeFile(join(path, "owner.json"), "broken");
    await expect(store.acquire("run-1")).rejects.toBeInstanceOf(StoreCorruptionError);
    expect(await readFile(join(path, "owner.json"), "utf8")).toBe("broken");
  });

  test("release refuses to delete another owner's lock", async () => {
    const store = new RunStore(await directory()); await store.create(record()); const release = await store.acquire("run-1");
    const path = join(store.runDir("run-1"), ".run.lock", "owner.json");
    await writeFile(path, JSON.stringify({ pid: process.pid, token: "replacement", createdAt: "2026-01-01T00:00:00Z" }));
    await expect(release()).rejects.toBeInstanceOf(RunLockedError);
    expect(JSON.parse(await readFile(path, "utf8")).token).toBe("replacement");
  });

  test("corruption fails visibly; explicit recovery preserves damaged bytes and invalidates old revisions", async () => {
    const store = new RunStore(await directory()); const original = await store.create(record());
    await store.save({ ...original, status: "running" }, 0);
    const path = join(store.runDir(original.id), "run.json"); await writeFile(path, '{"incomplete":');
    await expect(store.get(original.id)).rejects.toBeInstanceOf(StoreCorruptionError);
    await expect(store.list()).rejects.toBeInstanceOf(StoreCorruptionError);
    const recovered = await store.recover(original.id);
    expect(recovered.status).toBe("queued"); expect(recovered.revision).toBe(2);
    const preserved = (await readdir(store.runDir(original.id))).find(file => file.startsWith("run.json.corrupt."));
    expect(preserved).toBeDefined(); expect(await readFile(join(store.runDir(original.id), preserved!), "utf8")).toBe('{"incomplete":');
    await expect(store.save({ ...recovered, revision: 1 }, 1)).rejects.toBeInstanceOf(StoreConflictError);
    await expect(store.recover(original.id)).rejects.toBeInstanceOf(StoreConflictError);
    await writeFile(path, "broken again");
    expect((await store.recover(original.id)).revision).toBe(4);
  });

  test("event writes serialize and torn logs are reported rather than truncated", async () => {
    const store = new RunStore(await directory()); await store.create(record());
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.appendEvent({ schemaVersion: 1, runId: "run-1", timestamp: new Date().toISOString(), type: "stage", message: String(index) })));
    expect((await store.events("run-1")).map(event => event.message)).toEqual(Array.from({ length: 20 }, (_, index) => String(index)));
    const path = join(store.runDir("run-1"), "events.jsonl"); await writeFile(path, '{"partial":');
    await expect(store.events("run-1")).rejects.toBeInstanceOf(StoreCorruptionError);
    await expect(store.appendEvent({ schemaVersion: 1, runId: "run-1", timestamp: new Date().toISOString(), type: "test", message: "test" })).rejects.toBeInstanceOf(StoreCorruptionError);
    expect(await readFile(path, "utf8")).toBe('{"partial":');
  });

  test("traversal, schema mismatches, and symlinked run directories are rejected", async () => {
    const store = new RunStore(await directory());
    for (const id of ["../escape", "/absolute", "a/b", "..", "", "x\\y"]) {
      expect(() => store.runDir(id)).toThrow(); await expect(store.get(id)).rejects.toThrow();
    }
    await expect(store.create({ ...record(), status: "invented" } as unknown as RunRecord)).rejects.toThrow();
    await store.create(record());
    await writeFile(join(store.runDir("run-1"), "run.json"), JSON.stringify({ ...record(), schemaVersion: 2 }));
    await expect(store.get("run-1")).rejects.toBeInstanceOf(StoreCorruptionError);
    const outside = await directory(); await symlink(outside, store.runDir("linked"));
    await expect(store.get("linked")).rejects.toBeInstanceOf(StoreCorruptionError);
    await expect(store.create(record("linked"))).rejects.toBeInstanceOf(StoreCorruptionError);
  });

  test("stored enums reject coercible arrays and objects, including nested worker status", async () => {
    const store = new RunStore(await directory()); await store.create(record());
    const file = join(store.runDir("run-1"), "run.json");
    const result = { text: "done", status: "completed", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 }, startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:01Z", eventsPath: "/tmp/events.jsonl" };
    const stage = { id: "baseline", status: "completed", attempt: 1, cwd: "/tmp/workspace", startedAt: "2026-01-01T00:00:00Z", result };
    const invalid = [
      { ...record(), status: ["completed"] },
      { ...record(), config: { ...record().config, mode: ["research"] } },
      { ...record(), stages: { baseline: { ...stage, status: ["completed"] } } },
      { ...record(), stages: { baseline: { ...stage, result: { ...result, status: ["completed"] } } } },
      { ...record(), lesson: { ...entry().lesson, confidence: ["high"] } },
      { ...record(), lesson: { ...entry().lesson, confidence: { toString: "high" } } },
    ];
    for (const value of invalid) {
      await writeFile(file, JSON.stringify(value));
      await expect(store.get("run-1")).rejects.toBeInstanceOf(StoreCorruptionError);
    }
    await writeFile(file, JSON.stringify(record()));
    const event = { schemaVersion: 1, runId: "run-1", timestamp: "2026-01-01T00:00:00Z", type: "stage", stage: ["baseline"], message: "invalid enum type" };
    await writeFile(join(store.runDir("run-1"), "events.jsonl"), `${JSON.stringify(event)}\n`);
    await expect(store.events("run-1")).rejects.toBeInstanceOf(StoreCorruptionError);
  });

  test("persisted artifact digests and validation counters cannot bypass the resume checks", async () => {
    const store = new RunStore(await directory()); await store.create(record());
    const file = join(store.runDir("run-1"), "run.json");
    const stage = { id: "baseline", status: "running", attempt: 1, cwd: "/tmp/workspace", startedAt: "2026-01-01T00:00:00Z", artifactHash: "a".repeat(64), validationFailures: 0 };
    await writeFile(file, JSON.stringify({ ...record(), stages: { baseline: stage } }));
    expect((await store.get("run-1"))?.stages.baseline?.artifactHash).toBe("a".repeat(64));
    for (const patch of [{ artifactHash: ["a".repeat(64)] }, { artifactHash: "g".repeat(64) }, { artifactHash: "a".repeat(63) }, { validationFailures: -1 }, { validationFailures: 0.5 }, { validationFailures: "1" }, { validationFailures: Number.MAX_SAFE_INTEGER + 1 }]) {
      await writeFile(file, JSON.stringify({ ...record(), stages: { baseline: { ...stage, ...patch } } }));
      await expect(store.get("run-1")).rejects.toBeInstanceOf(StoreCorruptionError);
    }
  });

  test("persisted warnings, trace hashes, and billing provenance remain strictly typed", async () => {
    const store = new RunStore(await directory()); await store.create(record());
    const file = join(store.runDir("run-1"), "run.json");
    const result = { text: "done", status: "completed", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 }, startedAt: "2026-01-01T00:00:00Z", endedAt: "2026-01-01T00:00:01Z", eventsPath: "/tmp/events.jsonl", usageEstimated: true };
    const stage = { id: "baseline", status: "completed", attempt: 1, cwd: "/tmp/workspace", startedAt: "2026-01-01T00:00:00Z", traceHash: "b".repeat(64), observedCostUsd: 0, result };
    const valid = { ...record(), warnings: ["Provider billing is estimated"], stages: { baseline: stage } };
    await writeFile(file, JSON.stringify(valid));
    const loaded = await store.get("run-1");
    expect(loaded?.warnings).toEqual(valid.warnings);
    expect(loaded?.stages.baseline?.traceHash).toBe(stage.traceHash);
    expect(loaded?.stages.baseline?.observedCostUsd).toBe(0);
    expect(loaded?.stages.baseline?.result?.usageEstimated).toBe(true);
    const malformed = [
      { ...valid, warnings: "estimated" },
      { ...valid, warnings: ["estimated", 1] },
      { ...valid, warnings: null },
      ...[{ traceHash: ["b".repeat(64)] }, { traceHash: "b".repeat(63) }, { traceHash: "z".repeat(64) }, { observedCostUsd: -1 }, { observedCostUsd: "0.1" }, { observedCostUsd: Infinity }].map(patch => ({ ...valid, stages: { baseline: { ...stage, ...patch } } })),
      ...["false", 0, null, [true]].map(usageEstimated => ({ ...valid, stages: { baseline: { ...stage, result: { ...result, usageEstimated } } } })),
    ];
    for (const value of malformed) {
      await writeFile(file, JSON.stringify(value));
      await expect(store.get("run-1")).rejects.toBeInstanceOf(StoreCorruptionError);
    }
    await writeFile(file, JSON.stringify({ ...valid, warnings: [], stages: { baseline: { ...stage, observedCostUsd: 0.25, result: { ...result, usageEstimated: false } } } }));
    expect((await store.get("run-1"))?.stages.baseline?.result?.usageEstimated).toBe(false);
  });
});

describe("LibraryStore", () => {
  test("namespaces are hashed, additions are idempotent, and conflicting IDs fail", async () => {
    const root = await directory(); const library = new LibraryStore(root); const lesson = entry();
    await library.add(lesson); await library.add(structuredClone(lesson));
    expect(await library.list(lesson.domain, lesson.model)).toEqual([lesson]);
    expect(await library.list("another domain", lesson.model)).toEqual([]);
    expect((await readdir(root)).every(name => /^[a-f0-9]{64}$/.test(name))).toBe(true);
    await expect(library.add({ ...lesson, lesson: { ...lesson.lesson, cue: "different" } })).rejects.toBeInstanceOf(StoreConflictError);
    await expect(library.add({ ...lesson, id: "../escape" })).rejects.toThrow();
  });

  test("corrupt or foreign namespace entries are surfaced, never skipped", async () => {
    const root = await directory(); const library = new LibraryStore(root); const lesson = entry(); await library.add(lesson);
    const namespace = (await readdir(root))[0]!; const path = join(root, namespace, `${lesson.id}.json`);
    await writeFile(path, JSON.stringify({ ...lesson, domain: "other" }));
    await expect(library.list(lesson.domain, lesson.model)).rejects.toBeInstanceOf(StoreCorruptionError);
    await writeFile(path, "{bad");
    await expect(library.list(lesson.domain, lesson.model)).rejects.toBeInstanceOf(StoreCorruptionError);
    await expect(library.add(lesson)).rejects.toBeInstanceOf(StoreCorruptionError);
  });

  test("persisted library confidence must be a literal enum string", async () => {
    const root = await directory(); const library = new LibraryStore(root); const lesson = entry(); await library.add(lesson);
    const namespace = (await readdir(root))[0]!;
    await writeFile(join(root, namespace, `${lesson.id}.json`), JSON.stringify({ ...lesson, lesson: { ...lesson.lesson, confidence: ["high"] } }));
    await expect(library.list(lesson.domain, lesson.model)).rejects.toBeInstanceOf(StoreCorruptionError);
  });
});
