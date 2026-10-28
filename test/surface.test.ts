import { describe, expect, test } from "bun:test";
import { baseHarness, makeHarness, parseHarness, parseLesson, parseJsonResponse } from "../src/surface.ts";

describe("declarative harness boundary", () => {
  test("content-addresses bundles and rejects executable/configuration surfaces", () => {
    const base = baseHarness();
    expect(makeHarness(base).id).toBe(base.id);
    expect(() => makeHarness({ ...base, plugins: ["evil.ts"] })).toThrow("Unsupported");
    expect(() => makeHarness({ ...base, promptAppend: "x".repeat(8001) })).toThrow();
    expect(() => makeHarness({ ...base, skills: [{ name: "../escape", description: "x", content: "x" }] })).toThrow();
  });
  test("parses one bounded JSON response and validates skill uniqueness", () => {
    const base = baseHarness();
    expect(parseHarness("```json\n" + JSON.stringify(base) + "\n```", base.id).parentId).toBe(base.id);
    expect(() => parseJsonResponse('prefix {"x":1}')).toThrow();
    const skill = { name: "review", description: "When reviewing", content: "Check constraints" };
    expect(() => makeHarness({ ...base, skills: [skill, skill] })).toThrow("unique");
  });
  test("lessons may abstain and cannot invent evidence references", () => {
    expect(parseLesson('{"noEntry":true}', [])).toBeUndefined();
    expect(() => parseLesson(JSON.stringify({ cue: "x", lesson: "y", evidence: ["invented"], confidence: "high", limitations: "none" }), ["baseline"])).toThrow("evidence");
    expect(() => parseLesson(JSON.stringify({ cue: "x", lesson: "y", evidence: ["reflect"], confidence: "high", limitations: "none" }), ["reflect"])).toThrow("execution evidence");
    expect(() => parseLesson(JSON.stringify({ cue: "x", lesson: "y", evidence: ["baseline", "final"], confidence: ["high"], limitations: "none" }), ["baseline", "final"])).toThrow("confidence");
  });
});
