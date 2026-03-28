import { describe, expect, it } from "vitest";
import { buildDigestPrompt, normalizeDigestSections } from "../lib/sessionDigestAgent.js";

describe("sessionDigestAgent", function () {
  it("builds a prompt with evidence JSON and section requirements", function () {
    var prompt = buildDigestPrompt({
      fileName: "trace.jsonl",
      format: "copilot-cli",
      totalTurns: 3,
      commands: [{ turn: 1, toolName: "bash", kind: "Shell command", input: "npm test", resultSummary: "2 failures" }],
    });

    expect(prompt).toContain("submit_digest_sections");
    expect(prompt).toContain("trace.jsonl");
    expect(prompt).toContain("npm test");
    expect(prompt).toContain("questions");
  });

  it("normalizes malformed section payloads", function () {
    var sections = normalizeDigestSections({
      summary: "  Session summary.  ",
      hypotheses: [{ hypothesis: "A", outcome: "weird", evidence: "E" }],
      decisions: [{ decision: "B", rationale: "R", evidence: "E2" }],
      questions: [{ question: "Q", answer: "A", evidence: "E3" }],
    });

    expect(sections.summary).toBe("Session summary.");
    expect(sections.hypotheses[0].outcome).toBe("open");
    expect(sections.decisions[0].decision).toBe("B");
    expect(sections.questions[0].question).toBe("Q");
  });
});
