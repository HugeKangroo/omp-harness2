import { describe, expect, test } from "bun:test";
import { parseCommand, parseCommandText, safeDisplay, tokenizeCommand } from "../src/commands.ts";
import { renderDiff } from "../src/diff.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord } from "../src/types.ts";
import harnessExtension from "../src/extension.ts";

describe("command parsing", () => {
  test("accepts natural task text and typed options", () => {
    expect(parseCommandText('run 修复缓存 并添加测试 --budget 4.5 --model provider/model --domain "TypeScript concurrency"')).toEqual({
      kind: "run", task: "修复缓存 并添加测试", options: { budget: 4.5, model: "provider/model", domain: "TypeScript concurrency" },
    });
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
