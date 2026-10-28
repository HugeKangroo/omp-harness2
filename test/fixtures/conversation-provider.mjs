import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { registerConversation } from "../../src/conversation-extension.ts";
import { HarnessController } from "../../src/controller.ts";
import { renderDiff } from "../../src/diff.ts";

const audit = value => appendFileSync(process.env.HARNESS2_CONVERSATION_AUDIT, `${JSON.stringify(value)}\n`);
const textOf = content => typeof content === "string" ? content : (content || []).filter(part => part.type === "text").map(part => part.text).join("\n");

/** All task workers stay in this fixture process and return fixed local results. */
const runner = {
  async run(request) {
    audit({ type: "fixture_worker", stage: request.stage });
    const now = new Date().toISOString();
    mkdirSync(request.artifactDir, { recursive: true });
    const eventsPath = join(request.artifactDir, "fixture-events.jsonl");
    writeFileSync(eventsPath, '{"type":"local_fixture"}\n');
    let text;
    if (request.stage === "baseline") {
      writeFileSync(join(request.cwd, "summary.txt"), "A concise local summary.\n");
      text = "Prepared summary.txt. No tests or external checks were run.";
    } else if (request.stage === "select") {
      const input = JSON.parse(request.prompt.split("EVALUATION INPUT:\n")[1].split("\n")[0]);
      text = JSON.stringify({ assessments: input.candidates.map(candidate => ({ candidate: candidate.label,
        criteria: input.criteria.map(criterion => ({ criterionId: criterion.id, verdict: "met", evidence: "The fixed local fixture wrote summary.txt and preserved notes.txt." })), strengths: [], weaknesses: [],
      })), winner: input.candidates[0].label, reason: "Selected the one completed local fixture artifact.", limitations: ["Fixed fixture; no model-quality or external-validation claim."] });
    } else throw new Error(`Unexpected fixture worker stage: ${request.stage}`);
    return { text, usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.00001 }, startedAt: now, endedAt: new Date().toISOString(), eventsPath, status: "completed" };
  },
};

export default function conversationProvider(pi) {
  const controllers = new Map();
  const controller = workspace => {
    if (!controllers.has(workspace)) controllers.set(workspace, new HarnessController({ workspace, runner }));
    return controllers.get(workspace);
  };
  const host = {
    registerTool(tool) {
      audit({ type: "register_tool", name: tool.name, parameters: tool.parameters });
      pi.registerTool({ ...tool, async execute(...args) {
        const context = args[4];
        audit({ type: "tool_call", name: tool.name, args: args[1], argCount: args.length,
          sessionId: context.sessionManager.getSessionId(), leafId: context.sessionManager.getLeafId(),
          hasUI: context.hasUI, agent: context.agent, branch: context.sessionManager.getBranch(),
        });
        const result = await tool.execute(...args);
        audit({ type: "tool_result", name: tool.name, result });
        return result;
      } });
    },
    on: pi.on,
    appendEntry(type, data) { pi.appendEntry(type, data); audit({ type: "append_entry", customType: type, data }); },
    sendMessage(message, options) { audit({ type: "send_message", message, options }); pi.sendMessage(message, options); },
  };
  registerConversation(host, {
    controller,
    async launch(context, record) {
      audit({ type: "launch", runId: record.id, task: record.task });
      void controller(context.cwd).execute(record.id).then(result => audit({ type: "worker_finished", status: result.status, error: result.error })).catch(error => audit({ type: "worker_failed", error: String(error) }));
    },
    renderDiff,
  });
  let phase = "start";
  pi.registerProvider("harness2-conversation-fixture", {
    baseUrl: "https://never-contacted.invalid", apiKey: "fixture-unused-key", api: "harness2-conversation-fixture-api",
    models: [{ id: "scripted", name: "Conversation entry fixture", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 1024, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        audit({ type: "model_turn", phase, tools: context.tools.map(tool => tool.name) });
        let call, text;
        const results = context.messages.filter(message => message.role === "toolResult");
        if (results.some(result => result.isError)) text = `FIXTURE_FAILURE: ${textOf(results.at(-1)?.content)}`;
        else if (phase === "start") {
          phase = "acknowledge";
          call = { type: "toolCall", id: "conversation-start", name: "harness_task", arguments: { action: "start", task: "Write summary.txt from the local notes.", constraints: ["Preserve notes.txt"], context: "The user wants a concise local summary.", strategy: "direct" } };
        } else if (phase === "acknowledge") {
          phase = "completion";
          text = "CONVERSATION_STARTED: the local task is running; its result will return here.";
        } else if (phase === "completion") {
          phase = "finish";
          call = { type: "toolCall", id: "conversation-inspect", name: "harness_task", arguments: { action: "inspect" } };
        } else text = "CONVERSATION_COMPLETED: summary.txt is ready for review. The main workspace is unchanged.";
        const content = call ? [call] : [{ type: "text", text }];
        const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0.00001, output: 0.00001, cacheRead: 0, cacheWrite: 0, total: 0.00002 } },
          stopReason: call ? "toolUse" : "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: message });
        if (call) stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
        else stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
