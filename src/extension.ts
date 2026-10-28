import { fileURLToPath } from "node:url";
import { HarnessController } from "./controller.ts";
import { HELP, formatShow, formatStatus, parseCommandText, safeDisplay, type HarnessCommand, type RunOptions } from "./commands.ts";
import type { RunRecord } from "./types.ts";
import { renderDiff } from "./diff.ts";
import { registerConversation, type ConversationContext, type ConversationHost } from "./conversation-extension.ts";

/** Narrow structural contract: OMP injects the API; no second SDK runtime is imported. */
interface CommandContext extends ConversationContext {}
interface ExtensionHost extends ConversationHost {
  registerCommand(name: string, command: { description: string; handler(args: string, context: CommandContext): Promise<void> }): void;
}

export function runArguments(command: Extract<HarnessCommand, { kind: "run" }>, context: Pick<CommandContext, "model">): string[] {
  const model = command.options.model ?? (context.model ? `${context.model.provider}/${context.model.id}` : undefined);
  if (!model) throw new Error("Select an OMP model or pass --model provider/model.");
  const args = ["start", "--model", model];
  const options: Array<[keyof RunOptions, string]> = [
    ["improverModel", "--improver-model"], ["budget", "--budget"], ["mode", "--mode"],
    ["strategy", "--strategy"],
    ["domain", "--domain"], ["maxMinutes", "--max-minutes"], ["stageMinutes", "--stage-minutes"],
  ];
  for (const [key, flag] of options) if (command.options[key] !== undefined) args.push(flag, String(command.options[key]));
  return [...args, "--", command.task];
}

async function cli(context: CommandContext, args: string[]): Promise<unknown> {
  const bun = Bun.which("bun");
  if (!bun) throw new Error("Bun is required for the Harness² controller. Install Bun and make it available on PATH.");
  const process = Bun.spawn([bun, fileURLToPath(new URL("./cli.ts", import.meta.url)), "--workspace", context.cwd, "--json", ...args], {
    cwd: context.cwd,
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
  let reply: { ok?: boolean; data?: unknown; error?: string };
  try { reply = JSON.parse(stdout.trim()); }
  catch { throw new Error(`Controller returned invalid output${stderr ? `: ${safeDisplay(stderr).slice(0, 500)}` : "."}`); }
  if (!reply.ok || (exitCode !== 0 && args[0] !== "doctor")) throw new Error(reply.error ?? `Controller exited with status ${exitCode}.`);
  return reply.data;
}

export default function harnessExtension(pi: ExtensionHost): void {
  const watchers = new Map<string, { timer: unknown; context: CommandContext }>();
  let sessionRevision = 0;
  const display = (text: string) => {
    const safe = safeDisplay(text);
    const content = safe.length <= 12_000 ? safe : `${safe.slice(0, 11_800)}\n\n[Display truncated. Use the corresponding CLI command to inspect the full result.]`;
    pi.sendMessage({ customType: "omp-harness2.output", content, display: true, attribution: "agent" }, { triggerTurn: false });
  };

  function watch(record: RunRecord, context: CommandContext): void {
    if (watchers.has(record.id)) return;
    const controller = new HarnessController({ workspace: context.cwd });
    const revision = sessionRevision;
    let pending = false;
    const timer = context.setInterval(async () => {
      if (pending) return;
      pending = true;
      try {
        const current = await controller.get(record.id);
        if (revision !== sessionRevision || !watchers.has(record.id)) return;
        if (!current || !["queued", "running"].includes(current.status)) {
          const watcher = watchers.get(record.id);
          if (watcher) watcher.context.clearTimer(watcher.timer);
          watchers.delete(record.id);
          if (current) {
            display(formatStatus(current));
            pi.appendEntry("omp-harness2.run-settled", { id: current.id, status: current.status, winner: current.winner });
          }
        }
      } catch (error) {
        if (revision !== sessionRevision) return;
        const watcher = watchers.get(record.id);
        if (watcher) watcher.context.clearTimer(watcher.timer);
        watchers.delete(record.id);
        context.ui.notify(`Harness² status check failed: ${safeDisplay(error instanceof Error ? error.message : String(error)).slice(0, 500)}`, "warning");
      } finally { pending = false; }
    }, 2500);
    watchers.set(record.id, { timer, context });
  }

  registerConversation(pi, {
    controller: workspace => new HarnessController({ workspace }),
    launch: async (context, record) => { await cli(context, ["resume-start", record.id]); },
    renderDiff,
    onSessionChange: () => {
      sessionRevision++;
      for (const watcher of watchers.values()) watcher.context.clearTimer(watcher.timer);
      watchers.clear();
    },
  });

  pi.registerCommand("harness", {
    description: "Complete local tasks, compare useful approaches, review and apply results",
    async handler(args, context) {
      const revision = sessionRevision;
      try {
        if (context.agent?.kind === "sub") throw new Error("Harness² control commands are available only in the main OMP session.");
        const command = parseCommandText(args);
        if (command.kind === "help") { display(HELP); return; }
        if (command.kind === "run" || command.kind === "resume") {
          const record = await cli(context, command.kind === "run" ? runArguments(command, context) : ["resume-start", command.id]) as RunRecord;
          if (revision !== sessionRevision) return;
          pi.appendEntry("omp-harness2.run-started", { id: record.id, workspace: record.workspace, budgetUsd: record.config.maxCostUsd, mode: record.config.mode, strategy: record.config.strategy ?? "legacy" });
          context.ui.notify(`Harness² ${record.id} started. Budget $${record.config.maxCostUsd.toFixed(2)}. Use /harness status ${record.id}. Results require explicit apply.`, "info");
          watch(record, context);
          return;
        }
        if (command.kind === "doctor") {
          const result = await cli(context, ["doctor"]) as { checks: Array<{ name: string; status: string; detail: string }> };
          display(result.checks.map((check) => `${check.status.toUpperCase()} ${check.name}: ${check.detail}`).join("\n"));
          return;
        }
        const controller = new HarnessController({ workspace: context.cwd });
        if (command.kind === "list") {
          const runs = (await controller.list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
          display(runs.length ? runs.slice(0, 50).map((run) => `${run.id} · ${run.status} · ${run.task.replace(/\s+/gu, " ").slice(0, 90)}`).join("\n") : "No Harness² runs in this workspace.");
        } else if (command.kind === "status" || command.kind === "show") {
          const record = command.id ? await controller.get(command.id) : (await controller.list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
          if (!record) throw new Error("Run not found. Use /harness list.");
          display(command.kind === "show" ? formatShow(record) : formatStatus(record));
          if (record.status === "running" || record.status === "queued") watch(record, context);
        } else if (command.kind === "cancel") {
          await controller.cancel(command.id);
          context.ui.notify(`Cancellation requested for ${command.id}; check status for confirmation.`, "info");
        } else if (command.kind === "diff") {
          const result = await cli(context, ["diff", command.id]) as { patch: string };
          display(result.patch.length > 11_500 ? `${result.patch.slice(0, 11_500)}\n\n[Preview truncated. Use the CLI diff command for a larger preview.]` : result.patch);
        } else if (command.kind === "apply") {
          const result = await controller.apply(command.id);
          pi.appendEntry("omp-harness2.result-applied", { id: command.id, changes: result.changes.length, alreadyApplied: result.alreadyApplied });
          context.ui.notify(result.alreadyApplied ? "This result was already applied." : `Applied ${result.changes.length} file changes from ${command.id}.`, "info");
        }
      } catch (error) {
        if (revision !== sessionRevision) return;
        context.ui.notify(`Harness²: ${safeDisplay(error instanceof Error ? error.message : String(error)).slice(0, 1000)}`, "error");
      }
    },
  });
}
