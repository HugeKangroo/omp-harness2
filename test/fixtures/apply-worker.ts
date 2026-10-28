import * as fs from "node:fs";
import * as path from "node:path";
import { spyOn } from "bun:test";
import { applyWorkspace } from "../../src/workspace.ts";
import type { WorkspaceSnapshot } from "../../src/types.ts";

const requestPath = process.argv[2]!;
const request = JSON.parse(fs.readFileSync(requestPath, "utf8")) as {
  snapshot: WorkspaceSnapshot; candidate: string; pauseAfter: string; paused: string; proceed: string;
};
const rename = fs.renameSync;
const patched = spyOn(fs, "renameSync").mockImplementation((from, to) => {
  rename(from, to);
  if (String(to) !== path.join(request.snapshot.sourceRoot, request.pauseAfter)) return;
  fs.writeFileSync(request.paused, "paused");
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(request.proceed)) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for apply test to continue");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
});
try { console.log(JSON.stringify(applyWorkspace(request.snapshot, request.candidate))); }
finally { patched.mockRestore(); }
