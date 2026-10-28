import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";

function textOf(content) {
  return typeof content === "string" ? content : (content || []).filter(part => part.type === "text").map(part => part.text).join("\n");
}

/** Exercise the real controller's role contracts without simulating the controller or RPC. */
function controllerStep(context, results) {
  const input = textOf(context.messages.find(message => message.role === "user")?.content);
  const task = JSON.parse(input.slice(input.indexOf("\n\n") + 2)).task;
  const role = /Harness2 (\w+) task/.exec(input)?.[1];
  const tools = context.tools.map(tool => tool.name).sort().join(",");
  const expectedTools = role === "solver" ? "list_files,read_file,write_file" : "list_files,read_file";
  if (tools !== expectedTools || results.some(result => result.isError)) return { text: "FIXTURE_FAILURE: role tools or host tool result" };
  const read = path => ({ call: { type: "toolCall", id: `read-${results.length}`, name: "read_file", arguments: { path } } });
  if (role === "solver") {
    const policy = JSON.stringify(context.systemPrompt || "");
    const label = policy.includes("FIXTURE_COMPOSED_POLICY") ? "final" : policy.includes("FIXTURE_INV_POLICY") ? "inv_probe" : policy.includes("FIXTURE_DOM_POLICY") ? "dom_probe" : "baseline";
    if (results.length === 0) return read("src/value.ts");
    if (!textOf(results[0].content).includes("'initial'")) return { text: "FIXTURE_FAILURE: solver did not start from original snapshot" };
    if (results.length === 1) return { call: { type: "toolCall", id: "write-value", name: "write_file", arguments: { path: "src/value.ts", content: `export const value = '${label}';\n` } } };
    return { text: `Fixture ${label} artifact. Changed src/value.ts; no tests were executed.` };
  }
  if (role === "editor") {
    if (results.length === 0) return read(".harness-evidence/baseline/changes.json");
    const label = task.startsWith("You are the INV") ? "INV" : task.startsWith("You are the DOM") ? "DOM" : "COMPOSED";
    return { text: JSON.stringify({ promptAppend: `FIXTURE_${label}_POLICY: State the observable completion condition.`, toolGuidance: "Use only available scoped file tools.", skills: [], rationale: "The fixture inspected baseline changes; this validates protocol behavior, not model quality." }) };
  }
  if (role === "selector") {
    if (results.length < 2) return read(`.harness-evidence/${results.length === 0 ? "A" : "B"}/files/src/value.ts`);
    const winner = textOf(results[0].content).includes("'final'") ? "A" : "B";
    return { text: JSON.stringify({ winner, reason: "Fixed fixture policy selected the artifact whose scoped evidence contains the final marker; no quality claim." }) };
  }
  if (role === "reflector") {
    if (results.length === 0) return read(".harness-evidence/final/changes.json");
    return { text: JSON.stringify({ cue: "Synthetic integration run", lesson: "Keep observable completion instructions separate from solver execution.", evidence: ["baseline", "final"], confidence: "low", limitations: "A deterministic provider validates plumbing only and supplies no evidence of model effectiveness." }) };
  }
  return { text: "FIXTURE_FAILURE: unknown role" };
}

/** Fixed, network-free provider fixture. Registers no tool or event handler. */
export default function scriptedProvider(pi) {
  pi.registerProvider("harness2-fixture", {
    baseUrl: "https://never-contacted.invalid",
    apiKey: "fixture-unused-key",
    api: "harness2-fixture-api",
    models: [{ id: "scripted", name: "Scripted integration fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1024, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        const serialized = JSON.stringify(context);
        const results = context.messages.filter(message => message.role === "toolResult");
        const controller = serialized.includes("H2_CONTROLLER_FIXTURE") ? controllerStep(context, results) : undefined;
        let violation;
        if (serialized.includes("OUTSIDE_FILE_MUST_NEVER_REACH_MODEL_7f31")) violation = "Outside file leaked through ingress.";
        if (results.length === 0 && serialized.includes("SKILL_BODY_ON_DEMAND_b7c1")) violation = "Skill body was preloaded.";
        if (results.length === 1 && !serialized.includes("SKILL_BODY_ON_DEMAND_b7c1")) violation = "Virtual skill read failed.";
        if (results.some(result => result.isError)) violation = "Host tool failed.";
        const tools = context.tools.map(tool => tool.name).sort().join(",");
        if (tools !== "list_files,read_file,write_file") violation = `Unexpected tools: ${tools}`;
        const call = controller?.call || (results.length === 0
          ? { type: "toolCall", id: "call-skill", name: "read_file", arguments: { path: "harness://skills/build" } }
          : { type: "toolCall", id: "call-write", name: "write_file", arguments: { path: "answer.txt", content: "42\n" } });
        const final = controller ? Boolean(controller.text) : Boolean(violation) || results.length >= 2;
        const content = final ? [{ type: "text", text: controller?.text || (violation ? `FIXTURE_FAILURE: ${violation}` : "Created answer.txt using host tools. No tests were executed. Ingress and skill isolation verified.") }] : [call];
        const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0.0001, output: 0.00002, cacheRead: 0, cacheWrite: 0, total: 0.00012 } },
          stopReason: final ? "stop" : "toolUse", timestamp: Date.now() };
        stream.push({ type: "start", partial: message });
        if (final) stream.push({ type: "text_end", contentIndex: 0, content: content[0].text, partial: message });
        else stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
