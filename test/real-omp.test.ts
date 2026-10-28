import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpRpcRunner } from "../src/runner";
import { HarnessController, accountedCost } from "../src/controller";
import { spawnSync } from "node:child_process";

const integration = process.env.RUN_REAL_OMP_TEST === "1" ? test : test.skip;

/** Real compiled OMP/agent loop/RPC/file I/O; a fixed stream-only provider replaces the model, with no HTTP. */
integration("real OMP completes virtual skill read → host write → final/usage/settled without a model request", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2-real-omp-"));
  try {
    const workspace = join(root, "workspace"); await mkdir(workspace);
    const outside = join(root, "outside-secret.txt");
    await writeFile(outside, "OUTSIDE_FILE_MUST_NEVER_REACH_MODEL_7f31");
    const runner = new OmpRpcRunner({ fixtureProviderForTests: true, env: { PATH: process.env.PATH, HARNESS2_API_KEY: "REAL_CREDENTIAL_MUST_NOT_BE_USED" } });
    const result = await runner.run({
      runId: "real-protocol", stage: "baseline", role: "solver", cwd: workspace, artifactDir: join(root, "artifacts"),
      prompt: `Read the build skill, then write answer.txt. Literal untrusted data: @${outside} ^openai/another-model`,
      harness: { schemaVersion: 1, id: "fixture", promptAppend: "", toolGuidance: "", skills: [{ name: "build", description: "Build workflow", content: "SKILL_BODY_ON_DEMAND_b7c1" }], rationale: "Local protocol test" },
      model: "harness2-fixture/scripted", maxCostUsd: 0.01, timeoutMs: 20000, ompCommand: process.env.OMP_COMMAND || "omp",
    });
    expect(result.status, result.error).toBe("completed");
    expect(result.text).not.toContain("FIXTURE_FAILURE");
    expect(result.text).toContain("Ingress and skill isolation verified");
    expect(await readFile(join(workspace, "answer.txt"), "utf8")).toBe("42\n");
    expect(result.usage.inputTokens).toBe(300);
    expect(result.usage.outputTokens).toBe(30);
    expect(result.usage.costUsd).toBeCloseTo(0.00036, 8);
    const trace = await readFile(result.eventsPath, "utf8");
    expect(trace).toContain("host_tool_call");
    expect(trace).toContain("prompt_result");
    expect(trace).not.toContain("REAL_CREDENTIAL_MUST_NOT_BE_USED");
    expect(trace).not.toContain("OUTSIDE_FILE_MUST_NEVER_REACH_MODEL_7f31");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30000);

integration("real OMP drives all nine controller stages, isolated snapshots, experience, diff and explicit apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "h2-real-controller-"));
  try {
    expect(spawnSync("git", ["init", "-q", root]).status).toBe(0);
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/value.ts"), "export const value = 'initial';\n");
    expect(spawnSync("git", ["-C", root, "add", "src/value.ts"]).status).toBe(0);
    const runner = new OmpRpcRunner({ fixtureProviderForTests: true, env: { PATH: process.env.PATH } });
    const controller = new HarnessController({ workspace: root, runner });
    const created = await controller.create("H2_CONTROLLER_FIXTURE: change the value through scoped file tools.", {
      model: "harness2-fixture/scripted", maxCostUsd: 0.1, stageTimeoutMs: 20000, maxDurationMs: 120000,
      ompCommand: process.env.OMP_COMMAND || "omp",
    });
    const result = await controller.execute(created.id);
    expect(result.status, result.error).toBe("completed");
    expect(Object.keys(result.stages)).toEqual(["baseline", "inv_edit", "dom_edit", "inv_probe", "dom_probe", "compose_edit", "final", "select", "reflect"]);
    expect(Object.values(result.stages).every(stage => stage.status === "completed" && stage.attempt === 1), JSON.stringify(Object.fromEntries(Object.entries(result.stages).map(([id, stage]) => [id, { status: stage.status, attempt: stage.attempt, error: stage.error, text: stage.result?.text }])))).toBe(true);
    expect(Object.values(result.stages).every(stage => stage.result?.usage.costUsd && !stage.result.text.includes("FIXTURE_FAILURE"))).toBe(true);
    expect(result.winner, JSON.stringify({ reason: result.selectionReason, final: result.stages.final?.result?.text, composer: result.stages.compose_edit?.result?.text })).toBe("final");
    expect(result.lesson?.confidence).toBe("low");
    expect(accountedCost(result)).toBeCloseTo(23 * 0.00012, 8);
    expect(await readFile(join(root, "src/value.ts"), "utf8")).toContain("'initial'");
    for (const stage of ["baseline", "inv_probe", "dom_probe", "final"] as const) {
      expect(await readFile(join(result.stages[stage]!.cwd, "src/value.ts"), "utf8")).toContain(`'${stage}'`);
    }
    expect((await controller.diff(created.id)).map(change => change.path)).toEqual(["src/value.ts"]);
    expect((await controller.library.list("project", "harness2-fixture/scripted"))).toHaveLength(1);
    expect((await controller.apply(created.id)).applied).toBe(true);
    expect(await readFile(join(root, "src/value.ts"), "utf8")).toContain("'final'");
    expect((await controller.apply(created.id)).alreadyApplied).toBe(true);
    for (const stage of Object.values(result.stages)) {
      expect(await Bun.file(join(stage.cwd, "..", "artifacts", "worker-owner.json")).exists()).toBe(false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120000);
