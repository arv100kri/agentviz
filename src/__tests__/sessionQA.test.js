import { describe, it, expect } from "vitest";
import { buildQAContext, buildQAPrompt } from "../../src/lib/sessionQA.js";

var SAMPLE_EVENTS = [
  { t: 0, agent: "user", track: "context", text: "Fix the bug in auth.js", duration: 0, intensity: 0.5, isError: false, turnIndex: 0 },
  { t: 1, agent: "assistant", track: "reasoning", text: "I think the issue is in the token validation logic", duration: 2, intensity: 0.8, isError: false, turnIndex: 0 },
  { t: 3, agent: "assistant", track: "tool_call", text: "Reading auth.js", duration: 1, intensity: 1, toolName: "view", isError: false, turnIndex: 0 },
  { t: 4, agent: "assistant", track: "tool_call", text: "Editing auth.js", duration: 1, intensity: 1, toolName: "edit", isError: false, turnIndex: 0 },
  { t: 5, agent: "assistant", track: "tool_call", text: "npm test failed", duration: 2, intensity: 1, toolName: "bash", isError: true, turnIndex: 0 },
  { t: 8, agent: "user", track: "context", text: "Try a different approach", duration: 0, intensity: 0.5, isError: false, turnIndex: 1 },
  { t: 9, agent: "assistant", track: "tool_call", text: "Editing auth.js", duration: 1, intensity: 1, toolName: "edit", isError: false, turnIndex: 1 },
  { t: 10, agent: "assistant", track: "output", text: "All tests pass now", duration: 0, intensity: 0.5, isError: false, turnIndex: 1 },
];

var SAMPLE_TURNS = [
  { index: 0, startTime: 0, endTime: 7, eventIndices: [0, 1, 2, 3, 4], userMessage: "Fix the bug in auth.js", toolCount: 3, hasError: true },
  { index: 1, startTime: 8, endTime: 11, eventIndices: [5, 6, 7], userMessage: "Try a different approach", toolCount: 1, hasError: false },
];

var SAMPLE_METADATA = {
  totalEvents: 8,
  totalTurns: 2,
  totalToolCalls: 4,
  errorCount: 1,
  duration: 11,
  primaryModel: "claude-sonnet-4",
  format: "copilot-cli",
  tokenUsage: { inputTokens: 5000, outputTokens: 2000 },
};

describe("buildQAContext", function () {
  it("includes session overview with metadata", function () {
    var context = buildQAContext(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    expect(context).toContain("SESSION OVERVIEW");
    expect(context).toContain("Turns: 2");
    expect(context).toContain("Tool calls: 4");
    expect(context).toContain("Errors: 1");
    expect(context).toContain("claude-sonnet-4");
  });

  it("includes per-turn summaries", function () {
    var context = buildQAContext(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    expect(context).toContain("Turn 0");
    expect(context).toContain("Turn 1");
    expect(context).toContain("Fix the bug in auth.js");
    expect(context).toContain("Try a different approach");
  });

  it("includes tool call events with names", function () {
    var context = buildQAContext(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    expect(context).toContain("[tool] view");
    expect(context).toContain("[tool] edit");
    expect(context).toContain("[tool] bash");
  });

  it("marks errors in tool calls", function () {
    var context = buildQAContext(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    expect(context).toContain("(ERROR)");
  });

  it("includes reasoning events", function () {
    var context = buildQAContext(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    expect(context).toContain("[reasoning]");
    expect(context).toContain("token validation");
  });

  it("includes output events", function () {
    var context = buildQAContext(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    expect(context).toContain("[output]");
    expect(context).toContain("All tests pass");
  });

  it("handles empty sessions gracefully", function () {
    var context = buildQAContext([], [], {});
    expect(context).toContain("SESSION OVERVIEW");
    expect(context).toContain("Turns: 0");
  });

  it("handles null inputs gracefully", function () {
    var context = buildQAContext(null, null, null);
    expect(context).toContain("SESSION OVERVIEW");
  });

  it("respects character budget by truncating long sessions", function () {
    // Create a large session with many turns
    var manyEvents = [];
    var manyTurns = [];
    for (var i = 0; i < 200; i++) {
      manyEvents.push({
        t: i, agent: "assistant", track: "reasoning",
        text: "This is a very long reasoning message that takes up space ".repeat(10),
        duration: 1, intensity: 0.5, isError: false, turnIndex: i,
      });
      manyTurns.push({
        index: i, startTime: i, endTime: i + 1,
        eventIndices: [i], userMessage: "Question " + i,
      });
    }

    var context = buildQAContext(manyEvents, manyTurns, SAMPLE_METADATA);
    expect(context.length).toBeLessThan(30000);
    expect(context).toContain("truncated");
  });
});

describe("buildQAPrompt", function () {
  it("returns system and user fields", function () {
    var prompt = buildQAPrompt("What tools were used?", "some context");
    expect(prompt).toHaveProperty("system");
    expect(prompt).toHaveProperty("user");
    expect(prompt.user).toBe("What tools were used?");
  });

  it("instructs the model to cite turn numbers", function () {
    var prompt = buildQAPrompt("question", "context");
    expect(prompt.system).toContain("[Turn");
  });

  it("instructs the model to answer based on session data only", function () {
    var prompt = buildQAPrompt("question", "context");
    expect(prompt.system).toContain("session data");
  });

  it("embeds the context in the system prompt", function () {
    var context = buildQAContext(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    var prompt = buildQAPrompt("What happened?", context);
    expect(prompt.system).toContain("SESSION OVERVIEW");
    expect(prompt.system).toContain("Turn 0");
  });
});
