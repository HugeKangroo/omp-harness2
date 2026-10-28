import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HarnessController, accountedCost } from "../src/controller.ts";
import { reviewDigest } from "../src/conversation.ts";
import type { Runner, WorkerRequest, WorkerResult } from "../src/types.ts";

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "harness-controller-"));
  roots.push(root);
  spawnSync("git", ["init", "-q", root]);
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/value.ts"), "export const value = 'initial';\n");
  spawnSync("git", ["-C", root, "add", "src/value.ts"]);
  return root;
}

class FakeRunner implements Runner {
  calls: WorkerRequest[] = [];
  failOnce?: string;
  invalidEditors = false;
  reflect = true;
  reflectionEvidence = ["baseline", "final"];
  cost = 0.01;
  async run(request: WorkerRequest): Promise<WorkerResult> {
    this.calls.push(request);
    if (this.failOnce === request.stage) { this.failOnce = undefined; throw new Error("Simulated worker process loss"); }
    const startedAt = new Date().toISOString();
    mkdirSync(request.artifactDir, { recursive: true });
    const eventsPath = path.join(request.artifactDir, "events.jsonl");
    writeFileSync(eventsPath, JSON.stringify({ type: "test", stage: request.stage }) + "\n");
    let text: string;
    if (request.role === "solver") {
      expect(readFileSync(path.join(request.cwd, "src/value.ts"), "utf8")).toContain("initial");
      writeFileSync(path.join(request.cwd, "src/value.ts"), `export const value = '${request.stage}';\n`);
      text = `Artifact for ${request.stage}`;
    } else if (request.role === "editor") {
      if (request.stage === "dom_edit") {
        expect(existsSync(path.join(request.cwd, ".harness-evidence/baseline"))).toBe(true);
        expect(existsSync(path.join(request.cwd, ".harness-evidence/inv_edit"))).toBe(false);
      }
      text = this.invalidEditors ? "invalid" : JSON.stringify({ promptAppend: `Policy ${request.stage}`, toolGuidance: "Use scoped tools", skills: [], rationale: "Observed behavior" });
    } else if (request.role === "selector") {
      const a = request.prompt.split("CANDIDATE A:\n")[1]!.split("CANDIDATE B:")[0]!;
      text = JSON.stringify({ winner: a.includes("Artifact for final") ? "A" : "B", reason: "The final artifact meets the task constraint." });
    } else {
      text = this.reflect ? JSON.stringify({ cue: "Constrained local changes", lesson: "Specify an observable completion condition", evidence: this.reflectionEvidence, confidence: "low", limitations: "One run; behavior is confounded." }) : '{"noEntry":true}';
    }
    return { text, usage: { inputTokens: 10, outputTokens: 10, costUsd: this.cost }, startedAt, endedAt: new Date().toISOString(), eventsPath, status: "completed" };
  }
}

describe("durable Harness² controller", () => {
  test("apply checks the approved review inside the run lease before writing", async () => {
    const root = fixture(); const runner = new FakeRunner();
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Change the constant", { model: "test/model", strategy: "legacy" });
    const completed = await controller.execute(created.id);
    const digest = reviewDigest(completed, await controller.diff(created.id));
    // Simulate a newly reviewed answer after the UI displayed the old artifact.
    completed.stages.final!.result!.text = "An updated selected response that the user has not reviewed.";
    await controller.store.save(completed, completed.revision);
    await expect(controller.apply(created.id, digest)).rejects.toThrow("changed after review");
    expect(readFileSync(path.join(root, "src/value.ts"), "utf8")).toContain("initial");
    const current = (await controller.get(created.id))!;
    const fresh = reviewDigest(current, await controller.diff(created.id));
    const appendEvent = controller.store.appendEvent.bind(controller.store);
    let allowed = true;
    controller.store.appendEvent = async event => {
      await appendEvent(event);
      if (event.type === "apply_started") allowed = false;
    };
    await expect(controller.apply(created.id, fresh, () => { if (!allowed) throw new Error("Conversation changed before commit"); })).rejects.toThrow("before commit");
    expect(readFileSync(path.join(root, "src/value.ts"), "utf8")).toContain("initial");
    controller.store.appendEvent = appendEvent;
    expect((await controller.apply(created.id, fresh)).applied).toBe(true);
    expect((await controller.apply(created.id, fresh)).alreadyApplied).toBe(true);
  });

  test("records predating strategy keep the legacy pipeline and research rejects adaptive overrides", async () => {
    const root = fixture(); const runner = new FakeRunner();
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Resume an old task", { model: "test/model", strategy: "legacy" });
    delete created.config.strategy;
    await controller.store.save(created, created.revision);
    const record = await controller.execute(created.id);
    expect(record.status).toBe("completed");
    expect(record.config.strategy).toBeUndefined();
    expect(record.winner).toBe("final");
    expect(runner.calls.some(call => call.stage === "plan")).toBe(false);
    for (const strategy of ["auto", "direct", "explore"] as const) {
      await expect(controller.create("Research", { model: "test/model", mode: "research", strategy })).rejects.toThrow("legacy");
    }
  });

  test("runs full product flow from identical snapshots, retains evidence and applies only on command", async () => {
    const root = fixture(); const runner = new FakeRunner();
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Change the constant", { strategy: "legacy", model: "test/model" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("completed");
    expect(record.winner).toBe("final");
    expect(runner.calls.map(r => r.stage)).toEqual(["baseline", "inv_edit", "dom_edit", "inv_probe", "dom_probe", "compose_edit", "final", "select", "reflect"]);
    expect(readFileSync(path.join(root, "src/value.ts"), "utf8")).toContain("initial");
    expect(record.lesson?.confidence).toBe("low");
    expect(accountedCost(record)).toBeCloseTo(0.09);
    expect((await controller.diff(record.id))[0]?.path).toBe("src/value.ts");
    expect((await controller.apply(record.id)).applied).toBe(true);
    expect(readFileSync(path.join(root, "src/value.ts"), "utf8")).toContain("final");
    expect((await controller.apply(record.id)).alreadyApplied).toBe(true);
    expect((await controller.create("Another task", { strategy: "legacy", model: "test/model" })).libraryEntries).toHaveLength(1);
    await controller.execute(record.id);
    expect(runner.calls).toHaveLength(9);
  });

  test("research mode bypasses selector; pending runs keep their frozen library frontier", async () => {
    const root = fixture(); const runner = new FakeRunner();
    const controller = new HarnessController({ workspace: root, runner });
    const first = await controller.create("Task one", { strategy: "legacy", model: "test/model", mode: "research" });
    const pending = await controller.create("Task two", { strategy: "legacy", model: "test/model", mode: "research" });
    const record = await controller.execute(first.id);
    expect(record.status).toBe("completed");
    expect(runner.calls.some(r => r.stage === "select")).toBe(false);
    expect((await controller.get(pending.id))?.libraryEntries).toHaveLength(0);
  });

  test("resumes completed stages without replay and retains cost reservation after process loss", async () => {
    const root = fixture(); const runner = new FakeRunner(); runner.failOnce = "inv_probe";
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Resume a task", { strategy: "legacy", model: "test/model" });
    const interrupted = await controller.execute(created.id);
    expect(interrupted.status).toBe("failed");
    expect(interrupted.stages.inv_probe?.accountedCostUsd).toBeGreaterThan(0);
    const record = await controller.resume(created.id);
    expect(record.status).toBe("completed");
    expect(runner.calls.filter(r => r.stage === "baseline")).toHaveLength(1);
    expect(runner.calls.filter(r => r.stage === "inv_probe")).toHaveLength(2);
    expect(record.stages.inv_probe!.accountedCostUsd).toBeGreaterThan(0.01);
  });

  test("unverifiable worker ownership blocks duplicate recovery before dispatch", async () => {
    const root = fixture(); const runner = new FakeRunner(); runner.failOnce = "inv_probe";
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Resume with uncertain worker ownership", { strategy: "legacy", model: "test/model" });
    const failed = await controller.execute(created.id);
    expect(failed.status).toBe("failed");
    const ownerPath = path.join(path.dirname(failed.stages.inv_probe!.cwd), "artifacts", "worker-owner.json");
    mkdirSync(path.dirname(ownerPath), { recursive: true });
    writeFileSync(ownerPath, JSON.stringify({ pgid: 1, runId: created.id, stage: "inv_probe" }));
    const count = runner.calls.length;
    const blocked = await controller.resume(created.id);
    expect(blocked.status).toBe("failed");
    expect(blocked.error).toContain("Invalid worker ownership metadata");
    expect(runner.calls).toHaveLength(count);
    rmSync(ownerPath);
    expect((await controller.resume(created.id)).status).toBe("completed");
    expect(runner.calls.filter(call => call.stage === "baseline")).toHaveLength(1);
  });

  test("cancel before dispatch requires explicit resume and does not spend money", async () => {
    const root = fixture(); const runner = new FakeRunner();
    const controller = new HarnessController({ workspace: root, runner });
    const record = await controller.create("Cancelled task", { strategy: "legacy", model: "test/model" });
    await controller.cancel(record.id);
    expect((await controller.execute(record.id)).status).toBe("cancelled");
    expect(runner.calls).toHaveLength(0);
    await expect(controller.execute(record.id)).rejects.toThrow("resume");
    expect((await controller.resume(record.id)).status).toBe("completed");
  });

  test("invalid proposals retry once and inherit the parent instead of loading arbitrary code", async () => {
    const root = fixture(); const runner = new FakeRunner(); runner.invalidEditors = true;
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("A task", { strategy: "legacy", model: "test/model" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("completed");
    expect(record.stages.inv_edit!.attempt).toBe(2);
    expect(record.stages.inv_edit!.harness!.id).toBe(record.baseHarness.id);
    expect((await controller.events(record.id)).filter(e => e.type === "fallback")).toHaveLength(3);
  });

  test("over-budget result fails the run and never applies code or publishes a lesson", async () => {
    const root = fixture(); const runner = new FakeRunner(); runner.cost = 100;
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("A task", { strategy: "legacy", model: "test/model", maxCostUsd: 1 });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("failed");
    expect(runner.calls).toHaveLength(1);
    await expect(controller.apply(record.id)).rejects.toThrow("completed");
    expect(await controller.library.list("project", "test/model")).toHaveLength(0);
  });

  test("apply refuses source drift after completion", async () => {
    const root = fixture(); const runner = new FakeRunner();
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("A task", { strategy: "legacy", model: "test/model" });
    const record = await controller.execute(created.id);
    writeFileSync(path.join(root, "src/value.ts"), "new user changes");
    await expect(controller.apply(record.id)).rejects.toThrow();
    expect(readFileSync(path.join(root, "src/value.ts"), "utf8")).toBe("new user changes");
  });

  test("a post-selection candidate mutation cannot change the reviewed artifact", async () => {
    const root = fixture(); const runner = new FakeRunner();
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("A task", { strategy: "legacy", model: "test/model" });
    const record = await controller.execute(created.id);
    writeFileSync(path.join(record.stages.final!.cwd, "src/value.ts"), "unreviewed modification");
    await expect(controller.diff(record.id)).rejects.toThrow("changed after execution");
    await expect(controller.apply(record.id)).rejects.toThrow("changed after execution");
    expect(readFileSync(path.join(root, "src/value.ts"), "utf8")).toContain("initial");
  });

  test("an optional reflection failure does not discard an already adopted artifact", async () => {
    const root = fixture(); const runner = new FakeRunner(); runner.failOnce = "reflect";
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("A task", { strategy: "legacy", model: "test/model" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("completed");
    expect(record.warnings?.[0]).toContain("Reflection");
    expect(record.lesson).toBeUndefined();
    expect(await controller.library.list("project", "test/model")).toHaveLength(0);
    expect(await controller.diff(record.id)).toHaveLength(1);
  });

  test("reflection retains completed editor and selector evidence alongside execution evidence", async () => {
    for (const mode of ["product", "research"] as const) {
      const root = fixture(); const runner = new FakeRunner();
      runner.reflectionEvidence = ["baseline", "final", "inv_edit", "dom_edit", "compose_edit", ...(mode === "product" ? ["select"] : [])];
      const controller = new HarnessController({ workspace: root, runner });
      const created = await controller.create("A task", { strategy: "legacy", model: "test/model", mode });
      const record = await controller.execute(created.id);
      expect(record.status).toBe("completed");
      expect(record.lesson?.evidence).toEqual(runner.reflectionEvidence);
      expect(record.warnings).toBeUndefined();
      const entries = await controller.library.list("project", "test/model");
      expect(entries).toHaveLength(1);
      expect(entries[0]!.lesson.evidence).toEqual(runner.reflectionEvidence);
    }
  });

  test("reflection still rejects evidence for stages that did not execute", async () => {
    const root = fixture(); const runner = new FakeRunner();
    runner.reflectionEvidence = ["baseline", "final", "select"];
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("A task", { strategy: "legacy", model: "test/model", mode: "research" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("completed");
    expect(record.stages.select).toBeUndefined();
    expect(record.lesson).toBeUndefined();
    expect(record.warnings?.[0]).toContain("Reflection");
    expect(await controller.library.list("project", "test/model")).toHaveLength(0);
  });

  test("partial preparation directories from a killed controller do not block recovery", async () => {
    const root = fixture(); const runner = new FakeRunner();
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("A task", { strategy: "legacy", model: "test/model" });
    const orphanSnapshot = path.join(controller.store.runDir(created.id), "snapshot");
    const orphanStage = path.join(controller.store.runDir(created.id), "stages/baseline/attempt-1/workspace");
    mkdirSync(orphanSnapshot, { recursive: true }); mkdirSync(orphanStage, { recursive: true });
    writeFileSync(path.join(orphanSnapshot, "partial"), "incomplete bytes");
    writeFileSync(path.join(orphanStage, "partial"), "no ownership marker yet");
    const record = await controller.resume(created.id);
    expect(record.status).toBe("completed");
    expect(readFileSync(path.join(record.stages.baseline!.cwd, "src/value.ts"), "utf8")).toContain("baseline");
  });
});
