import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { assertNoHomeDotEnv, RpcFrameDecoder } from "../src/runner.ts";
import { HarnessController } from "../src/controller.ts";

const integration = process.env.RUN_REAL_OMP_TEST === "1" ? test : test.skip;
type Frame = Record<string, unknown>;

/** A real main OMP agent, fixed stream-only provider and injected in-process task runner. */
integration("real OMP conversation calls Harness tools and receives completion without slash commands or paid workers", async () => {
  await assertNoHomeDotEnv();
  const root = await mkdtemp(join(tmpdir(), "h2-conversation-"));
  const workspace = join(root, "workspace");
  const auditPath = join(root, "audit.jsonl");
  let child: ReturnType<typeof spawn> | undefined;
  let closed: Promise<void> | undefined;
  try {
    await mkdir(workspace); await mkdir(join(root, "agent"));
    expect(spawnSync("git", ["init", "-q", workspace]).status).toBe(0);
    await writeFile(join(workspace, "notes.txt"), "Local notes for a concise summary.\n");
    await writeFile(auditPath, "");
    const configPath = join(root, "config.yml");
    await writeFile(configPath, JSON.stringify({
      enabledProviders: [], disabledProviders: ["native", "claude", "claude-plugins", "codex", "gemini", "github", "opencode", "cursor", "windsurf", "agents-md", "agents", "omp-plugins", "agent-plugins", "omp-managed", "mcp-json", "skillshare"],
      extensions: [], autoResume: false, retry: { enabled: false, modelFallback: false }, mcp: { enableProjectConfig: false },
      providers: { cacheWarming: "off" }, compaction: { enabled: false }, advisor: { enabled: false }, autolearn: { enabled: false }, contextPromotion: { enabled: false },
    }), { mode: 0o600 });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: homedir(), PI_CONFIG_DIR: relative(homedir(), root), PI_CODING_AGENT_DIR: join(root, "agent"), PI_NO_TITLE: "1", PI_NO_PTY: "1", OMP_PROFILE: "default", TERM: "dumb", HARNESS2_CONVERSATION_AUDIT: auditPath };
    child = spawn(process.env.OMP_COMMAND || "omp", [
      "--mode", "rpc", "--no-ui", "--no-tools", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-pty", "--no-session", "--no-title", "--no-prewalk",
      "--config", configPath, "--model", "harness2-conversation-fixture/scripted", "--thinking", "off", "--max-time", "30", "--max-cost", "0.1",
      "--extension", join(import.meta.dir, "fixtures/conversation-provider.mjs"),
    ], { cwd: workspace, env, stdio: "pipe" });
    const processHandle = child;
    const frames: Frame[] = [];
    const decoder = new RpcFrameDecoder();
    const utf8 = new TextDecoder();
    let buffer = "", stderr = "", failure: Error | undefined, exited = false;
    processHandle.stdout!.on("data", (bytes: Buffer) => {
      buffer += utf8.decode(bytes, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line) continue;
        try { const frame = decoder.decode(line); if (frame) frames.push(frame); }
        catch (error) { failure = error as Error; }
      }
    });
    processHandle.stderr!.on("data", (bytes: Buffer) => { stderr = (stderr + bytes.toString("utf8")).slice(-8000); });
    processHandle.on("error", error => { failure = error; });
    processHandle.stdin!.on("error", error => { failure = error; });
    closed = new Promise(resolve => processHandle.on("close", () => { exited = true; resolve(); }));
    const waitFor = async (predicate: () => boolean, label: string) => {
      const deadline = Date.now() + 15_000;
      while (!predicate()) {
        if (failure || exited || Date.now() >= deadline) {
          const audit = await readFile(auditPath, "utf8");
          throw new Error(`${label}: ${failure?.message ?? (exited ? "OMP exited" : "timed out")}\n${stderr}\n${audit.slice(-14000)}\n${JSON.stringify(frames.slice(-8))}`);
        }
        await Bun.sleep(10);
      }
    };
    let sequence = 0;
    const request = async (type: string, data: Frame = {}) => {
      const id = `conversation-${++sequence}`;
      processHandle.stdin!.write(`${JSON.stringify({ type, id, ...data })}\n`);
      await waitFor(() => frames.some(frame => frame.type === "response" && frame.id === id), type);
      const response = frames.find(frame => frame.type === "response" && frame.id === id)!;
      expect(response.success, JSON.stringify(response)).toBe(true);
      return response;
    };
    await waitFor(() => frames.some(frame => frame.type === "ready"), "ready");
    await request("negotiate_protocol", { protocolVersion: 2 });
    const state = (await request("get_state")).data as { model: { api: string }; dumpTools: Array<{ name: string }> };
    expect(state.model.api).toBe("harness2-conversation-fixture-api"); // Refuse any network-backed provider before prompt admission.
    expect(state.dumpTools.map(tool => tool.name).sort()).toEqual(["harness_apply", "harness_task"]);
    await request("set_auto_retry", { enabled: false });
    await request("set_auto_compaction", { enabled: false });
    await request("set_cache_warming", { mode: "off" });
    await request("set_event_filter", { events: ["agent_start", "agent_end", "message_end", "tool_execution_start", "tool_execution_end", "notice"] });
    const userPrompt = "Help me turn the local notes into a concise summary.txt. Preserve notes.txt.";
    await request("prompt", { message: userPrompt });
    const completion = () => frames.find(frame => frame.type === "message_end" && JSON.stringify(frame.message).includes("CONVERSATION_COMPLETED"));
    await waitFor(() => Boolean(completion()), "completion follow-up and inspection");
    const audit = (await readFile(auditPath, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(audit.filter(event => event.type === "tool_call").map(event => event.args.action)).toEqual(["start", "inspect"]);
    expect(audit.filter(event => event.type === "tool_call").every(event => event.argCount === 5 && event.sessionId && event.agent.kind === "main")).toBe(true);
    expect(audit.filter(event => event.type === "launch")).toHaveLength(1);
    expect(audit.filter(event => event.type === "fixture_worker").map(event => event.stage)).toEqual(["baseline", "select"]);
    expect(audit.filter(event => event.type === "send_message" && event.options?.triggerTurn === true)).toHaveLength(1);
    expect(audit.filter(event => event.type === "send_message").every(event => event.message.attribution === "agent")).toBe(true);
    const calls = audit.filter(event => event.type === "tool_call");
    expect(calls[0].branch.some((entry: any) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes(userPrompt))).toBe(true);
    expect(calls[1].branch.some((entry: any) => entry.type === "custom" && entry.customType === "omp-harness2.binding")).toBe(true);
    expect(JSON.stringify(frames)).not.toContain("FIXTURE_FAILURE");
    const records = await new HarnessController({ workspace }).list();
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe("completed");
    expect(records[0]!.task).toContain("Preserve notes.txt");
    expect(records[0]!.task).toContain("The user wants a concise local summary.");
    expect(await Bun.file(join(workspace, "summary.txt")).exists()).toBe(false);
    expect(await readFile(join(workspace, "notes.txt"), "utf8")).toBe("Local notes for a concise summary.\n");
  } finally {
    if (child) {
      child.stdin?.end();
      if (closed) await Promise.race([closed, Bun.sleep(1000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (closed) await Promise.race([closed, Bun.sleep(1000)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (closed) await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
