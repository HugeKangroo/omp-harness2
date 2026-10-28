import type { Mode, RunRecord } from "./types.ts";

export const HELP = `Harness² — evidence-driven harness optimization

  /harness run <task> [--model provider/id] [--budget USD]
      [--improver-model provider/id] [--mode product|research] [--domain NAME]
      [--max-minutes N] [--stage-minutes N]
  /harness status [run-id]
  /harness list
  /harness show <run-id>
  /harness cancel <run-id>
  /harness resume <run-id>
  /harness diff <run-id>
  /harness apply <run-id>
  /harness doctor

Runs execute in isolated workspaces. Apply is a separate, explicit action.
Use -- before task text that contains literal flags. No shell expansion is performed.`;

export interface RunOptions {
  model?: string;
  improverModel?: string;
  budget?: number;
  mode?: Mode;
  domain?: string;
  maxMinutes?: number;
  stageMinutes?: number;
}

export type HarnessCommand =
  | { kind: "help" | "list" | "doctor" }
  | { kind: "run"; task: string; options: RunOptions }
  | { kind: "status"; id?: string }
  | { kind: "show" | "cancel" | "resume" | "diff" | "apply"; id: string };

/** Shell-like quoting only. Deliberately never expands variables or executes text. */
export function tokenizeCommand(input: string): string[] {
  if (input.includes("\0")) throw new Error("Commands cannot contain NUL characters.");
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let active = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && (input[i + 1] === '"' || input[i + 1] === "\\")) {
        token += input[++i];
      } else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      active = true;
    } else if (/\s/u.test(char)) {
      if (active) tokens.push(token);
      token = "";
      active = false;
    } else if (char === "\\") {
      if (i + 1 >= input.length) throw new Error("Trailing escape in command.");
      token += input[++i];
      active = true;
    } else {
      token += char;
      active = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in command.");
  if (active) tokens.push(token);
  return tokens;
}

function positiveNumber(value: string, flag: string, max: number): number {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(value)) throw new Error(`${flag} requires a positive number.`);
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max) {
    throw new Error(`${flag} must be greater than 0 and at most ${max}.`);
  }
  return number;
}

function identifier(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) {
    throw new Error("A valid run id is required.");
  }
  return value;
}

function model(value: string, flag: string): string {
  if (!value.trim() || value.length > 300 || /[\s\x00-\x1f\x7f]/u.test(value)) {
    throw new Error(`${flag} requires a model identifier, such as provider/model.`);
  }
  return value;
}

export function parseCommand(args: string[]): HarnessCommand {
  if (args.some((arg) => arg.includes("\0"))) throw new Error("Commands cannot contain NUL characters.");
  const [kind, ...rest] = args;
  if (kind === undefined || kind === "help" || kind === "--help" || kind === "-h") {
    if (rest.length) throw new Error("help takes no arguments.");
    return { kind: "help" };
  }
  if (kind === "list" || kind === "doctor") {
    if (rest.length) throw new Error(`${kind} takes no arguments.`);
    return { kind };
  }
  if (kind === "status") {
    if (rest.length > 1) throw new Error("status accepts at most one run id.");
    return { kind, ...(rest[0] === undefined ? {} : { id: identifier(rest[0]) }) };
  }
  if (["show", "cancel", "resume", "diff", "apply"].includes(kind)) {
    if (rest.length !== 1) throw new Error(`${kind} requires exactly one run id.`);
    return { kind: kind as "show" | "cancel" | "resume" | "diff" | "apply", id: identifier(rest[0]) };
  }
  if (kind !== "run") throw new Error(`Unknown command ${JSON.stringify(kind)}. Use /harness help.`);

  const options: RunOptions = {};
  const task: string[] = [];
  const seen = new Set<string>();
  let literal = false;
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (literal) {
      task.push(arg);
      continue;
    }
    if (arg === "--") {
      literal = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      task.push(arg);
      continue;
    }
    const equal = arg.indexOf("=");
    const flag = equal === -1 ? arg : arg.slice(0, equal);
    if (!["--model", "--improver-model", "--budget", "--mode", "--domain", "--max-minutes", "--stage-minutes"].includes(flag)) {
      throw new Error(`Unknown option ${flag}. Use -- before literal task text.`);
    }
    if (seen.has(flag)) throw new Error(`Duplicate option ${flag}.`);
    seen.add(flag);
    const value = equal === -1 ? rest[++index] : arg.slice(equal + 1);
    if (value === undefined || value === "" || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    switch (flag) {
      case "--model": options.model = model(value, flag); break;
      case "--improver-model": options.improverModel = model(value, flag); break;
      case "--budget": options.budget = positiveNumber(value, flag, 1000); break;
      case "--max-minutes": options.maxMinutes = positiveNumber(value, flag, 1440); break;
      case "--stage-minutes": options.stageMinutes = positiveNumber(value, flag, 1440); break;
      case "--mode":
        if (value !== "product" && value !== "research") throw new Error("--mode must be product or research.");
        options.mode = value;
        break;
      case "--domain":
        if (!value.trim() || value.length > 120 || /[\x00-\x1f\x7f]/u.test(value)) throw new Error("--domain requires a short printable name.");
        options.domain = value.trim();
        break;
    }
  }
  const text = task.join(" ").trim();
  if (!text) throw new Error("run requires a task.");
  if (text.length > 100_000) throw new Error("Task exceeds the 100,000 character limit.");
  return { kind: "run", task: text, options };
}

export function parseCommandText(input: string): HarnessCommand {
  return parseCommand(tokenizeCommand(input));
}

/** Strip terminal control characters from model/user-controlled display values. */
export function safeDisplay(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "");
}

export function formatStatus(record: RunRecord): string {
  const stages = Object.values(record.stages);
  const active = stages.find((stage) => stage?.status === "running");
  const cost = stages.reduce((sum, stage) => sum + (stage?.observedCostUsd ?? (stage?.result?.usageEstimated ? 0 : stage?.result?.usage.costUsd ?? 0)), 0);
  const accountedCost = stages.reduce((sum, stage) => sum + (stage?.accountedCostUsd ?? stage?.result?.usage.costUsd ?? 0), 0);
  const reservedCost = stages.reduce((sum, stage) => sum + (stage?.reservedCostUsd ?? 0), 0);
  const lines = [
    `Harness² ${record.id}: ${record.status}`,
    `${stages.filter((stage) => stage?.status === "completed").length} stages complete${active ? `; ${active.id} running` : ""}`,
    `Observed cost: $${cost.toFixed(4)} / $${record.config.maxCostUsd.toFixed(2)}`,
  ];
  if (accountedCost > cost || reservedCost > 0) lines.push(`Budget charged: $${accountedCost.toFixed(4)}; reserved: $${reservedCost.toFixed(4)}`);
  if (record.winner) lines.push(`Selected result: ${record.winner}`);
  if (record.error) lines.push(`Error: ${safeDisplay(record.error)}`);
  for (const warning of record.warnings ?? []) lines.push(`Warning: ${safeDisplay(warning)}`);
  if (record.status === "completed") lines.push(`Preview /harness diff ${record.id}; apply /harness apply ${record.id}`);
  return lines.join("\n");
}
