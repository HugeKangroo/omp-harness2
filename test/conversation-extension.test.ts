import { afterEach, describe, expect, test } from "bun:test";
import { registerConversation, type ConversationContext, type ConversationDependencies, type ConversationHost, type ConversationTool, type ControllerPort } from "../src/conversation-extension.ts";
import { BINDING_ENTRY, COMPLETION_MESSAGE, PREVIEW_ENTRY, RECEIPT_ENTRY } from "../src/conversation.ts";
import { baseHarness } from "../src/surface.ts";
import type { Change, RunConfig, RunRecord } from "../src/types.ts";

const WORKSPACE = "/tmp/harness-conversation-project";
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
interface Entry { id: string; parentId: string | null; type: string; message?: unknown; customType?: string; data?: unknown; content?: string; attribution?: string }
interface Session { entries: Map<string, Entry>; leaf: string | null }
class SessionState {
  sessions = new Map<string, Session>(); active = "session-A"; sequence = 0;
  constructor() { this.sessions.set(this.active, { entries: new Map(), leaf: null }); this.user("Please improve the draft."); }
  get current() { return this.sessions.get(this.active)!; }
  append(entry: Omit<Entry, "id" | "parentId">, parentId = this.current.leaf): Entry {
    const item = { ...entry, id: `entry-${++this.sequence}`, parentId }; this.current.entries.set(item.id, item); this.current.leaf = item.id; return item;
  }
  user(text: string, parentId = this.current.leaf) { return this.append({ type: "message", message: { role: "user", content: [{ type: "text", text }] } }, parentId); }
  branch(): Entry[] {
    const result: Entry[] = []; let leaf = this.current.leaf;
    while (leaf) { const entry = this.current.entries.get(leaf)!; result.unshift(entry); leaf = entry.parentId; }
    return result;
  }
  switchTo(id: string): void {
    if (!this.sessions.has(id)) this.sessions.set(id, { entries: new Map(), leaf: null });
    this.active = id;
    if (!this.current.leaf) this.user("An unrelated conversation.");
  }
}
class FakeController implements ControllerPort {
  records = new Map<string, RunRecord>();
  creates: Array<{ task: string; options: Partial<RunConfig> & { model: string } }> = [];
  applies: string[] = []; applyDigests: Array<string | undefined> = []; cancels: string[] = []; gets: string[] = [];
  applyGuards: Array<(() => void) | undefined> = []; applyEntered = deferred<void>(); applyWait?: Promise<void>;
  createWait?: Promise<void>;
  createEntered = deferred<void>();
  getOverride?: (id: string) => Promise<RunRecord | undefined>;
  diffOverride?: (id: string) => Promise<Change[]>;
  changes: Change[] = [{ path: "draft.md", kind: "modify", beforeHash: "b".repeat(64), afterHash: "a".repeat(64) }];
  async create(task: string, options: Partial<RunConfig> & { model: string }): Promise<RunRecord> {
    this.creates.push({ task, options }); this.createEntered.resolve(); const id = `run-${this.creates.length}`;
    if (this.createWait) await this.createWait;
    const now = new Date().toISOString();
    const record: RunRecord = { schemaVersion: 1, id, revision: 0, createdAt: now, updatedAt: now, workspace: WORKSPACE, task, status: "queued",
      config: { mode: "product", strategy: "auto", improverModel: options.model, maxCostUsd: 5, maxDurationMs: 1_800_000, stageTimeoutMs: 600_000, domain: "project", ompCommand: "omp", ...options },
      baseHarness: baseHarness(), libraryEntries: [], stages: {} };
    this.records.set(id, record); return structuredClone(record);
  }
  async get(id: string): Promise<RunRecord | undefined> { this.gets.push(id); return this.getOverride ? this.getOverride(id) : structuredClone(this.records.get(id)); }
  async diff(id: string): Promise<Change[]> { return this.diffOverride ? this.diffOverride(id) : structuredClone(this.changes); }
  async apply(id: string, expectedReviewDigest?: string, beforeCommit?: () => void) {
    this.applyDigests.push(expectedReviewDigest); this.applyGuards.push(beforeCommit); this.applyEntered.resolve();
    if (this.applyWait) await this.applyWait;
    beforeCommit?.(); this.applies.push(id); this.records.get(id)!.status = "applied";
    return { applied: true, alreadyApplied: false, changes: structuredClone(this.changes) };
  }
  async cancel(id: string): Promise<void> { this.cancels.push(id); this.records.get(id)!.status = "cancelled"; }
  complete(id = "run-1"): RunRecord {
    const record = this.records.get(id)!; const now = new Date().toISOString();
    record.status = "completed"; record.revision++; record.winner = "baseline"; record.selectionReason = "The draft meets the requested structure.";
    record.snapshot = { id: `snapshot-${id}`, sourceRoot: WORKSPACE, root: `${WORKSPACE}/.harness2/${id}/snapshot`, files: [], createdAt: now };
    record.stages.baseline = { id: "baseline", status: "completed", attempt: 1, cwd: `${WORKSPACE}/.harness2/${id}/baseline`, startedAt: now, endedAt: now, harness: baseHarness(), artifactHash: "a".repeat(64),
      result: { text: "The revised draft is ready for review.", usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.01 }, startedAt: now, endedAt: now, eventsPath: `${WORKSPACE}/.harness2/${id}/events.jsonl`, status: "completed" } };
    return structuredClone(record);
  }
}
class FakeHost implements ConversationHost {
  tools = new Map<string, ConversationTool>();
  handlers = new Map<string, Array<(event: unknown, context: ConversationContext) => unknown | Promise<unknown>>>();
  timers = new Map<number, () => void | Promise<void>>(); timerSequence = 0;
  messages: Array<{ message: Parameters<ConversationHost["sendMessage"]>[0]; options: Parameters<ConversationHost["sendMessage"]>[1]; session: string; leaf: string | null }> = [];
  entries: Array<{ customType: string; data: unknown; session: string }> = [];
  notifications: string[] = []; confirms: Array<{ title: string; message: string }> = [];
  confirmEntered = deferred<void>();
  confirmResult = true; confirmWait?: Promise<boolean>; hasUI = true; agentKind: "main" | "sub" = "main";
  idle = true; pendingMessages = false; exposeQueueState = true;
  constructor(readonly state = new SessionState()) {}
  registerTool(tool: ConversationTool): void { this.tools.set(tool.name, tool); }
  on(event: string, handler: (event: unknown, context: ConversationContext) => unknown | Promise<unknown>): void {
    const handlers = this.handlers.get(event) ?? []; handlers.push(handler); this.handlers.set(event, handlers);
  }
  appendEntry(customType: string, data: unknown): void { this.entries.push({ customType, data: structuredClone(data), session: this.state.active }); this.state.append({ type: "custom", customType, data: structuredClone(data) }); }
  sendMessage(message: Parameters<ConversationHost["sendMessage"]>[0], options?: Parameters<ConversationHost["sendMessage"]>[1]): void {
    this.messages.push({ message, options, session: this.state.active, leaf: this.state.current.leaf });
    this.state.append({ type: "custom_message", customType: message.customType, content: message.content, attribution: message.attribution });
  }
  context(): ConversationContext {
    return { cwd: WORKSPACE, model: { provider: "test", id: "model" }, agent: { kind: this.agentKind }, hasUI: this.hasUI,
      ...(this.exposeQueueState ? { isIdle: () => this.idle, hasPendingMessages: () => this.pendingMessages } : {}),
      ui: { notify: message => { this.notifications.push(message); }, confirm: async (title, message) => { this.confirms.push({ title, message }); this.confirmEntered.resolve(); return this.confirmWait ?? this.confirmResult; } },
      sessionManager: { getSessionId: () => this.state.active, getLeafId: () => this.state.current.leaf, getBranch: () => this.state.branch() },
      setInterval: callback => { const id = ++this.timerSequence; this.timers.set(id, callback); return id; }, clearTimer: timer => { this.timers.delete(timer as number); } };
  }
  async event(name: string, event: unknown = {}): Promise<unknown[]> { return Promise.all((this.handlers.get(name) ?? []).map(handler => handler(event, this.context()))); }
  async tick(): Promise<void> { await Promise.all([...this.timers.values()].map(callback => callback())); }
  async switchTo(session: string): Promise<void> { this.state.switchTo(session); await this.event("session_switch"); }
  async tool(name: string, args: unknown, signal?: AbortSignal) { return this.tools.get(name)!.execute(`call-${++this.state.sequence}`, args, signal, undefined, this.context()); }
  previewToken(): string { const entry = this.state.branch().filter(item => item.customType === PREVIEW_ENTRY).at(-1); return (entry!.data as { token: string }).token; }
}
async function harness(options: { host?: FakeHost; controller?: FakeController; launchWait?: Promise<void>; updateOnLaunch?: boolean } = {}) {
  const host = options.host ?? new FakeHost(); const controller = options.controller ?? new FakeController();
  const launches: string[] = []; const launchBindings: boolean[] = []; let sessionChanges = 0;
  const dependencies: ConversationDependencies = { controller: () => controller,
    launch: async (_context, record) => {
      launches.push(record.id); launchBindings.push(host.state.branch().some(entry => entry.customType === BINDING_ENTRY && (entry.data as { runId: string }).runId === record.id));
      if (options.launchWait) await options.launchWait;
      if (options.updateOnLaunch !== false) controller.records.get(record.id)!.status = "running";
    }, renderDiff: () => "--- a/draft.md\n+++ b/draft.md\n@@ -1 +1 @@\n-old draft\n+revised draft", onSessionChange: () => { sessionChanges++; } };
  const registration = registerConversation(host, dependencies); cleanups.push(() => registration.dispose());
  await host.event("session_start");
  return { host, controller, launches, launchBindings, registration, sessionChanges: () => sessionChanges };
}
async function started(options: Parameters<typeof harness>[0] = {}) {
  const value = await harness(options); const result = await value.host.tool("harness_task", { action: "start", task: "Improve draft.md" });
  expect(result.isError).not.toBe(true); return value;
}

describe("conversational Harness² extension", () => {
  test("routes a conversational handoff with scoped context and binds it before asynchronous launch", async () => {
    const { host, controller, launches, launchBindings } = await harness();
    expect([...host.tools.keys()].sort()).toEqual(["harness_apply", "harness_task"]);
    const result = await host.tool("harness_task", { action: "start", task: "Rewrite the introduction", context: "The audience is new team members.", constraints: ["Keep it under 200 words"], strategy: "explore", budget: 2 });
    expect(result.isError).not.toBe(true); expect(controller.creates).toHaveLength(1);
    expect(controller.creates[0]!.task).toContain("Rewrite the introduction");
    expect(controller.creates[0]!.task).toContain("The audience is new team members.");
    expect(controller.creates[0]!.task).toContain("Keep it under 200 words");
    expect(controller.creates[0]!.options).toMatchObject({ model: "test/model", strategy: "explore", maxCostUsd: 2 });
    expect(launches).toEqual(["run-1"]); expect(launchBindings).toEqual([true]); expect(host.timers.size).toBe(1);
    expect((await host.tool("harness_task", { action: "inspect" })).isError).not.toBe(true);
    expect(controller.creates).toHaveLength(1); expect(controller.applies).toHaveLength(0);
  });

  test("duplicate start calls from one user message launch only one run", async () => {
    const { host, controller, launches } = await started();
    await host.tool("harness_task", { action: "start", task: "Improve draft.md" });
    expect(controller.creates).toHaveLength(1); expect(launches).toEqual(["run-1"]); expect(host.timers.size).toBe(1);
  });

  test("concurrent start calls cannot create duplicate runs while the first creation is pending", async () => {
    const controller = new FakeController(); const ready = deferred<void>(); controller.createWait = ready.promise;
    const { host, launches } = await harness({ controller });
    const first = host.tool("harness_task", { action: "start", task: "Improve draft.md" }); await controller.createEntered.promise;
    const duplicate = host.tool("harness_task", { action: "start", task: "Improve draft.md" }); ready.resolve();
    await Promise.all([first, duplicate]); expect(controller.creates).toHaveLength(1); expect(launches).toEqual(["run-1"]);
  });

  test("switching sessions during creation cannot bind or launch the pending task in the new session", async () => {
    const controller = new FakeController(); const ready = deferred<void>(); controller.createWait = ready.promise;
    const { host, launches } = await harness({ controller });
    const starting = host.tool("harness_task", { action: "start", task: "Improve draft.md" }); await controller.createEntered.promise;
    await host.switchTo("session-B"); ready.resolve();
    expect((await starting).isError).toBe(true); expect(launches).toHaveLength(0);
    expect(host.entries.some(entry => entry.session === "session-B" && entry.customType === BINDING_ENTRY)).toBe(false);
  });

  test("completion sends one agent-attributed follow-up and does not recursively spawn work", async () => {
    const { host, controller, launches } = await started(); controller.complete();
    await host.tick(); await host.tick();
    expect(host.messages).toHaveLength(1);
    expect(host.messages[0]).toMatchObject({ session: "session-A", message: { customType: COMPLETION_MESSAGE, attribution: "agent" }, options: { triggerTurn: true, deliverAs: "followUp" } });
    expect(host.messages[0]!.message.content).toContain("The revised draft is ready for review.");
    expect(host.entries.filter(entry => entry.customType === RECEIPT_ENTRY)).toHaveLength(1);
    const recursive = await host.tool("harness_task", { action: "start", task: "Automatically improve the completed result again" });
    expect(recursive.isError).toBe(true); expect(launches).toEqual(["run-1"]); expect(controller.creates).toHaveLength(1);
    host.state.user("Start a new draft for a different audience.");
    expect((await host.tool("harness_task", { action: "start", task: "Draft for a different audience" })).isError).not.toBe(true);
    expect(launches).toEqual(["run-1", "run-2"]);
  });

  test("busy or queued host messages hold completion locally until one safe idle wake", async () => {
    const { host, controller } = await started(); controller.complete(); host.idle = false;
    await host.tick(); expect(host.messages).toHaveLength(0); expect(host.entries.filter(entry => entry.customType === RECEIPT_ENTRY)).toHaveLength(0); expect(host.timers.size).toBe(1);
    host.idle = true; host.pendingMessages = true;
    await host.tick(); expect(host.messages).toHaveLength(0); expect(host.entries.filter(entry => entry.customType === RECEIPT_ENTRY)).toHaveLength(0); expect(host.timers.size).toBe(1);
    host.pendingMessages = false; await host.tick(); await host.tick();
    expect(host.messages).toHaveLength(1); expect(host.entries.filter(entry => entry.customType === RECEIPT_ENTRY)).toHaveLength(1); expect(host.timers.size).toBe(0);
  });

  test("a completion held while busy cannot leak through a later sibling-branch switch", async () => {
    const { host, controller } = await started(); const originLeaf = host.state.current.leaf; controller.complete(); host.idle = false;
    await host.tick(); expect(host.messages).toHaveLength(0);
    host.state.user("An unrelated branch", null); await host.event("session_branch"); host.idle = true; await host.tick();
    expect(host.messages).toHaveLength(0); expect(host.entries.filter(entry => entry.customType === RECEIPT_ENTRY)).toHaveLength(0);
    host.state.current.leaf = originLeaf; await host.event("session_tree"); await host.tick();
    expect(host.messages).toHaveLength(1); expect(host.messages[0]!.leaf).toBe(host.state.branch().find(entry => entry.customType === RECEIPT_ENTRY)!.id);
  });

  test("hosts without queue state APIs keep inspection available without automatic turns", async () => {
    const host = new FakeHost(); host.exposeQueueState = false;
    const { controller } = await started({ host }); controller.complete(); await host.tick();
    expect(host.messages).toHaveLength(0); expect(host.entries.filter(entry => entry.customType === RECEIPT_ENTRY)).toHaveLength(0);
    const inspected = await host.tool("harness_task", { action: "inspect" });
    expect(inspected.isError).not.toBe(true); expect(inspected.content[0]!.text).toContain("The revised draft is ready for review.");
  });

  test("restart reattaches visible bindings and avoids delivering an acknowledged result twice", async () => {
    const first = await started(); first.registration.dispose();
    const secondHost = new FakeHost(first.host.state); const second = await harness({ host: secondHost, controller: first.controller });
    expect(second.launches).toHaveLength(0); expect(secondHost.timers.size).toBe(1);
    first.controller.complete(); await secondHost.tick(); expect(secondHost.messages).toHaveLength(1);
    second.registration.dispose();
    const thirdHost = new FakeHost(first.host.state); const third = await harness({ host: thirdHost, controller: first.controller });
    await thirdHost.tick(); expect(thirdHost.messages).toHaveLength(0); expect(third.launches).toHaveLength(0);
  });

  test("completion remains on its originating session when a poll resolves after switching", async () => {
    const { host, controller } = await started(); const completed = controller.complete();
    const result = deferred<RunRecord | undefined>(), entered = deferred<void>();
    controller.getOverride = async () => { controller.getOverride = undefined; entered.resolve(); return result.promise; };
    const polling = host.tick(); await entered.promise; await host.switchTo("session-B"); result.resolve(completed); await polling;
    expect(host.messages).toHaveLength(0); expect(host.entries.some(entry => entry.customType === RECEIPT_ENTRY && entry.session === "session-B")).toBe(false);
    await host.switchTo("session-A"); await host.tick();
    expect(host.messages).toHaveLength(1); expect(host.messages[0]!.session).toBe("session-A");
  });

  test("a sibling branch neither receives nor controls another branch's run", async () => {
    const { host, controller } = await started(); const originLeaf = host.state.current.leaf;
    host.state.user("Unrelated branch", null); await host.event("session_branch"); controller.complete(); await host.tick();
    expect(host.messages).toHaveLength(0);
    expect((await host.tool("harness_task", { action: "inspect", runId: "run-1" })).isError).toBe(true);
    host.state.current.leaf = originLeaf; await host.event("session_tree"); await host.tick();
    expect(host.messages).toHaveLength(1); expect(host.messages[0]!.session).toBe("session-A");
  });

  test("preview-bound apply requires an actual UI confirmation and applies only the reviewed run", async () => {
    const { host, controller } = await started(); controller.complete();
    const preview = await host.tool("harness_task", { action: "preview" }); expect(preview.isError).not.toBe(true);
    expect(preview.content.map(item => item.text).join("\n")).toContain("+revised draft");
    const token = host.previewToken();
    host.confirmResult = false;
    await host.tool("harness_apply", { token }); expect(controller.applies).toHaveLength(0); expect(host.confirms).toHaveLength(1);
    host.confirmResult = true;
    await host.tool("harness_task", { action: "preview" });
    const applied = await host.tool("harness_apply", { token: host.previewToken() });
    expect(applied.isError).not.toBe(true); expect(controller.applies).toEqual(["run-1"]); expect(host.confirms).toHaveLength(2);
    expect(controller.applyDigests[0]).toBe((host.state.branch().filter(entry => entry.customType === PREVIEW_ENTRY).at(-1)!.data as { digest: string }).digest);
    expect(host.confirms.at(-1)!.message).toContain("draft.md");
  });

  test("model approval flags, missing UI and stale preview tokens cannot bypass confirmation", async () => {
    const { host, controller } = await started(); controller.complete();
    await host.tool("harness_task", { action: "preview" }); const oldToken = host.previewToken();
    expect((await host.tool("harness_apply", { token: oldToken, approved: true })).isError).toBe(true);
    expect(host.confirms).toHaveLength(0); expect(controller.applies).toHaveLength(0);
    host.hasUI = false;
    expect((await host.tool("harness_apply", { token: oldToken })).isError).toBe(true);
    expect(host.confirms).toHaveLength(0); host.hasUI = true;
    await host.tool("harness_task", { action: "preview" }); expect(host.previewToken()).not.toBe(oldToken);
    expect((await host.tool("harness_apply", { token: oldToken })).isError).toBe(true);
    expect(controller.applies).toHaveLength(0);
  });

  test("changing the selected output while confirmation is pending invalidates approval", async () => {
    const { host, controller } = await started(); controller.complete(); await host.tool("harness_task", { action: "preview" });
    const confirmation = deferred<boolean>(); host.confirmWait = confirmation.promise;
    const applying = host.tool("harness_apply", { token: host.previewToken() });
    await Promise.race([host.confirmEntered.promise, applying.then(() => { throw new Error("Apply ended without asking for confirmation"); })]);
    controller.records.get("run-1")!.stages.baseline!.result!.text = "A different selected response"; confirmation.resolve(true);
    expect((await applying).isError).toBe(true); expect(controller.applies).toHaveLength(0);
  });

  test("switching sessions during UI confirmation prevents apply in either conversation", async () => {
    const { host, controller } = await started(); controller.complete(); await host.tool("harness_task", { action: "preview" });
    const confirmation = deferred<boolean>(); host.confirmWait = confirmation.promise;
    const applying = host.tool("harness_apply", { token: host.previewToken() });
    await Promise.race([host.confirmEntered.promise, applying.then(() => { throw new Error("Apply ended without asking for confirmation"); })]);
    await host.switchTo("session-B"); confirmation.resolve(true);
    expect((await applying).isError).toBe(true); expect(controller.applies).toHaveLength(0);
    expect(host.entries.some(entry => entry.session === "session-B" && entry.customType === PREVIEW_ENTRY)).toBe(false);
  });

  test("switching to a sibling branch during UI confirmation invalidates the pending apply", async () => {
    const { host, controller } = await started(); controller.complete(); await host.tool("harness_task", { action: "preview" });
    const confirmation = deferred<boolean>(); host.confirmWait = confirmation.promise;
    const applying = host.tool("harness_apply", { token: host.previewToken() });
    await Promise.race([host.confirmEntered.promise, applying.then(() => { throw new Error("Apply ended without asking for confirmation"); })]);
    host.state.user("A different branch", null); await host.event("session_branch"); confirmation.resolve(true);
    expect((await applying).isError).toBe(true); expect(controller.applies).toHaveLength(0);
  });

  test("a second apply cannot open another confirmation or reuse an in-flight approval", async () => {
    const { host, controller } = await started(); controller.complete(); await host.tool("harness_task", { action: "preview" });
    const confirmation = deferred<boolean>(); host.confirmWait = confirmation.promise; const token = host.previewToken();
    const first = host.tool("harness_apply", { token });
    await Promise.race([host.confirmEntered.promise, first.then(() => { throw new Error("Apply ended without asking for confirmation"); })]);
    expect((await host.tool("harness_apply", { token })).isError).toBe(true); expect(host.confirms).toHaveLength(1);
    confirmation.resolve(true); expect((await first).isError).not.toBe(true); expect(controller.applies).toEqual(["run-1"]);
  });

  test("the controller commit guard rejects branch changes and aborts after UI approval", async () => {
    for (const interruption of ["branch", "abort"] as const) {
      const { host, controller } = await started(); controller.complete(); await host.tool("harness_task", { action: "preview" });
      const ready = deferred<void>(); controller.applyWait = ready.promise; const abort = new AbortController();
      const applying = host.tool("harness_apply", { token: host.previewToken() }, abort.signal);
      await Promise.race([controller.applyEntered.promise, applying.then(() => { throw new Error("Apply ended before reaching its commit guard"); })]);
      expect(typeof controller.applyGuards[0]).toBe("function"); expect(host.confirms).toHaveLength(1);
      if (interruption === "branch") { host.state.user("Another branch", null); await host.event("session_branch"); }
      else abort.abort(new Error("User cancelled while apply was waiting"));
      ready.resolve(); expect((await applying).isError).toBe(true); expect(controller.applies).toHaveLength(0);
      expect(controller.records.get("run-1")!.status).toBe("completed");
    }
  });

  test("nested agents cannot start runs, and bound cancel/resume actions retain their origin", async () => {
    const { host, controller, launches } = await harness(); host.agentKind = "sub";
    expect((await host.tool("harness_task", { action: "start", task: "Nested task" })).isError).toBe(true);
    expect(controller.creates).toHaveLength(0); host.agentKind = "main";
    await host.tool("harness_task", { action: "start", task: "Improve draft.md" });
    expect((await host.tool("harness_task", { action: "cancel" })).isError).not.toBe(true); expect(controller.cancels).toEqual(["run-1"]);
    host.state.user("Continue the cancelled task.");
    expect((await host.tool("harness_task", { action: "resume" })).isError).not.toBe(true);
    expect(controller.creates).toHaveLength(1); expect(launches).toEqual(["run-1", "run-1"]);
  });

  test("resume waits for a newer revision instead of redelivering the pre-launch failure", async () => {
    const { host, controller, launches } = await started({ updateOnLaunch: false });
    const record = controller.records.get("run-1")!; record.status = "failed"; record.revision = 7;
    host.state.user("Resume the failed task.");
    expect((await host.tool("harness_task", { action: "resume" })).isError).not.toBe(true); expect(launches).toEqual(["run-1", "run-1"]);
    await host.tick(); expect(host.messages).toHaveLength(0); expect(host.entries.filter(entry => entry.customType === RECEIPT_ENTRY)).toHaveLength(0); expect(host.timers.size).toBe(1);
    controller.complete(); await host.tick(); await host.tick();
    expect(host.messages).toHaveLength(1); expect(host.messages[0]!.message.content).toContain("completed"); expect(host.timers.size).toBe(0);
  });
});
