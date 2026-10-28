import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpRpcRunner, RpcFrameDecoder, credentialInfo, encodePromptData, parseModel } from "../src/runner";
import type { WorkerRequest } from "../src/types";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(mode: string): Promise<{ request: WorkerRequest; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "h2-runner-test-")); roots.push(root);
  const cwd = join(root, "workspace"); await mkdir(cwd);
  const script = join(root, "fake-omp");
  const body = `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
const mode=${JSON.stringify(mode)};
let tools=[];
fs.writeFileSync(${JSON.stringify(join(root, "pid"))}, String(process.pid));
const appendixArg=process.argv.indexOf('--append-system-prompt');
if(appendixArg!==-1) fs.writeFileSync(${JSON.stringify(join(root, "appendix.txt"))},fs.readFileSync(process.argv[appendixArg+1],'utf8'));
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const complete=()=>{send({type:'message_end',message:{role:'assistant',provider:'openai',model:'gpt-4.1',content:[{type:'text',text:'done'}]}});send({type:'agent_end',isTerminal:false});send({type:'prompt_result',id:'h2-prompt',agentInvoked:true,status:'completed',sessionSettled:false});setTimeout(()=>send({type:'session_settled'}),40);};
send({type:'ready',supportedProtocolVersions:[1,2]});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line); const respond=data=>send({type:'response',id:c.id,command:c.type,success:true,data});
 if(c.type==='get_state') return respond({model:{provider:'openai',id:'gpt-4.1',cost:{input:mode==='unpriced'?0:1,output:mode==='unpriced'?0:2}},dumpTools:mode==='contamination'?[{name:'bash'}]:tools,isSettled:true});
 if(c.type==='set_host_tools'){tools=c.tools;return respond({toolNames:tools.map(t=>t.name)});}
 if(c.type==='get_session_stats') return respond(mode==='missing_usage'?{}:{tokens:{input:10,output:5,cacheRead:2,cacheWrite:0},cost:mode==='over_budget'?0.2:0.02});
 if(c.type==='get_last_assistant_text') return respond({text:mode==='secret_final'?'echo '+process.env.OPENAI_API_KEY:'done'});
 if(c.type==='host_tool_result'){fs.writeFileSync(${JSON.stringify(join(root, "tool-result.json"))},JSON.stringify(c));complete();return;}
 if(c.type==='prompt'){
   fs.writeFileSync(${JSON.stringify(join(root, "prompt.json"))}, JSON.stringify(c));
   respond({});
   if(mode==='hang'){setInterval(()=>{},1000);return;}
   if(mode==='descendant'){
     const child=spawn(process.execPath,['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);setTimeout(()=>process.exit(0),5000)'],{stdio:'ignore'});
     fs.writeFileSync(${JSON.stringify(join(root, "descendant-pid"))},String(child.pid));
     setInterval(()=>{},1000);return;
   }
   if(mode==='provider_error'){send({type:'prompt_result',id:c.id,agentInvoked:true,status:'error',error:{message:'secret '+process.env.OPENAI_API_KEY},sessionSettled:true});return;}
   if(mode==='write'||mode==='read_only')return send({type:'host_tool_call',id:'tool-1',toolName:'write_file',arguments:{path:'answer.txt',content:'42'}});
   if(mode==='skill')return send({type:'host_tool_call',id:'tool-1',toolName:'read_file',arguments:{path:'harness://skills/build'}});
   if(mode==='escape')return send({type:'host_tool_call',id:'tool-1',toolName:'write_file',arguments:{path:'../outside.txt',content:'no'}});
   complete();return;
 }
 respond({});
}).on('close',()=>process.exit(0));
`;
  await writeFile(script, body); await chmod(script, 0o700);
  const request: WorkerRequest = { runId: "test", stage: "baseline", role: "solver", cwd, artifactDir: join(root, "artifacts"), prompt: "/bash touch evil", harness: { schemaVersion: 1, id: "base", promptAppend: "", toolGuidance: "", skills: [], rationale: "" }, model: "openai/gpt-4.1", maxCostUsd: 0.1, timeoutMs: 4000, ompCommand: script };
  return { request, root };
}
function runner() { return new OmpRpcRunner({ env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENAI_API_KEY: "secret-test-key-do-not-persist" } }); }

describe("OMP RPC worker", () => {
  test("writes only through host tools, waits for settled, records exact usage", async () => {
    const { request, root } = await fixture("write");
    const result = await runner().run(request);
    expect(result.status).toBe("completed");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 5, costUsd: 0.02 });
    expect(result.text).toBe("done");
    expect(await readFile(join(request.cwd, "answer.txt"), "utf8")).toBe("42");
    expect(JSON.parse(await readFile(join(root, "prompt.json"), "utf8")).message).toStartWith("Harness2 solver task follows as JSON data.");
    expect(await readFile(result.eventsPath, "utf8")).toContain("session_settled");
  });
  test("rejects inherited native tools before any model prompt", async () => {
    const { request, root } = await fixture("contamination");
    const result = await runner().run(request);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Unexpected OMP tools");
    expect(result.usage.costUsd).toBe(0);
    expect(await Bun.file(join(root, "prompt.json")).exists()).toBe(false);
  });
  test("advertises skill metadata and serves its body only through a read-only virtual resource", async () => {
    const { request, root } = await fixture("skill");
    request.harness.skills = [{ name: "build", description: "Build guidance", content: "SKILL_BODY_ONLY_ON_DEMAND" }];
    expect((await runner().run(request)).status).toBe("completed");
    const appendix = await readFile(join(root, "appendix.txt"), "utf8");
    expect(appendix).toContain("harness://skills/build");
    expect(appendix).not.toContain("SKILL_BODY_ONLY_ON_DEMAND");
    expect(await readFile(join(root, "tool-result.json"), "utf8")).toContain("SKILL_BODY_ONLY_ON_DEMAND");
    expect(await Bun.file(join(request.cwd, "build")).exists()).toBe(false);
  });
  test("does not expose writes to editor workers even on unsolicited write tool calls", async () => {
    const { request, root } = await fixture("read_only"); request.role = "editor";
    const result = await runner().run(request);
    expect(result.status).toBe("completed");
    const toolResult = JSON.parse(await readFile(join(root, "tool-result.json"), "utf8"));
    expect(toolResult.isError).toBe(true);
    expect(await Bun.file(join(request.cwd, "answer.txt")).exists()).toBe(false);
  });
  test("returns a tool error for a model-requested workspace escape", async () => {
    const { request, root } = await fixture("escape");
    expect((await runner().run(request)).status).toBe("completed");
    expect(JSON.parse(await readFile(join(root, "tool-result.json"), "utf8")).isError).toBe(true);
    expect(await Bun.file(join(root, "outside.txt")).exists()).toBe(false);
  });
  test("unknown accounting consumes allocation and fails closed", async () => {
    const { request } = await fixture("missing_usage");
    const result = await runner().run(request);
    expect(result.status).toBe("failed");
    expect(result.usage.costUsd).toBe(request.maxCostUsd);
    expect(result.usageEstimated).toBe(true);
  });
  test("rejects unpriced models before prompting", async () => {
    const { request, root } = await fixture("unpriced");
    expect((await runner().run(request)).status).toBe("failed");
    expect(await Bun.file(join(root, "prompt.json")).exists()).toBe(false);
  });
  test("records in-flight overspend and prevents successful completion", async () => {
    const { request } = await fixture("over_budget");
    const result = await runner().run(request);
    expect(result.status).toBe("failed");
    expect(result.usage.costUsd).toBe(0.2);
  });
  test("redacts provider credentials in errors and trace", async () => {
    const { request } = await fixture("provider_error");
    const result = await runner().run(request);
    expect(result.status).toBe("failed");
    expect(result.error).not.toContain("secret-test-key-do-not-persist");
    expect(await readFile(result.eventsPath, "utf8")).not.toContain("secret-test-key-do-not-persist");
  });
  test("redacts credentials echoed in final assistant text", async () => {
    const { request } = await fixture("secret_final");
    const result = await runner().run(request);
    expect(result.status).toBe("completed");
    expect(result.text).toContain("[REDACTED]");
    expect(result.text).not.toContain("secret-test-key-do-not-persist");
  });
  (process.env.RUN_PROCESS_GROUP_TEST === "1" ? test : test.skip)("cancellation kills a same-group descendant even after its parent exits", async () => {
    const { request, root } = await fixture("descendant"); request.timeoutMs = 1600;
    const result = await runner().run(request);
    const pid = Number(await readFile(join(root, "descendant-pid"), "utf8"));
    expect(result.status, result.error).toBe("timed_out");
    expect(() => process.kill(pid, 0)).toThrow();
  });
  test("deadline terminates the process group and conservatively accounts spend", async () => {
    const { request, root } = await fixture("hang"); request.timeoutMs = 1600;
    const result = await runner().run(request);
    expect(result.status).toBe("timed_out");
    expect(result.usage.costUsd).toBe(0.1);
    const pid = Number(await readFile(join(root, "pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });
  test("AbortSignal cancels an active prompt and terminates the worker", async () => {
    const { request, root } = await fixture("hang"); const controller = new AbortController(); request.signal = controller.signal;
    request.onEvent = event => {
      const data = event.data as Record<string, unknown>;
      if (event.type === "response" && data.id === "h2-prompt") controller.abort();
    };
    const started = runner().run(request);
    const result = await started;
    expect(result.status).toBe("cancelled");
    expect(() => process.kill(Number(require("node:fs").readFileSync(join(root, "pid"), "utf8")), 0)).toThrow();
  });
});

describe("strict RPC framing and model selection", () => {
  test("encodes ingress attachment/model triggers without changing task data", () => {
    const original = '/bash bad @/outside/file ^openai/another-model \\u0040 literal';
    const encoded = encodePromptData(original, "solver");
    expect(encoded).not.toContain("@");
    expect(encoded).not.toContain("^");
    expect(JSON.parse(encoded.split("\n\n")[1]!).task).toBe(original);
  });
  test("reassembles UTF8 chunks and rejects interleaving and bad lengths", () => {
    const data = Buffer.from(JSON.stringify({ type: "sample", text: "你好" }));
    const decoder = new RpcFrameDecoder();
    expect(decoder.decode(JSON.stringify({ type: "rpc_chunk", chunkId: "a", index: 0, count: 2, byteLength: data.length, data: data.subarray(0, 10).toString("base64") }))).toBeUndefined();
    expect(decoder.decode(JSON.stringify({ type: "rpc_chunk", chunkId: "a", index: 1, count: 2, byteLength: data.length, data: data.subarray(10).toString("base64") }))).toEqual({ type: "sample", text: "你好" });
    const broken = new RpcFrameDecoder();
    broken.decode(JSON.stringify({ type: "rpc_chunk", chunkId: "a", index: 0, count: 2, byteLength: data.length, data: data.subarray(0, 10).toString("base64") }));
    expect(() => broken.decode('{"type":"ready"}')).toThrow("Interrupted");
    expect(() => new RpcFrameDecoder().decode(JSON.stringify({ type: "rpc_chunk", chunkId: "a", index: 0, count: 1, byteLength: data.length + 1, data: data.toString("base64") }))).toThrow("length mismatch");
  });
  test("rejects aliases and credential-less unsupported providers", () => {
    expect(parseModel("openai/gpt-4.1")).toEqual({ provider: "openai", modelId: "gpt-4.1" });
    for (const value of ["opus", "@smol", "openai/*", "openai/gpt-4.1:high", "openai/a,openai/b"]) expect(() => parseModel(value)).toThrow();
    expect(() => credentialInfo("openai-codex/gpt-6")).toThrow("unsupported");
    expect(credentialInfo("openai/gpt-4.1", {})).toEqual({ variable: "OPENAI_API_KEY", present: false });
  });
});
