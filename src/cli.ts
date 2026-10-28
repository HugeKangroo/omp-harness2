#!/usr/bin/env bun
import { mkdirSync, openSync, closeSync, lstatSync, constants } from "node:fs";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessController } from "./controller.ts";
import { runDoctor } from "./doctor.ts";
import { renderDiff } from "./diff.ts";
import { HELP, formatStatus, parseCommand, safeDisplay, type RunOptions } from "./commands.ts";
import type { RunConfig, RunRecord } from "./types.ts";

interface CliOptions { workspace: string; storeRoot?: string; json: boolean; args: string[] }

function cliOptions(argv: string[]): CliOptions {
  let workspace = process.cwd();
  let storeRoot: string | undefined;
  let json = false;
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === "--json") { json = true; index++; continue; }
    if (arg === "--workspace" || arg === "--store-root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path.`);
      if (arg === "--workspace") workspace = resolve(value);
      else storeRoot = resolve(value);
      index += 2;
      continue;
    }
    break;
  }
  return { workspace, storeRoot, json, args: argv.slice(index) };
}

function runConfig(options: RunOptions): Partial<RunConfig> & { model: string } {
  if (!options.model) throw new Error("--model provider/model is required. In OMP, /harness uses the current model by default.");
  return {
    model: options.model,
    ...(options.improverModel === undefined ? {} : { improverModel: options.improverModel }),
    ...(options.budget === undefined ? {} : { maxCostUsd: options.budget }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.domain === undefined ? {} : { domain: options.domain }),
    ...(options.maxMinutes === undefined ? {} : { maxDurationMs: Math.round(options.maxMinutes * 60_000) }),
    ...(options.stageMinutes === undefined ? {} : { stageTimeoutMs: Math.round(options.stageMinutes * 60_000) }),
  };
}

/** Spawn argv directly, with no shell. The persisted run is the recovery handle. */
async function startWorker(record: RunRecord, controller: HarnessController, resume = false): Promise<void> {
  const bun = Bun.which("bun");
  if (!bun) throw new Error(`Run ${record.id} was saved, but Bun is not on PATH. Install Bun and resume this run.`);
  const logRoot = join(controller.storeRoot, "logs");
  mkdirSync(logRoot, { recursive: true, mode: 0o700 });
  if (lstatSync(logRoot).isSymbolicLink()) throw new Error("Controller log directory cannot be a symbolic link.");
  const log = openSync(join(logRoot, `${record.id}.log`), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const child = spawn(bun, [fileURLToPath(import.meta.url), "--workspace", record.workspace,
      "--store-root", controller.storeRoot, resume ? "__resume" : "__execute", record.id], {
      cwd: record.workspace,
      detached: true,
      stdio: ["ignore", log, log],
      env: process.env,
    });
    await new Promise<void>((resolveSpawn, reject) => {
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolveSpawn(); });
    });
  } finally {
    closeSync(log);
  }
}

function showRun(record: RunRecord): string {
  const lines = [formatStatus(record), `Model: ${record.config.model}`, `Mode: ${record.config.mode}`, `Task: ${safeDisplay(record.task)}`];
  if (record.selectionReason) lines.push(`Selection: ${safeDisplay(record.selectionReason)}`);
  if (record.winner) {
    const text = record.stages[record.winner]?.result?.text;
    if (text) lines.push("", "Selected response:", safeDisplay(text));
  }
  return lines.join("\n");
}

export async function runCli(argv: string[]): Promise<void> {
  const options = cliOptions(argv);
  const output = (data: unknown, message: string) => {
    process.stdout.write(options.json ? `${JSON.stringify({ ok: true, data })}\n` : `${message}\n`);
  };
  const controller = new HarnessController({ workspace: options.workspace, storeRoot: options.storeRoot });
  const executeWithSignals = async (id: string, resume = false): Promise<RunRecord> => {
    const cancel = () => {
      void controller.cancel(id).catch((error: unknown) => {
        process.stderr.write(`Cancellation failed: ${safeDisplay(error instanceof Error ? error.message : String(error))}\n`);
      });
    };
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try { return await (resume ? controller.resume(id) : controller.execute(id)); }
    finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
  };
  let background = false;
  let execute = false;
  let args = options.args;
  if (args[0] === "start") { background = true; args = ["run", ...args.slice(1)]; }
  else if (args[0] === "resume-start") { background = true; args = ["resume", ...args.slice(1)]; }
  else if (args[0] === "__execute") { execute = true; args = ["resume", ...args.slice(1)]; }
  else if (args[0] === "__resume") { args = ["resume", ...args.slice(1)]; }
  const command = parseCommand(args);
  switch (command.kind) {
    case "help": output({ help: HELP }, `${HELP}\n\nCLI: omp-harness2 [--workspace PATH] [--json] <command>`); return;
    case "doctor": {
      const result = await runDoctor();
      output(result, result.checks.map((check) => `${check.status.toUpperCase()} ${check.name}: ${safeDisplay(check.detail)}`).join("\n"));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case "run": {
      const record = await controller.create(command.task, runConfig(command.options));
      if (background) {
        await startWorker(record, controller);
        output(record, `Started Harness² ${record.id}. Budget $${record.config.maxCostUsd.toFixed(2)}.\n/harness status ${record.id}`);
      } else {
        const result = await executeWithSignals(record.id);
        output(result, formatStatus(result));
        if (["failed", "cancelled", "interrupted"].includes(result.status)) process.exitCode = 1;
      }
      return;
    }
    case "list": {
      const records = (await controller.list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      output(records, records.length ? records.map((record) => `${record.id}\t${record.status}\t${safeDisplay(record.task).replace(/\s+/gu, " ").slice(0, 90)}`).join("\n") : "No Harness² runs in this workspace.");
      return;
    }
    case "status": {
      const record = command.id ? await controller.get(command.id) : (await controller.list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (!record) throw new Error(command.id ? `Run ${command.id} was not found.` : "No Harness² runs in this workspace.");
      output(record, formatStatus(record)); return;
    }
    case "show": {
      const record = await controller.get(command.id);
      if (!record) throw new Error(`Run ${command.id} was not found.`);
      output(record, showRun(record)); return;
    }
    case "cancel":
      await controller.cancel(command.id);
      output({ id: command.id }, `Cancellation requested for ${command.id}. Check status for confirmation.`);
      return;
    case "resume": {
      const record = await controller.get(command.id);
      if (!record) throw new Error(`Run ${command.id} was not found.`);
      if (record.status === "completed" || record.status === "applied") throw new Error(`Run ${command.id} is already ${record.status}.`);
      if (background) {
        await startWorker(record, controller, true);
        output(record, `Resuming Harness² ${record.id}.`);
      } else {
        const result = await executeWithSignals(command.id, !execute);
        output(result, formatStatus(result));
        if (["failed", "cancelled", "interrupted"].includes(result.status)) process.exitCode = 1;
      }
      return;
    }
    case "diff": {
      const changes = await controller.diff(command.id);
      const record = await controller.get(command.id);
      if (!record) throw new Error(`Run ${command.id} was not found.`);
      const patch = renderDiff(record, changes);
      output({ changes, patch }, patch);
      return;
    }
    case "apply": {
      const result = await controller.apply(command.id);
      output(result, result.alreadyApplied ? "This result was already applied; no files were changed." : `Applied ${result.changes.length} file changes from ${command.id}.`);
      return;
    }
  }
}

if (import.meta.main) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    const message = safeDisplay(error instanceof Error ? error.message : String(error));
    if (process.argv.slice(2).includes("--json")) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    else process.stderr.write(`Harness²: ${message}\n`);
    process.exitCode = 1;
  }
}
