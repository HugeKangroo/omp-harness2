import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HarnessController, accountedCost } from "../src/controller.ts";
import type { CandidateId, ExplorationCriterion, ExplorationPlan, Runner, StageId, WorkerRequest, WorkerResult } from "../src/types.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function put(root: string, file: string, text: string): void { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); }
function fixture(file = "draft.md"): string {
  const root = mkdtempSync(path.join(tmpdir(), "harness-exploration-")); roots.push(root);
  const initialized = spawnSync("git", ["init", "-q", root]); if (initialized.status !== 0) throw new Error("Could not initialize exploration fixture");
  put(root, file, "initial artifact\n"); put(root, "notes.txt", "original notes\n");
  return root;
}
function explorationPlan(decision: "direct" | "explore" = "explore"): ExplorationPlan {
  return {
    decision, reason: decision === "explore" ? "Two distinct approaches merit comparison." : "The requested edit has one clear implementation.",
    criteria: [{ id: "deliverable", description: "Produce the requested artifact", kind: "requirement" }, { id: "clarity", description: "Make the result easy to understand", kind: "quality" }],
    routes: decision === "direct" ? [] : [
      { id: "route_1", name: "Concrete example first", approach: "Begin with one concrete example, then generalize.", assumptions: ["A concrete example is available."], tradeoffs: ["Uses some space before the main explanation."] },
      { id: "route_2", name: "Structure first", approach: "Explain the structure before giving details.", assumptions: ["The audience understands the basic terms."], tradeoffs: ["Provides less immediate context."] },
    ],
  };
}
interface EvaluationInput {
  task: string;
  criteria: ExplorationCriterion[];
  candidates: Array<{ label: string; response: string; changes: unknown[]; files: string }>;
  allowRefinement: boolean;
}
function evaluationInput(prompt: string): EvaluationInput {
  const body = prompt.split("EVALUATION INPUT:\n")[1];
  if (!body) throw new Error("Evaluation prompt did not provide its structured input");
  return JSON.parse(body.split("\n\nAvailable evidence")[0]!) as EvaluationInput;
}
class ExplorationRunner implements Runner {
  calls: WorkerRequest[] = [];
  starts = new Map<StageId, string>();
  evaluations = new Map<StageId, EvaluationInput>();
  plan = explorationPlan();
  planResponse?: string;
  invalidSelection = false;
  rejectAll = false;
  reviewWinner: CandidateId = "route_1";
  selectionWinner: CandidateId = "refine";
  refinement?: CandidateId;
  failedStage?: StageId;
  estimatedStage?: StageId;
  processLossOnce?: StageId;
  cost = 0.01;
  writeArtifacts = true;
  edit?: (request: WorkerRequest) => void;
  beforeRun?: (request: WorkerRequest) => void | Promise<void>;
  constructor(readonly file = "draft.md") {}
  async run(request: WorkerRequest): Promise<WorkerResult> {
    this.calls.push(request);
    await this.beforeRun?.(request);
    if (this.processLossOnce === request.stage) { this.processLossOnce = undefined; throw new Error("Simulated worker process loss"); }
    const startedAt = new Date().toISOString(); mkdirSync(request.artifactDir, { recursive: true });
    const eventsPath = path.join(request.artifactDir, "events.jsonl");
    writeFileSync(eventsPath, JSON.stringify({ type: "fixture", stage: request.stage }) + "\n");
    let text: string;
    if (request.stage === "plan") {
      expect(request.role).toBe("editor"); text = this.planResponse ?? JSON.stringify(this.plan);
    } else if (request.role === "solver") {
      this.starts.set(request.stage, readFileSync(path.join(request.cwd, this.file), "utf8"));
      if (this.writeArtifacts) { put(request.cwd, this.file, `Artifact for ${request.stage}\n`); this.edit?.(request); }
      text = `Artifact for ${request.stage}`;
    } else if (request.role === "selector") {
      const input = evaluationInput(request.prompt); this.evaluations.set(request.stage, input);
      const find = (id: CandidateId) => input.candidates.find(candidate => candidate.response === `Artifact for ${id}`);
      const preferred = request.stage === "select" ? this.selectionWinner : this.reviewWinner;
      const winner = find(preferred) ?? input.candidates[0]!;
      const refine = this.refinement && input.allowRefinement ? find(this.refinement) : undefined;
      text = this.invalidSelection ? "This is not a structured evaluation." : JSON.stringify({
        assessments: input.candidates.map(candidate => ({ candidate: candidate.label,
          criteria: input.criteria.map(criterion => ({ criterionId: criterion.id,
            verdict: this.rejectAll || (candidate.response === "Artifact for refine" && this.selectionWinner !== "refine") ? "not_met" : "met",
            evidence: `Inspected the changed artifact described by ${candidate.response}.` })), strengths: ["Produces an inspectable artifact."], weaknesses: [] })),
        winner: this.rejectAll ? null : winner.label, reason: this.rejectAll ? "Every candidate violates a required condition." : "The selected artifact best meets the recorded criteria.", limitations: ["Fixture review; no independent task-quality measurement."],
        ...(refine ? { refinement: { candidate: refine.label, instructions: "Preserve the useful parts and improve the ending." } } : {}),
      });
    } else if (request.role === "reflector") text = '{"noEntry":true}';
    else throw new Error(`Unexpected adaptive stage: ${request.stage}`);
    return { text, usage: { inputTokens: 10, outputTokens: 10, costUsd: this.cost }, startedAt, endedAt: new Date().toISOString(), eventsPath,
      ...(request.stage === this.estimatedStage ? { usageEstimated: true } : {}),
      status: request.signal?.aborted ? "cancelled" : request.stage === this.failedStage ? "failed" : "completed", ...(request.stage === this.failedStage ? { error: "Known branch failure" } : {}) };
  }
}

describe("adaptive exploration controller", () => {
  test("default auto explores a writing task and admits a route as the final artifact", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); runner.reviewWinner = "route_2";
    const controller = new HarnessController({ workspace: root, runner });
    const task = "Write a clear project introduction in draft.md, comparing two possible approaches.";
    const created = await controller.create(task, { model: "test/model" });
    expect(created.config.strategy).toBe("auto");
    const record = await controller.execute(created.id);
    expect(record.status).toBe("completed"); expect(record.winner).toBe("route_2");
    expect(record.exploration?.plan).toEqual(runner.plan);
    expect(runner.calls.map(call => call.stage)).toEqual(["plan", "baseline", "route_1", "route_2", "review", "reflect"]);
    for (const stage of ["baseline", "route_1", "route_2"] as const) expect(runner.starts.get(stage)).toBe("initial artifact\n");
    expect(runner.evaluations.get("review")?.task).toBe(task);
    expect(record.exploration?.selection?.method).toBe("model_review");
    expect(record.exploration?.selection?.winner).toBe("route_2");
    expect(record.exploration?.selection?.assessments.map(assessment => assessment.candidate).sort()).toEqual(["baseline", "route_1", "route_2"]);
    expect(record.lesson).toBeUndefined(); expect(await controller.library.list("project", "test/model")).toHaveLength(0);
    expect(readFileSync(path.join(root, "draft.md"), "utf8")).toBe("initial artifact\n");
    expect((await controller.diff(record.id)).map(change => change.path)).toEqual(["draft.md"]);
    expect((await controller.apply(record.id)).applied).toBe(true);
    expect(readFileSync(path.join(root, "draft.md"), "utf8")).toBe("Artifact for route_2\n");
  });

  test("auto uses the direct route when planning finds one clear code edit", async () => {
    const root = fixture("src/value.ts"); const runner = new ExplorationRunner("src/value.ts"); runner.plan = explorationPlan("direct");
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Change the value in src/value.ts to the requested constant.", { model: "test/model" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("completed"); expect(record.winner).toBe("baseline");
    expect(record.exploration?.plan.decision).toBe("direct");
    expect(runner.calls.map(call => call.stage)).toEqual(["plan", "baseline", "select"]);
    expect(runner.evaluations.get("select")?.candidates).toHaveLength(1);
    expect(runner.evaluations.get("select")?.allowRefinement).toBe(false);
  });

  test("a distinct third route has equal standing and can win the comparison", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); runner.reviewWinner = "route_3";
    runner.plan.routes.push({ id: "route_3", name: "Question-driven structure", approach: "Organize the introduction around the reader's questions.", assumptions: ["The reader's main questions are known."], tradeoffs: ["May provide less narrative continuity."] });
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Explore three distinct structures for draft.md.", { model: "test/model", strategy: "explore" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("completed"); expect(record.winner).toBe("route_3");
    expect(runner.starts.get("route_3")).toBe("initial artifact\n");
    expect(record.exploration?.selection?.assessments.map(assessment => assessment.candidate).sort()).toEqual(["baseline", "route_1", "route_2", "route_3"]);
    expect((await controller.apply(record.id)).applied).toBe(true);
    expect(readFileSync(path.join(root, "draft.md"), "utf8")).toBe("Artifact for route_3\n");
  });

  test("explicit direct skips planning and evaluates the single result against the task", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Rewrite draft.md in a warmer tone.", { model: "test/model", strategy: "direct" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("completed"); expect(record.winner).toBe("baseline");
    expect(runner.calls.map(call => call.stage)).toEqual(["baseline", "select"]);
    expect(runner.evaluations.get("select")?.criteria.map(criterion => criterion.id)).toEqual(["task"]);
    expect(record.exploration?.selection?.assessments[0]?.candidate).toBe("baseline");
  });

  test("refinement continues the chosen route's actual files without changing its parent", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); runner.refinement = "route_1";
    runner.edit = request => {
      if (request.stage === "route_1") { put(request.cwd, "parts/ending.md", "parent ending\n"); unlinkSync(path.join(request.cwd, "notes.txt")); }
      if (request.stage === "refine") {
        expect(readFileSync(path.join(request.cwd, "parts/ending.md"), "utf8")).toBe("parent ending\n");
        expect(existsSync(path.join(request.cwd, "notes.txt"))).toBe(false); put(request.cwd, "parts/ending.md", "refined ending\n");
      }
    };
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Explore and refine alternative introductions.", { model: "test/model", strategy: "explore" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("completed"); expect(record.winner).toBe("refine");
    expect(runner.starts.get("refine")).toBe("Artifact for route_1\n");
    expect(runner.calls.find(call => call.stage === "refine")?.prompt).toContain("Artifact for route_1");
    expect(record.stages.refine?.parentStage).toBe("route_1");
    expect(record.stages.refine?.parentArtifactHash).toBe(record.stages.route_1?.artifactHash);
    expect(readFileSync(path.join(record.stages.route_1!.cwd, "draft.md"), "utf8")).toBe("Artifact for route_1\n");
    expect(readFileSync(path.join(record.stages.route_1!.cwd, "parts/ending.md"), "utf8")).toBe("parent ending\n");
    expect(runner.evaluations.get("select")?.candidates).toHaveLength(4);
    expect(runner.evaluations.get("select")?.allowRefinement).toBe(false);
    expect(runner.calls.filter(call => call.stage === "refine")).toHaveLength(1);
    expect((await controller.diff(record.id)).map(change => [change.path, change.kind])).toEqual([["draft.md", "modify"], ["notes.txt", "delete"], ["parts/ending.md", "add"]]);
    expect((await controller.apply(record.id)).applied).toBe(true);
    expect(readFileSync(path.join(root, "parts/ending.md"), "utf8")).toBe("refined ending\n");
    expect(existsSync(path.join(root, "notes.txt"))).toBe(false);
  });

  test("response-only deliverables remain comparable and refinement receives the parent response", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); runner.writeArtifacts = false; runner.refinement = "route_1";
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Return a concise plan in your response only; do not edit any files.", { model: "test/model", strategy: "explore" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("completed"); expect(record.winner).toBe("refine");
    expect(record.stages.refine?.result?.text).toBe("Artifact for refine");
    expect(runner.calls.find(call => call.stage === "refine")?.prompt).toContain("Artifact for route_1");
    expect(runner.starts.get("refine")).toBe("initial artifact\n");
    expect(runner.evaluations.get("select")?.candidates.every(candidate => candidate.changes.length === 0)).toBe(true);
    expect(await controller.diff(record.id)).toEqual([]);
    expect(readFileSync(path.join(root, "draft.md"), "utf8")).toBe("initial artifact\n");
  });

  test("a worse refinement can lose to the preserved parent route", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); runner.refinement = "route_1"; runner.selectionWinner = "route_1";
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Compare the drafts and revise only if useful.", { model: "test/model", strategy: "explore" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("completed"); expect(record.stages.refine?.status).toBe("completed"); expect(record.winner).toBe("route_1");
    expect(record.exploration?.selection?.assessments.find(assessment => assessment.candidate === "refine")?.criteria.every(criterion => criterion.verdict === "not_met")).toBe(true);
    expect((await controller.apply(record.id)).applied).toBe(true);
    expect(readFileSync(path.join(root, "draft.md"), "utf8")).toBe("Artifact for route_1\n");
  });

  test("a known route failure remains evidence while other successful routes stay eligible", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); runner.failedStage = "route_1"; runner.reviewWinner = "route_2";
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Explore alternative drafts.", { model: "test/model", strategy: "explore" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("completed"); expect(record.winner).toBe("route_2");
    expect(record.stages.route_1?.status).toBe("failed"); expect(record.stages.route_2?.status).toBe("completed");
    expect(record.exploration?.selection?.assessments.map(assessment => assessment.candidate).sort()).toEqual(["baseline", "route_2"]);
    expect(accountedCost(record)).toBeGreaterThanOrEqual(runner.cost * runner.calls.length);
  });

  test("a returned branch failure with unknown cost stops further scheduling", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); runner.failedStage = "route_1"; runner.estimatedStage = "route_1";
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Explore alternative drafts within the budget.", { model: "test/model", strategy: "explore" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("failed"); expect(record.stages.route_1?.result?.usageEstimated).toBe(true);
    expect(record.stages.route_1?.accountedCostUsd).toBeGreaterThan(runner.cost);
    expect(runner.calls.some(call => ["route_2", "review", "refine", "select", "reflect"].includes(call.stage))).toBe(false);
    expect(readFileSync(path.join(root, "draft.md"), "utf8")).toBe("initial artifact\n");
  });

  test("process loss fails the run and resume preserves completed work and reserved cost", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); runner.processLossOnce = "route_1";
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Resume alternative drafting after interruption.", { model: "test/model", strategy: "explore" });
    const failed = await controller.execute(created.id);
    expect(failed.status).toBe("failed"); expect(failed.stages.route_1?.accountedCostUsd).toBeGreaterThan(0);
    expect(runner.calls.some(call => call.stage === "route_2")).toBe(false);
    const resumed = await controller.resume(created.id);
    expect(resumed.status).toBe("completed");
    expect(runner.calls.filter(call => call.stage === "plan")).toHaveLength(1);
    expect(runner.calls.filter(call => call.stage === "baseline")).toHaveLength(1);
    expect(runner.calls.filter(call => call.stage === "route_1")).toHaveLength(2);
    expect(resumed.stages.route_1!.accountedCostUsd).toBeGreaterThan(runner.cost);
  });

  test("resume after refinement process loss reuses the durable review and excluded branches", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); runner.refinement = "route_1"; runner.failedStage = "route_2"; runner.processLossOnce = "refine";
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Compare and refine the best introduction.", { model: "test/model", strategy: "explore" });
    const failed = await controller.execute(created.id);
    expect(failed.status).toBe("failed"); expect(failed.exploration?.review?.refinement?.candidate).toBe("route_1");
    expect(failed.stages.route_2?.status).toBe("failed");
    expect(failed.stages.refine?.accountedCostUsd).toBeGreaterThan(0);
    const resumed = await controller.resume(created.id);
    expect(resumed.status).toBe("completed"); expect(resumed.winner).toBe("refine");
    for (const stage of ["plan", "baseline", "route_1", "route_2", "review"] as const) expect(runner.calls.filter(call => call.stage === stage)).toHaveLength(1);
    expect(runner.calls.filter(call => call.stage === "refine")).toHaveLength(2);
    expect(runner.starts.get("refine")).toBe("Artifact for route_1\n");
    expect(resumed.stages.refine!.accountedCostUsd).toBeGreaterThan(runner.cost);
    expect(resumed.exploration?.selection?.assessments.map(assessment => assessment.candidate).sort()).toEqual(["baseline", "refine", "route_1"]);
  });

  test("a completed evaluation freezes candidates even before its parsed decision is checkpointed", async () => {
    for (const interruptedStage of ["review", "select"] as const) {
      const root = fixture(); const runner = new ExplorationRunner(); runner.selectionWinner = "route_1";
      const excluded = interruptedStage === "review" ? "route_2" : "refine";
      runner.failedStage = excluded; if (interruptedStage === "select") runner.refinement = "route_1";
      const controller = new HarnessController({ workspace: root, runner });
      const appendEvent = controller.store.appendEvent.bind(controller.store); let interrupt = true;
      controller.store.appendEvent = async event => {
        await appendEvent(event);
        if (interrupt && event.type === "stage_completed" && event.stage === interruptedStage) {
          interrupt = false; throw new Error("Simulated loss before evaluation decision checkpoint");
        }
      };
      const created = await controller.create("Preserve the reviewed comparison across recovery.", { model: "test/model", strategy: "explore" });
      const failed = await controller.execute(created.id);
      expect(failed.status).toBe("failed"); expect(failed.stages[interruptedStage]?.status).toBe("completed");
      expect(failed.stages[excluded]?.status).toBe("failed");
      runner.failedStage = undefined;
      const resumed = await controller.resume(created.id);
      expect(resumed.status).toBe("completed"); expect(resumed.winner).toBe("route_1");
      expect(runner.calls.filter(call => call.stage === excluded)).toHaveLength(1);
      expect(runner.calls.filter(call => call.stage === interruptedStage)).toHaveLength(1);
      expect(resumed.exploration?.selection?.method).toBe("model_review");
      expect(resumed.exploration?.selection?.assessments.some(assessment => assessment.candidate === excluded)).toBe(false);
    }
  });

  test("no artifact can be applied when every reviewed candidate violates a requirement", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); runner.rejectAll = true;
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Every acceptable draft must satisfy the required condition.", { model: "test/model", strategy: "explore" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("failed"); expect(record.winner).toBeUndefined(); expect(record.exploration?.review?.winner).toBeNull();
    expect(record.exploration?.review?.method).toBe("model_review");
    expect(record.exploration?.review?.assessments.every(assessment => assessment.criteria.find(criterion => criterion.criterionId === "deliverable")?.verdict === "not_met")).toBe(true);
    expect(runner.calls.some(call => call.stage === "refine" || call.stage === "reflect")).toBe(false);
    await expect(controller.apply(record.id)).rejects.toThrow("completed");
    expect(readFileSync(path.join(root, "draft.md"), "utf8")).toBe("initial artifact\n");
  });

  test("cancellation during refinement stops final selection and leaves the source untouched", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); runner.refinement = "route_1";
    const controller = new HarnessController({ workspace: root, runner });
    runner.beforeRun = async request => {
      if (request.stage !== "refine") return;
      await controller.cancel(request.runId);
      if (!request.signal!.aborted) await new Promise<void>(resolve => request.signal!.addEventListener("abort", () => resolve(), { once: true }));
    };
    const created = await controller.create("Explore and refine the drafts.", { model: "test/model", strategy: "explore" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("cancelled"); expect(record.stages.refine?.result?.status).toBe("cancelled");
    expect(runner.calls.some(call => call.stage === "select" || call.stage === "reflect")).toBe(false);
    await expect(controller.apply(record.id)).rejects.toThrow("completed");
    expect(readFileSync(path.join(root, "draft.md"), "utf8")).toBe("initial artifact\n");
  });

  test("parent artifact tampering during review prevents refinement dispatch", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); runner.refinement = "route_1";
    runner.beforeRun = request => {
      if (request.stage === "review") put(runner.calls.find(call => call.stage === "route_1")!.cwd, "draft.md", "changed after admission");
    };
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Explore and refine the selected draft.", { model: "test/model", strategy: "explore" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("failed"); expect(record.error).toContain("artifact changed after execution");
    expect(runner.calls.some(call => call.stage === "refine")).toBe(false);
    await expect(controller.apply(record.id)).rejects.toThrow("completed");
    expect(readFileSync(path.join(root, "draft.md"), "utf8")).toBe("initial artifact\n");
  });

  test("malformed auto plans fall back to direct but explicit exploration fails visibly", async () => {
    for (const strategy of ["auto", "explore"] as const) {
      const root = fixture(); const runner = new ExplorationRunner(); runner.planResponse = "not JSON";
      const controller = new HarnessController({ workspace: root, runner });
      const created = await controller.create("Draft an introduction.", { model: "test/model", strategy });
      const record = await controller.execute(created.id);
      if (strategy === "auto") {
        expect(record.status).toBe("completed"); expect(record.exploration?.plan.decision).toBe("direct"); expect(record.winner).toBe("baseline");
        expect(runner.calls.some(call => call.stage === "select")).toBe(true);
      } else { expect(record.status).toBe("failed"); expect(runner.calls.every(call => call.stage === "plan")).toBe(true); }
      expect(runner.calls.some(call => call.stage === "route_1")).toBe(false);
      expect(readFileSync(path.join(root, "draft.md"), "utf8")).toBe("initial artifact\n");
    }
  });

  test("invalid evaluations preserve unknown verdicts instead of inventing evidence", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); runner.invalidSelection = true;
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Compare alternative drafts.", { model: "test/model", strategy: "explore" });
    const record = await controller.execute(created.id);
    expect(record.status).toBe("completed"); expect(record.winner).toBe("baseline");
    expect(record.exploration?.selection?.method).toBe("fallback");
    expect(record.exploration?.selection?.assessments).toHaveLength(3);
    expect(record.exploration?.selection?.assessments.every(assessment => assessment.criteria.every(criterion => criterion.verdict === "unknown"))).toBe(true);
    expect(runner.calls.some(call => call.stage === "refine")).toBe(false);
  });

  test("tampering with a selected route blocks diff and apply", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Explore alternative drafts.", { model: "test/model" }); const record = await controller.execute(created.id);
    expect(record.winner).toBe("route_1"); put(record.stages.route_1!.cwd, "draft.md", "post-selection tampering");
    await expect(controller.diff(record.id)).rejects.toThrow("changed after execution");
    await expect(controller.apply(record.id)).rejects.toThrow("changed after execution");
    expect(readFileSync(path.join(root, "draft.md"), "utf8")).toBe("initial artifact\n");
  });

  test("budget exhaustion stops adaptive scheduling and cancelled work dispatches nothing", async () => {
    const root = fixture(); const runner = new ExplorationRunner(); runner.cost = 1;
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("Explore alternative drafts.", { model: "test/model", maxCostUsd: 0.02 });
    const failed = await controller.execute(created.id);
    expect(failed.status).toBe("failed"); expect(runner.calls).toHaveLength(1);
    expect(readFileSync(path.join(root, "draft.md"), "utf8")).toBe("initial artifact\n");
    runner.cost = 0.01; runner.calls = [];
    const queued = await controller.create("Draft once resumed.", { model: "test/model", strategy: "direct" }); await controller.cancel(queued.id);
    expect((await controller.execute(queued.id)).status).toBe("cancelled"); expect(runner.calls).toHaveLength(0);
    expect((await controller.resume(queued.id)).status).toBe("completed");
    expect(runner.calls.map(call => call.stage)).toEqual(["baseline", "select"]);
  });
});
