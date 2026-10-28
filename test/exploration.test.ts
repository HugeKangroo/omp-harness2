import { describe, expect, test } from "bun:test";
import { directPlan, fallbackEvaluation, parseExplorationEvaluation, parseExplorationPlan, validateExplorationEvaluation, validateExplorationPlan } from "../src/exploration.ts";
import { parseLesson } from "../src/surface.ts";
import type { CandidateId, ExplorationPlan } from "../src/types.ts";

function plan(): ExplorationPlan {
  return { decision: "explore", reason: "The task admits two distinct approaches.",
    criteria: [{ id: "correctness", description: "Preserve requested behavior.", kind: "requirement" }, { id: "simplicity", description: "Keep the implementation easy to inspect.", kind: "quality" }],
    routes: [
      { id: "route_1", name: "Minimal change", approach: "Repair the current implementation in place.", assumptions: ["The current structure remains suitable."], tradeoffs: ["Retains existing complexity."] },
      { id: "route_2", name: "Simpler representation", approach: "Replace the representation while retaining the public interface.", assumptions: [], tradeoffs: ["Needs a larger change."] },
    ],
  };
}
const labels: Record<string, CandidateId> = { A: "baseline", B: "route_1", C: "route_2" };
function response() {
  return { assessments: Object.keys(labels).map(candidate => ({ candidate,
    criteria: [{ criterionId: "correctness", verdict: "met", evidence: "The inspected source handles the specified cases; execution is unverified." }, { criterionId: "simplicity", verdict: "unknown", evidence: "No reliable comparison yet." }],
    strengths: ["Keeps the interface."], weaknesses: [],
  })), winner: "B" as string | null, reason: "The source change is focused.", limitations: ["Tests were not executed."],
    refinement: { candidate: "B", instructions: "Clarify the boundary-case handling." } };
}

describe("adaptive exploration contracts", () => {
  test("parses bounded direct and consecutive exploratory plans while respecting forced strategy", () => {
    expect(parseExplorationPlan(JSON.stringify(plan()), "auto")).toEqual(plan());
    expect(parseExplorationPlan(JSON.stringify(plan()), "explore")).toEqual(plan());
    const direct = directPlan("The task is already specified precisely.");
    expect(direct.routes).toEqual([]);
    expect(parseExplorationPlan(JSON.stringify(direct), "direct")).toEqual(direct);
    expect(() => parseExplorationPlan(JSON.stringify(plan()), "direct")).toThrow("respect");
    expect(() => parseExplorationPlan(JSON.stringify(direct), "explore")).toThrow("respect");
    const three = plan();
    three.routes.push({ id: "route_3", name: "Alternative decomposition", approach: "Split the task into independent components.", assumptions: [], tradeoffs: [] });
    expect(() => validateExplorationPlan(three)).not.toThrow();
  });

  test("rejects duplicate normalized ideas and criteria, gaps, unknown fields, and invalid shapes", () => {
    const original = plan();
    const invalid: unknown[] = [
      { ...original, decision: ["explore"] },
      { ...original, reason: " " },
      { ...original, reason: "x".repeat(4001) },
      { ...original, criteria: [] },
      { ...original, criteria: [...original.criteria, original.criteria[0]] },
      { ...original, criteria: [{ ...original.criteria[0], kind: ["requirement"] }, original.criteria[1]] },
      { ...original, criteria: [original.criteria[0], { ...original.criteria[1], description: "  PRESERVE  requested behavior. " }] },
      { ...original, routes: original.routes.slice(0, 1) },
      { ...original, routes: [original.routes[0], { ...original.routes[1], id: "route_3" }] },
      { ...original, routes: [original.routes[0], { ...original.routes[1], name: "  ＭＩＮＩＭＡＬ  CHANGE " }] },
      { ...original, routes: [original.routes[0], { ...original.routes[1], approach: " REPAIR  THE CURRENT IMPLEMENTATION IN PLACE. " }] },
      { ...original, routes: [original.routes[0], { ...original.routes[1], assumptions: "none" }] },
      { ...original, routes: [original.routes[0], { ...original.routes[1], shell: "execute this" }] },
      { ...original, permissions: { shell: true } },
      { ...directPlan("Direct"), routes: original.routes },
    ];
    for (const value of invalid) expect(() => validateExplorationPlan(value)).toThrow();
  });

  test("maps anonymous labels and owns evaluation provenance", () => {
    const parsed = parseExplorationEvaluation(JSON.stringify(response()), plan(), labels, true);
    expect(parsed.method).toBe("model_review");
    expect(parsed.winner).toBe("route_1");
    expect(parsed.assessments.map(item => item.candidate)).toEqual(["baseline", "route_1", "route_2"]);
    expect(parsed.refinement?.candidate).toBe("route_1");
    expect(() => parseExplorationEvaluation(JSON.stringify({ ...response(), method: "fallback" }), plan(), labels, true)).toThrow();
    expect(() => parseExplorationEvaluation(JSON.stringify({ ...response(), winner: "route_1" }), plan(), labels, true)).toThrow("label");
    expect(() => parseExplorationEvaluation(JSON.stringify({ ...response(), winner: "toString" }), plan(), labels, true)).toThrow("label");
    expect(() => parseExplorationEvaluation(JSON.stringify(response()), plan(), { A: "baseline", B: "baseline" }, true)).toThrow("uniquely");
  });

  test("requires exact candidate and criterion coverage", () => {
    const original = response();
    const invalid = [
      { ...original, assessments: original.assessments.slice(1) },
      { ...original, assessments: [original.assessments[0], original.assessments[0], original.assessments[2]] },
      { ...original, assessments: original.assessments.map(item => ({ ...item, criteria: item.criteria.slice(1) })) },
      { ...original, assessments: original.assessments.map(item => ({ ...item, criteria: [item.criteria[0], item.criteria[0]] })) },
      { ...original, assessments: original.assessments.map(item => ({ ...item, criteria: [{ ...item.criteria[0], criterionId: "invented" }, item.criteria[1]] })) },
      { ...original, assessments: original.assessments.map(item => ({ ...item, criteria: [{ ...item.criteria[0], verdict: ["met"] }, item.criteria[1]] })) },
    ];
    for (const value of invalid) expect(() => parseExplorationEvaluation(JSON.stringify(value), plan(), labels, true)).toThrow();
  });

  test("excludes known requirement failures but does not convert unknown evidence to failure", () => {
    const value = response();
    value.assessments[1]!.criteria[0]!.verdict = "not_met";
    expect(() => parseExplorationEvaluation(JSON.stringify(value), plan(), labels, true)).toThrow("Winner");
    value.assessments[1]!.criteria[0]!.verdict = "unknown";
    value.assessments[1]!.criteria[1]!.verdict = "not_met";
    expect(parseExplorationEvaluation(JSON.stringify(value), plan(), labels, true).winner).toBe("route_1");
    const { refinement, ...withoutRefinement } = value;
    expect(() => parseExplorationEvaluation(JSON.stringify({ ...withoutRefinement, winner: null }), plan(), labels, false)).toThrow("null winner");
    withoutRefinement.assessments.forEach(item => { item.criteria[0]!.verdict = "not_met"; });
    expect(parseExplorationEvaluation(JSON.stringify({ ...withoutRefinement, winner: null }), plan(), labels, false).winner).toBeNull();
  });

  test("only the eligible winner can be refined and the final assessment cannot request refinement", () => {
    expect(() => parseExplorationEvaluation(JSON.stringify(response()), plan(), labels, false)).toThrow("unavailable");
    expect(() => parseExplorationEvaluation(JSON.stringify({ ...response(), refinement: { candidate: "A", instructions: "Change it." } }), plan(), labels, true)).toThrow("eligible winner");
    expect(() => parseExplorationEvaluation(JSON.stringify({ ...response(), refinement: { candidate: "B", instructions: "" } }), plan(), labels, true)).toThrow();
  });

  test("fallback preserves uncertainty and validates its candidate references", () => {
    const evaluation = fallbackEvaluation(plan(), ["baseline", "route_1"], "baseline", "Reviewer output was invalid.");
    expect(evaluation.method).toBe("fallback");
    expect(evaluation.refinement).toBeUndefined();
    expect(evaluation.assessments.every(item => item.criteria.every(criterion => criterion.verdict === "unknown"))).toBe(true);
    expect(() => validateExplorationEvaluation(evaluation, plan(), ["baseline", "route_1", "route_2"])).toThrow("Every candidate");
    expect(() => fallbackEvaluation(plan(), ["baseline"], "route_1", "Invalid preferred candidate")).toThrow();
    const tampered = structuredClone(evaluation); tampered.assessments[0]!.criteria[0]!.verdict = "met";
    expect(() => validateExplorationEvaluation(tampered, plan())).toThrow("unknown verdicts");
    expect(() => validateExplorationEvaluation({ ...evaluation, refinement: { candidate: "baseline", instructions: "Change it." } }, plan())).toThrow("cannot request");
    expect(() => validateExplorationEvaluation({ ...evaluation, reason: "x".repeat(100_001) }, plan())).toThrow("100 KB");
  });

  test("adaptive lessons require two distinct completed candidate executions while legacy rules remain", () => {
    const lesson = { cue: "Complex tasks", lesson: "Compare representations before making a broad change.", evidence: ["route_1", "route_2"], confidence: "low", limitations: "One task only." };
    expect(parseLesson(JSON.stringify(lesson), ["route_1", "route_2", "review"], ["route_1", "route_2"])?.evidence).toEqual(lesson.evidence);
    for (const evidence of [["route_1", "route_1"], ["route_1", "review"], ["route_1", "refine"]]) {
      expect(() => parseLesson(JSON.stringify({ ...lesson, evidence }), ["route_1", "route_2", "review"], ["route_1", "route_2"])).toThrow();
    }
    expect(() => parseLesson(JSON.stringify(lesson), ["route_1", "route_2"])).toThrow("baseline");
    expect(parseLesson(JSON.stringify({ ...lesson, evidence: ["baseline", "final"] }), ["baseline", "final"])).toBeDefined();
    expect(parseLesson('{"noEntry":true}', [], [])).toBeUndefined();
  });
});
