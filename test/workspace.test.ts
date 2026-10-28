import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { applyWorkspace, captureSnapshot, diffWorkspace, materializeCandidate, materializeSnapshot, recoverInterruptedApplies, WORKSPACE_LIMITS } from "../src/workspace.js";
import type { WorkspaceSnapshot } from "../src/types.ts";

const temporary: string[] = [];
afterEach(() => { for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function put(root: string, file: string, value: string): void { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), value); }
function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
}
function fixture(): { root: string; source: string; snapshotRoot: string; candidate: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-harness2-workspace-")));
  temporary.push(root);
  const source = path.join(root, "source"); fs.mkdirSync(source); git(source, "init", "-q");
  put(source, "file.txt", "original"); git(source, "add", "file.txt");
  return { root, source, snapshotRoot: path.join(root, "snapshot"), candidate: path.join(root, "candidate") };
}
function pausedApply(root: string, snapshot: WorkspaceSnapshot, candidate: string) {
  const request = path.join(root, "child-request.json"), paused = path.join(root, "child-paused"), proceed = path.join(root, "child-continue");
  put(root, "child-request.json", JSON.stringify({ snapshot, candidate, pauseAfter: "file.txt", paused, proceed }));
  const child = spawn(process.execPath, [path.join(import.meta.dir, "fixtures/apply-worker.ts"), request], { stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => {
    child.on("error", reject); child.on("close", (code, signal) => resolve({ code, signal, output }));
  });
  return {
    child, exited,
    resume: () => fs.writeFileSync(proceed, "continue"),
    ready: async () => {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(paused)) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) throw new Error(`Apply child did not pause: ${output}`);
        await Bun.sleep(10);
      }
    },
  };
}

describe("workspace snapshots", () => {
  test("captures dirty and untracked bytes, excludes ignored files and explicit ambient/secret paths", () => {
    const f = fixture();
    put(f.source, "file.txt", "dirty"); put(f.source, "new.txt", "untracked");
    put(f.source, ".gitignore", "ignored.txt\nnode_modules/\n"); put(f.source, "ignored.txt", "not part of task");
    put(f.source, ".env", "do not copy"); put(f.source, ".omp/settings.json", "{}"); put(f.source, "AGENTS.md", "ambient instructions");
    put(f.source, ".harness-evidence/user-file.txt", "reserved evidence namespace");
    const snapshot = captureSnapshot(f.source, f.snapshotRoot);
    expect(snapshot.files.map(file => file.path)).toEqual([".gitignore", "file.txt", "new.txt"]);
    expect(snapshot.excludedPaths).toEqual([".env", ".harness-evidence/user-file.txt", ".omp/settings.json", "AGENTS.md"]);
    expect(fs.readFileSync(path.join(f.snapshotRoot, "file.txt"), "utf8")).toBe("dirty");
    expect(fs.existsSync(path.join(f.snapshotRoot, ".env"))).toBe(false);
  });
  test("preserves dirty deletions and executable permission changes", () => {
    const f = fixture(); put(f.source, "run.sh", "echo hello"); git(f.source, "add", "run.sh");
    fs.unlinkSync(path.join(f.source, "file.txt")); fs.chmodSync(path.join(f.source, "run.sh"), 0o755);
    const snapshot = captureSnapshot(f.source, f.snapshotRoot); materializeSnapshot(snapshot, f.candidate);
    expect(snapshot.files.map(e => e.path)).toEqual(["run.sh"]);
    fs.chmodSync(path.join(f.candidate, "run.sh"), 0o644);
    const changes = diffWorkspace(snapshot, f.candidate);
    expect(changes[0]?.kind).toBe("modify"); expect(changes[0]?.beforeHash).not.toBe(changes[0]?.afterHash);
  });
  test("rejects a non-Git root, symlink input and oversized file", () => {
    const f = fixture(); expect(() => captureSnapshot(f.root, path.join(f.root, ".harness2/snapshot"))).toThrow("Git");
    fs.symlinkSync("file.txt", path.join(f.source, "linked"));
    expect(() => captureSnapshot(f.source, f.snapshotRoot)).toThrow("Symlink"); fs.unlinkSync(path.join(f.source, "linked"));
    const fd = fs.openSync(path.join(f.source, "large.bin"), "w"); fs.ftruncateSync(fd, WORKSPACE_LIMITS.fileBytes + 1); fs.closeSync(fd);
    expect(() => captureSnapshot(f.source, f.snapshotRoot)).toThrow("size limit");
  });
  test("materializes a fixed start and resets only an owned candidate directory", () => {
    const f = fixture(); const snapshot = captureSnapshot(f.source, f.snapshotRoot);
    materializeSnapshot(snapshot, f.candidate); put(f.candidate, "file.txt", "changed"); put(f.candidate, "extra.txt", "extra");
    materializeSnapshot(snapshot, f.candidate);
    expect(fs.readFileSync(path.join(f.candidate, "file.txt"), "utf8")).toBe("original");
    expect(fs.existsSync(path.join(f.candidate, "extra.txt"))).toBe(false);
    const unowned = path.join(f.root, "unowned"); put(unowned, "keep", "user file");
    expect(() => materializeSnapshot(snapshot, unowned)).toThrow();
    expect(fs.readFileSync(path.join(unowned, "keep"), "utf8")).toBe("user file");
  });
  test("rejects tampered snapshots and path escapes", () => {
    const f = fixture(); const snapshot = captureSnapshot(f.source, f.snapshotRoot);
    put(f.snapshotRoot, "file.txt", "tampered"); expect(() => materializeSnapshot(snapshot, f.candidate)).toThrow("integrity");
    snapshot.files[0]!.path = "../source/file.txt"; expect(() => materializeSnapshot(snapshot, f.candidate)).toThrow("Unsafe");
  });
  test("rejects input drift during capture rather than retaining a mixed snapshot", () => {
    const f = fixture(); const original = fs.writeFileSync;
    const mocked = spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      original(file, data, options);
      if (String(file) === path.join(f.snapshotRoot, "file.txt")) original(path.join(f.source, "file.txt"), "concurrent edit");
    }) as typeof fs.writeFileSync);
    try { expect(() => captureSnapshot(f.source, f.snapshotRoot)).toThrow("changed during snapshot"); }
    finally { mocked.mockRestore(); }
    expect(fs.existsSync(f.snapshotRoot)).toBe(false);
  });
});

describe("candidate continuation", () => {
  test("inherits parent changes independently and keeps diff/apply relative to the original snapshot", () => {
    const f = fixture(); put(f.source, "delete.txt", "remove me"); put(f.source, "run.sh", "echo original\n"); fs.chmodSync(path.join(f.source, "run.sh"), 0o644);
    const snapshot = captureSnapshot(f.source, f.snapshotRoot); const originalSnapshot = structuredClone(snapshot); materializeSnapshot(snapshot, f.candidate);
    put(f.candidate, "file.txt", "parent edit"); put(f.candidate, "nested/added.txt", "parent addition");
    fs.unlinkSync(path.join(f.candidate, "delete.txt")); fs.chmodSync(path.join(f.candidate, "run.sh"), 0o755);
    const parentChanges = diffWorkspace(snapshot, f.candidate);
    const child = path.join(f.root, "child"); materializeCandidate(snapshot, f.candidate, child);
    expect(snapshot).toEqual(originalSnapshot);
    expect(diffWorkspace(snapshot, child)).toEqual(parentChanges);
    expect(fs.readFileSync(path.join(child, "file.txt"), "utf8")).toBe("parent edit");
    expect(fs.readFileSync(path.join(child, "nested/added.txt"), "utf8")).toBe("parent addition");
    expect(fs.existsSync(path.join(child, "delete.txt"))).toBe(false);
    expect(fs.statSync(path.join(child, "run.sh")).mode & 0o777).toBe(0o755);
    expect(JSON.parse(fs.readFileSync(path.join(child, ".harness2-origin.json"), "utf8"))).toEqual({ snapshotId: snapshot.id, destination: child });
    put(child, "file.txt", "child edit"); put(child, "nested/added.txt", "child addition edit");
    expect(diffWorkspace(snapshot, f.candidate)).toEqual(parentChanges);
    expect(fs.readFileSync(path.join(f.candidate, "file.txt"), "utf8")).toBe("parent edit");
    expect(fs.readFileSync(path.join(f.candidate, "nested/added.txt"), "utf8")).toBe("parent addition");
    expect(fs.readFileSync(path.join(f.source, "file.txt"), "utf8")).toBe("original");
    expect(diffWorkspace(snapshot, child).map(change => [change.path, change.kind])).toEqual([["delete.txt", "delete"], ["file.txt", "modify"], ["nested/added.txt", "add"], ["run.sh", "modify"]]);
    expect(applyWorkspace(snapshot, child).applied).toBe(true);
    expect(fs.readFileSync(path.join(f.source, "file.txt"), "utf8")).toBe("child edit");
    expect(fs.readFileSync(path.join(f.source, "nested/added.txt"), "utf8")).toBe("child addition edit");
    expect(fs.existsSync(path.join(f.source, "delete.txt"))).toBe(false);
    expect(fs.statSync(path.join(f.source, "run.sh")).mode & 0o777).toBe(0o755);
  });
  test("refuses overlaps, source-tree destinations and existing child contents", () => {
    const f = fixture(); const snapshot = captureSnapshot(f.source, f.snapshotRoot); materializeSnapshot(snapshot, f.candidate);
    for (const destination of [f.candidate, path.join(f.candidate, "child"), f.root, f.snapshotRoot, path.join(f.snapshotRoot, "child"), f.source, path.join(f.source, "child")]) {
      expect(() => materializeCandidate(snapshot, f.candidate, destination)).toThrow();
    }
    const child = path.join(f.root, "child"); materializeCandidate(snapshot, f.candidate, child); put(child, "keep.txt", "existing child edit");
    expect(() => materializeCandidate(snapshot, f.candidate, child)).toThrow("new or empty");
    expect(fs.readFileSync(path.join(child, "keep.txt"), "utf8")).toBe("existing child edit");
    expect(fs.readFileSync(path.join(f.candidate, "file.txt"), "utf8")).toBe("original");
    expect(fs.readFileSync(path.join(f.source, "file.txt"), "utf8")).toBe("original");
  });
  test("rejects protected candidate files, wrong ownership and symlink paths", () => {
    const f = fixture(); const snapshot = captureSnapshot(f.source, f.snapshotRoot); materializeSnapshot(snapshot, f.candidate);
    const child = path.join(f.root, "child");
    for (const file of [".env", "AGENTS.md", ".git/config", ".harness-evidence/forged.json"]) {
      put(f.candidate, file, "protected");
      expect(() => materializeCandidate(snapshot, f.candidate, child)).toThrow("protected");
      fs.rmSync(path.join(f.candidate, file.split("/")[0]!), { recursive: true });
    }
    fs.symlinkSync("file.txt", path.join(f.candidate, "link.txt"));
    expect(() => materializeCandidate(snapshot, f.candidate, child)).toThrow("symlink"); fs.unlinkSync(path.join(f.candidate, "link.txt"));
    fs.symlinkSync(f.candidate, path.join(f.root, "parent-link"));
    expect(() => materializeCandidate(snapshot, path.join(f.root, "parent-link"), child)).toThrow("real directory");
    fs.symlinkSync(f.candidate, child); expect(() => materializeCandidate(snapshot, f.candidate, child)).toThrow("Symlink"); fs.unlinkSync(child);
    put(f.candidate, ".harness2-origin.json", JSON.stringify({ snapshotId: "different", destination: f.candidate }));
    expect(() => materializeCandidate(snapshot, f.candidate, child)).toThrow("does not belong");
    expect(fs.existsSync(child)).toBe(false);
    expect(fs.readFileSync(path.join(f.candidate, "file.txt"), "utf8")).toBe("original");
  });
});

describe("workspace apply", () => {
  test("concurrent processes cannot apply or recover another run's active transaction", async () => {
    const f = fixture(); put(f.source, "b.txt", "old b"); put(f.source, "z.txt", "old z");
    const snapshot = captureSnapshot(f.source, f.snapshotRoot); materializeSnapshot(snapshot, f.candidate);
    const otherCandidate = path.join(f.root, "other-candidate"); materializeSnapshot(snapshot, otherCandidate);
    put(f.candidate, "file.txt", "new first"); put(f.candidate, "z.txt", "new last"); put(otherCandidate, "b.txt", "other edit");
    const worker = pausedApply(f.root, snapshot, f.candidate);
    try {
      await worker.ready();
      expect(fs.readFileSync(path.join(f.source, "file.txt"), "utf8")).toBe("new first");
      expect(() => applyWorkspace(snapshot, otherCandidate)).toThrow("locked");
      expect(() => applyWorkspace(snapshot, otherCandidate, { dryRun: true })).toThrow("locked");
      expect(() => recoverInterruptedApplies(f.source)).toThrow("locked");
      expect(fs.readFileSync(path.join(f.source, "file.txt"), "utf8")).toBe("new first");
      expect(fs.readFileSync(path.join(f.source, "b.txt"), "utf8")).toBe("old b");
      expect(fs.readFileSync(path.join(f.source, "z.txt"), "utf8")).toBe("old z");
      const lock = path.join(f.source, ".harness2/.apply.lock");
      expect(fs.statSync(lock).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(lock, "owner.json")).mode & 0o777).toBe(0o600);
    } finally { worker.resume(); await worker.exited; }
    const result = await worker.exited;
    expect(result.code).toBe(0); expect(JSON.parse(result.output).applied).toBe(true);
    expect(fs.readFileSync(path.join(f.source, "file.txt"), "utf8")).toBe("new first");
    expect(fs.readFileSync(path.join(f.source, "z.txt"), "utf8")).toBe("new last");
    expect(fs.existsSync(path.join(f.source, ".harness2/.apply.lock"))).toBe(false);
    expect(recoverInterruptedApplies(f.source)).toEqual([]);
    expect(() => applyWorkspace(snapshot, otherCandidate)).toThrow("drift");
  }, 20_000);
  test("a dead apply owner is reclaimed before recovering its interrupted transaction", async () => {
    const f = fixture(); put(f.source, "z.txt", "old z");
    const snapshot = captureSnapshot(f.source, f.snapshotRoot); materializeSnapshot(snapshot, f.candidate);
    put(f.candidate, "file.txt", "new first"); put(f.candidate, "z.txt", "new last");
    const worker = pausedApply(f.root, snapshot, f.candidate);
    try { await worker.ready(); }
    finally { worker.child.kill("SIGKILL"); await worker.exited; }
    expect((await worker.exited).signal).toBe("SIGKILL");
    expect(fs.existsSync(path.join(f.source, ".harness2/.apply.lock"))).toBe(true);
    expect(recoverInterruptedApplies(f.source)).toHaveLength(1);
    expect(fs.readFileSync(path.join(f.source, "file.txt"), "utf8")).toBe("original");
    expect(fs.readFileSync(path.join(f.source, "z.txt"), "utf8")).toBe("old z");
    expect(fs.existsSync(path.join(f.source, ".harness2/.apply.lock"))).toBe(false);
    expect(applyWorkspace(snapshot, f.candidate).applied).toBe(true);
  }, 20_000);
  test("missing and malformed lock owners are preserved for inspection", () => {
    const f = fixture(); const snapshot = captureSnapshot(f.source, f.snapshotRoot); materializeSnapshot(snapshot, f.candidate); put(f.candidate, "file.txt", "new");
    const lock = path.join(f.source, ".harness2/.apply.lock"); fs.mkdirSync(lock, { recursive: true });
    expect(() => recoverInterruptedApplies(f.source)).toThrow("owner is missing");
    for (const contents of ["broken", JSON.stringify({ pid: process.pid, token: "owner", createdAt: "2026-01-01T00:00:00Z", sourceRoot: "/another-workspace" })]) {
      put(lock, "owner.json", contents);
      expect(() => applyWorkspace(snapshot, f.candidate)).toThrow("Invalid workspace apply lock owner");
      expect(() => recoverInterruptedApplies(f.source)).toThrow("Invalid workspace apply lock owner");
      expect(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).toBe(contents);
    }
    expect(fs.readFileSync(path.join(f.source, "file.txt"), "utf8")).toBe("original");
  });
  test("lock directories and owner records cannot follow symlinks", () => {
    const f = fixture(); const outside = path.join(f.root, "outside"); put(outside, "keep", "untouched");
    const lock = path.join(f.source, ".harness2/.apply.lock"); fs.mkdirSync(path.dirname(lock));
    fs.symlinkSync(outside, lock);
    expect(() => recoverInterruptedApplies(f.source)).toThrow("Symlink");
    fs.unlinkSync(lock); fs.mkdirSync(lock); fs.symlinkSync(path.join(outside, "keep"), path.join(lock, "owner.json"));
    expect(() => recoverInterruptedApplies(f.source)).toThrow("Symlink");
    expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("untouched");
    expect(fs.lstatSync(path.join(lock, "owner.json")).isSymbolicLink()).toBe(true);
  });
  test("previews and applies add/modify/delete, preserves unrelated files, and is idempotent", () => {
    const f = fixture(); put(f.source, "delete.txt", "delete me");
    const snapshot = captureSnapshot(f.source, f.snapshotRoot); materializeSnapshot(snapshot, f.candidate);
    put(f.candidate, "file.txt", "new value"); put(f.candidate, "nested/new.txt", "added"); fs.unlinkSync(path.join(f.candidate, "delete.txt"));
    put(f.source, "unrelated.txt", "keep me");
    const preview = applyWorkspace(snapshot, f.candidate, { dryRun: true });
    expect(preview.changes.map(c => [c.path, c.kind])).toEqual([["delete.txt", "delete"], ["file.txt", "modify"], ["nested/new.txt", "add"]]);
    expect(preview.applied).toBe(false); expect(fs.readFileSync(path.join(f.source, "file.txt"), "utf8")).toBe("original");
    expect(applyWorkspace(snapshot, f.candidate).applied).toBe(true);
    expect(fs.readFileSync(path.join(f.source, "file.txt"), "utf8")).toBe("new value");
    expect(fs.readFileSync(path.join(f.source, "unrelated.txt"), "utf8")).toBe("keep me");
    expect(fs.existsSync(path.join(f.source, "delete.txt"))).toBe(false);
    expect(applyWorkspace(snapshot, f.candidate)).toMatchObject({ applied: false, alreadyApplied: true });
  });
  test("rejects drift even in unchanged snapshot files before writing anything", () => {
    const f = fixture(); put(f.source, "other.txt", "before");
    const snapshot = captureSnapshot(f.source, f.snapshotRoot); materializeSnapshot(snapshot, f.candidate);
    put(f.candidate, "file.txt", "candidate"); put(f.source, "other.txt", "user edit");
    expect(() => applyWorkspace(snapshot, f.candidate)).toThrow("drift");
    expect(fs.readFileSync(path.join(f.source, "file.txt"), "utf8")).toBe("original");
  });
  test("rejects conflicting new files and symlink parents in the target", () => {
    const f = fixture(); const snapshot = captureSnapshot(f.source, f.snapshotRoot); materializeSnapshot(snapshot, f.candidate);
    put(f.candidate, "new.txt", "candidate"); put(f.source, "new.txt", "user edit");
    expect(() => applyWorkspace(snapshot, f.candidate)).toThrow("drift");
    fs.unlinkSync(path.join(f.source, "new.txt")); fs.unlinkSync(path.join(f.candidate, "new.txt"));
    put(f.candidate, "nested/new.txt", "candidate"); const outside = path.join(f.root, "outside"); fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(f.source, "nested"));
    expect(() => applyWorkspace(snapshot, f.candidate)).toThrow("Symlink"); expect(fs.readdirSync(outside)).toEqual([]);
  });
  test("rejects candidate secrets, metadata, ambient instructions and symlinks", () => {
    for (const forbidden of [".env", ".git/config", ".GIT/config", ".omp/settings.json", ".harness-evidence/forged.json", "AGENTS.md", "secret.json"]) {
      const f = fixture(); const snapshot = captureSnapshot(f.source, f.snapshotRoot); materializeSnapshot(snapshot, f.candidate); put(f.candidate, forbidden, "bad");
      expect(() => diffWorkspace(snapshot, f.candidate)).toThrow("protected");
    }
    const f = fixture(); const snapshot = captureSnapshot(f.source, f.snapshotRoot); materializeSnapshot(snapshot, f.candidate);
    fs.symlinkSync("file.txt", path.join(f.candidate, "symlink")); expect(() => diffWorkspace(snapshot, f.candidate)).toThrow("symlink");
  });
  test("rolls back completed file writes when a later candidate changes during apply", () => {
    const f = fixture(); put(f.source, "z.txt", "old z");
    const snapshot = captureSnapshot(f.source, f.snapshotRoot); materializeSnapshot(snapshot, f.candidate);
    put(f.candidate, "file.txt", "new"); put(f.candidate, "z.txt", "new z");
    const original = fs.renameSync;
    const mocked = spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      original(oldPath, newPath);
      if (String(newPath) === path.join(f.source, "file.txt")) put(f.candidate, "z.txt", "changed after preview");
    });
    try { expect(() => applyWorkspace(snapshot, f.candidate)).toThrow("prior file contents restored"); }
    finally { mocked.mockRestore(); }
    expect(fs.readFileSync(path.join(f.source, "file.txt"), "utf8")).toBe("original");
    expect(fs.readFileSync(path.join(f.source, "z.txt"), "utf8")).toBe("old z");
  });
  test("recovers an interrupted multi-file apply from backups", () => {
    const f = fixture(); const snapshot = captureSnapshot(f.source, f.snapshotRoot); materializeSnapshot(snapshot, f.candidate);
    put(f.candidate, "file.txt", "new"); put(f.candidate, "new.txt", "new file");
    const changes = diffWorkspace(snapshot, f.candidate);
    const directory = path.join(f.source, ".harness2/apply-transactions/interrupted");
    put(directory, "backup/0", "original");
    put(directory, "journal.json", JSON.stringify({ sourceRoot: f.source, state: "applying", changes, before: [snapshot.files[0], null] }));
    put(f.source, "file.txt", "new"); put(f.source, "new.txt", "new file");
    expect(recoverInterruptedApplies(f.source)).toEqual(["interrupted"]);
    expect(fs.readFileSync(path.join(f.source, "file.txt"), "utf8")).toBe("original"); expect(fs.existsSync(path.join(f.source, "new.txt"))).toBe(false);
    expect(recoverInterruptedApplies(f.source)).toEqual([]);
  });
  test("recovery refuses to overwrite subsequent user edits", () => {
    const f = fixture(); const snapshot = captureSnapshot(f.source, f.snapshotRoot); materializeSnapshot(snapshot, f.candidate); put(f.candidate, "file.txt", "new");
    const directory = path.join(f.source, ".harness2/apply-transactions/interrupted"); put(directory, "backup/0", "original");
    put(directory, "journal.json", JSON.stringify({ sourceRoot: f.source, state: "applying", changes: diffWorkspace(snapshot, f.candidate), before: [snapshot.files[0]] }));
    put(f.source, "file.txt", "post-crash user edit");
    expect(() => recoverInterruptedApplies(f.source)).toThrow("workspace changed");
    expect(fs.readFileSync(path.join(f.source, "file.txt"), "utf8")).toBe("post-crash user edit");
  });
});
