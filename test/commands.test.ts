import { describe, expect, test } from "bun:test";
import { formatShow, formatStatus, parseCommand, parseCommandText, safeDisplay, tokenizeCommand } from "../src/commands.ts";
import { renderDiff } from "../src/diff.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord } from "../src/types.ts";
import harnessExtension, { runArguments } from "../src/extension.ts";
import { runConfig } from "../src/cli.ts";

describe("command parsing", () => {
  test("accepts natural task text and typed options", () => {
    expect(parseCommandText('run 修复缓存 并添加测试 --budget 4.5 --model provider/model --domain "TypeScript concurrency"')).toEqual({
      kind: "run", task: "修复缓存 并添加测试", options: { budget: 4.5, model: "provider/model", domain: "TypeScript concurrency" },
    });
  });

  test("strategy remains optional and research only accepts the legacy override", () => {
    expect(parseCommandText("run 写一份简洁的项目说明")).toEqual({ kind: "run", task: "写一份简洁的项目说明", options: {} });
    for (const strategy of ["auto", "direct", "explore", "legacy"] as const) {
      expect(parseCommandText(`run compare approaches --strategy=${strategy}`)).toEqual({ kind: "run", task: "compare approaches", options: { strategy } });
    }
    expect(() => parseCommandText("run task --strategy parallel")).toThrow("--strategy must be");
    expect(() => parseCommandText("run task --strategy direct --strategy explore")).toThrow("Duplicate");
    expect(parseCommandText("run task --mode research")).toEqual({ kind: "run", task: "task", options: { mode: "research" } });
    expect(parseCommandText("run task --strategy legacy --mode research").kind).toBe("run");
    for (const strategy of ["auto", "direct", "explore"]) expect(() => parseCommandText(`run task --strategy ${strategy} --mode research`)).toThrow("Research mode requires");
    expect(parseCommandText("run -- --strategy explore")).toEqual({ kind: "run", task: "--strategy explore", options: {} });
  });

  test("OMP forwards strategy and literal task text through CLI configuration", () => {
    const command = parseCommand(["run", "--strategy", "explore", "--budget", "2.5", "--", "Compare drafts; keep --strategy literal"]);
    if (command.kind !== "run") throw new Error("Expected run command");
    const args = runArguments(command, { model: { provider: "test", id: "model" } });
    expect(args[0]).toBe("start");
    const forwarded = parseCommand(["run", ...args.slice(1)]);
    if (forwarded.kind !== "run") throw new Error("Expected forwarded run command");
    expect(forwarded.task).toBe(command.task);
    expect(runConfig(forwarded.options)).toMatchObject({ model: "test/model", strategy: "explore", maxCostUsd: 2.5 });
    expect(runConfig({ model: "test/model" })).not.toHaveProperty("strategy");
  });

  test("preserves shell syntax as inert task text", () => {
    expect(parseCommandText('run -- "$(cat ~/.secret)" `whoami` $TOKEN')).toEqual({
      kind: "run", task: "$(cat ~/.secret) `whoami` $TOKEN", options: {},
    });
    expect(parseCommand(["run", "--budget=2", "--", "test", "--budget", "1000"]).kind).toBe("run");
    expect(parseCommand(["run", "--", "test", "--budget", "1000"])).toEqual({ kind: "run", task: "test --budget 1000", options: {} });
  });

  test("rejects invalid or surprising budget inputs", () => {
    for (const budget of ["0", "-1", "NaN", "Infinity", "1e5", "1001", "", "0x20"]) {
      expect(() => parseCommand(["run", "fix", "--budget", budget])).toThrow();
    }
    expect(() => parseCommandText("run fix --budget 2 --budget 3")).toThrow("Duplicate");
    expect(() => parseCommandText("run fix --budgte 2")).toThrow("Unknown");
    expect(() => parseCommandText("run fix --mode auto")).toThrow("product or research");
  });

  test("rejects unsafe ids and unexpected mutation arguments", () => {
    for (const id of ["../run", "/tmp/run", "a/b", "a\\b", ".", "a\0b"]) {
      expect(() => parseCommand(["apply", id])).toThrow();
    }
    expect(() => parseCommand(["apply", "run-1", "--force"])).toThrow();
    expect(parseCommand(["apply", "20261028_abcd-1"])).toEqual({ kind: "apply", id: "20261028_abcd-1" });
    expect(parseCommand(["status"])).toEqual({ kind: "status" });
  });

  test("quotes support spaces and escaping but fail on incomplete input", () => {
    expect(tokenizeCommand(`run 'one two' "say \\"hi\\""`)).toEqual(["run", "one two", 'say "hi"']);
    expect(() => tokenizeCommand("run 'unfinished")).toThrow("Unclosed");
    expect(() => tokenizeCommand("run trailing\\")).toThrow("Trailing");
    expect(() => parseCommandText('run ""')).toThrow("requires a task");
  });

  test("terminal controls are removed from output", () => {
    expect(safeDisplay("\x1b[31merror\x1b[0m\x07\nnext")).toBe("error\nnext");
  });
});

function diffFixture(callback: (record: RunRecord, before: string, after: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "harness2-preview-"));
  const before = join(directory, "before");
  const after = join(directory, "after");
  mkdirSync(before); mkdirSync(after);
  const now = new Date().toISOString();
  const record: RunRecord = {
    schemaVersion: 1, id: "preview-test", revision: 1, createdAt: now, updatedAt: now, workspace: directory,
    task: "test", status: "completed", winner: "final", libraryEntries: [],
    config: { mode: "product", model: "provider/model", improverModel: "provider/model", maxCostUsd: 1, maxDurationMs: 1000, stageTimeoutMs: 1000, domain: "test", ompCommand: "omp" },
    snapshot: { id: "snapshot", sourceRoot: directory, root: before, files: [], createdAt: now },
    baseHarness: { schemaVersion: 1, id: "base", promptAppend: "", toolGuidance: "", skills: [], rationale: "" },
    stages: { final: { id: "final", status: "completed", attempt: 1, cwd: after, startedAt: now } },
  };
  try { callback(record, before, after); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("task progress and inspection", () => {
  test("shows routing, named results, unknown evidence and review limitations", () => diffFixture((record) => {
    record.config.strategy = "auto";
    record.winner = "route_2";
    record.selectionReason = "The concise draft satisfies the requested structure.";
    record.exploration = {
      plan: {
        decision: "explore", reason: "Two writing approaches have different tradeoffs.",
        criteria: [{ id: "clarity", description: "Make the decision easy to understand", kind: "quality" }],
        routes: [
          { id: "route_1", name: "Detailed explanation", approach: "Explain each step", assumptions: ["Readers need background"], tradeoffs: ["Longer text"] },
          { id: "route_2", name: "Concise draft", approach: "Lead with the decision", assumptions: [], tradeoffs: ["Less background"] },
        ],
      },
      selection: {
        method: "model_review", winner: "route_2", reason: record.selectionReason,
        limitations: ["Reader comprehension has not been measured."],
        assessments: [{ candidate: "route_2", criteria: [{ criterionId: "clarity", verdict: "unknown", evidence: "No reader study is available." }], strengths: ["Clear opening"], weaknesses: ["Limited background"] }],
      },
    };
    const status = formatStatus(record);
    expect(status).toContain("Strategy: auto");
    expect(status).toContain("Two writing approaches have different tradeoffs.");
    expect(status).toContain("Routes: Detailed explanation; Concise draft");
    expect(status).toContain("Selected result: Concise draft");
    expect(status).toContain("Evaluation: model review");
    expect(status).toContain("no executed tests or performance measurements");
    expect(status).toContain("Unknown: 1 criterion assessments remain unverified.");
    expect(status).toContain("Reader comprehension has not been measured.");
    expect(status).toContain(record.selectionReason);
    const show = formatShow(record);
    expect(show).toContain("clarity [quality]: Make the decision easy to understand");
    expect(show).toContain("Approach: Lead with the decision");
    expect(show).toContain("Assumptions: Readers need background");
    expect(show).toContain("Tradeoffs: Less background");
    expect(show).toContain("clarity: unknown — No reader study is available.");
  }));

  test("distinguishes explicit fallback and preserves inspection of legacy records", () => diffFixture((record) => {
    expect(formatStatus(record)).toContain("Strategy: legacy");
    record.exploration = {
      plan: { decision: "direct", reason: "The edit has one clear implementation.", criteria: [], routes: [] },
      selection: { method: "fallback", assessments: [], winner: "baseline", reason: "Model comparison was unavailable; retained the completed baseline.", limitations: ["Quality was not established by evaluation."] },
    };
    record.winner = "baseline";
    const status = formatStatus(record);
    expect(status).toContain("Approach: direct");
    expect(status).toContain("Evaluation: fallback (no validated model comparison)");
    expect(status).toContain("retained the completed baseline");
    expect(status).toContain("Quality was not established by evaluation.");
    expect(status).not.toContain("Routes:");
  }));
});

describe("review diff", () => {
  test("shows actual additions and deletions without leaking temporary paths", () => diffFixture((record, before, after) => {
    writeFileSync(join(before, "change.ts"), "old line\n");
    writeFileSync(join(after, "change.ts"), "new line\n");
    writeFileSync(join(before, "removed.ts"), "remove me\n");
    writeFileSync(join(after, "added.ts"), "add me\n");
    const preview = renderDiff(record, [
      { path: "change.ts", kind: "modify" }, { path: "removed.ts", kind: "delete" }, { path: "added.ts", kind: "add" },
    ]);
    expect(preview).toContain("-old line");
    expect(preview).toContain("+new line");
    expect(preview).toContain("-remove me");
    expect(preview).toContain("+add me");
    expect(preview).not.toContain(before);
    expect(preview).not.toContain(after);
  }));

  test("bounds output and marks truncation", () => diffFixture((record, before, after) => {
    writeFileSync(join(before, "large.txt"), "old\n".repeat(500));
    writeFileSync(join(after, "large.txt"), "new\n".repeat(500));
    const preview = renderDiff(record, [{ path: "large.txt", kind: "modify" }], 200);
    expect(preview).toContain("Preview truncated");
    expect(preview.length).toBeLessThan(400);
  }));

  test("preserves header-looking source lines inside diff hunks", () => diffFixture((record, before, after) => {
    writeFileSync(join(before, "counter.ts"), "-- count;\n-- old header\n");
    writeFileSync(join(after, "counter.ts"), "++ count;\n++ new header\n");
    const preview = renderDiff(record, [{ path: "counter.ts", kind: "modify" }]);
    expect(preview).toContain('diff --git "a/counter.ts" "b/counter.ts"');
    expect(preview).toContain('--- "a/counter.ts"\n+++ "b/counter.ts"\n');
    expect(preview).toContain("@@ -1,2 +1,2 @@\n--- count;\n--- old header\n+++ count;\n+++ new header");
    expect(preview).not.toContain(before);
    expect(preview).not.toContain(after);
  }));

  test("refuses path traversal and symlinks", () => diffFixture((record, before, after) => {
    writeFileSync(join(before, "source.txt"), "source\n");
    symlinkSync(join(before, "source.txt"), join(after, "source.txt"));
    expect(() => renderDiff(record, [{ path: "source.txt", kind: "modify" }])).toThrow("symbolic links");
    expect(() => renderDiff(record, [{ path: "../outside", kind: "add" }])).toThrow("Unsafe path");
  }));
});

test("extension registers a local command, renders help without a turn, and rejects nested control", async () => {
  type Host = Parameters<typeof harnessExtension>[0];
  type Handler = Parameters<Host["registerCommand"]>[1]["handler"];
  type Context = Parameters<Handler>[1];
  let handler: Handler | undefined;
  const messages: Array<{ content: string; triggerTurn?: boolean }> = [];
  const notifications: string[] = [];
  harnessExtension({
    registerCommand(name, command) { expect(name).toBe("harness"); handler = command.handler; },
    appendEntry() {},
    sendMessage(message, options) { messages.push({ content: message.content, triggerTurn: options?.triggerTurn }); },
  });
  const context: Context = {
    cwd: "/unused", agent: { kind: "main" },
    ui: { notify(message) { notifications.push(message); } },
    setInterval() { throw new Error("Help must not schedule background work."); }, clearTimer() {},
  };
  expect(handler).toBeDefined();
  await handler!("help", context);
  expect(messages[0]?.content).toContain("/harness apply");
  expect(messages[0]?.triggerTurn).toBe(false);
  await handler!("run fix the code", { ...context, agent: { kind: "sub" } });
  expect(notifications.at(-1)).toContain("main OMP session");
  await handler!("apply ../outside", context);
  expect(notifications.at(-1)).toContain("valid run id");
});
