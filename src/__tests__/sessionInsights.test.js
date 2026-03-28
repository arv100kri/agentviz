import { describe, expect, it } from "vitest";
import {
  buildCliStats,
  buildCommandsAndQueries,
  buildDigestEvidence,
  buildErrorSummary,
  buildFileAccessSummary,
  renderSessionDigestMarkdown,
} from "../lib/sessionInsights.js";

function makeSession() {
  var events = [
    { t: 0, agent: "user", track: "output", text: "Investigate the login bug", duration: 1, intensity: 0.6, turnIndex: 0, isError: false },
    {
      t: 1,
      agent: "assistant",
      track: "tool_call",
      text: "grep: 'login' in src/",
      duration: 1,
      intensity: 0.6,
      toolName: "grep",
      toolInput: { pattern: "login", path: "src/" },
      toolResultText: "src/auth.js:15: function login() {",
      turnIndex: 0,
      isError: false,
    },
    {
      t: 2,
      agent: "assistant",
      track: "tool_call",
      text: "view: src/auth.js",
      duration: 1,
      intensity: 0.6,
      toolName: "view",
      toolInput: { path: "src/auth.js" },
      toolResultText: "function login() { return auth(); }",
      turnIndex: 0,
      isError: false,
    },
    {
      t: 3,
      agent: "assistant",
      track: "reasoning",
      text: "The auth helper likely returns the wrong value.",
      duration: 1,
      intensity: 0.5,
      turnIndex: 0,
      isError: false,
    },
    {
      t: 4,
      agent: "assistant",
      track: "tool_call",
      text: "edit(src/auth.js)",
      duration: 1,
      intensity: 0.7,
      toolName: "edit",
      toolInput: { path: "src/auth.js", old_str: "return auth()", new_str: "return await auth()" },
      toolResultText: "Patched src/auth.js",
      turnIndex: 0,
      isError: false,
    },
    {
      t: 5,
      agent: "assistant",
      track: "tool_call",
      text: "bash: npm test",
      duration: 1,
      intensity: 0.9,
      toolName: "bash",
      toolInput: { command: "npm test" },
      toolResultText: "FAIL src/auth.test.js: expected login to resolve",
      toolResultIsError: true,
      turnIndex: 0,
      isError: false,
    },
    {
      t: 6,
      agent: "system",
      track: "context",
      text: "Rate limit exceeded",
      duration: 1,
      intensity: 1,
      turnIndex: 0,
      isError: true,
    },
  ];

  var turns = [
    {
      index: 0,
      startTime: 0,
      endTime: 7,
      eventIndices: [0, 1, 2, 3, 4, 5, 6],
      userMessage: "Investigate the login bug",
      toolCount: 4,
      hasError: true,
    },
  ];

  var metadata = {
    format: "copilot-cli",
    primaryModel: "claude-opus-4.6",
    totalTurns: 1,
    totalToolCalls: 4,
    errorCount: 1,
    duration: 7,
    totalCost: 1.25,
    premiumRequests: 2,
    tokenUsage: {
      inputTokens: 1200,
      outputTokens: 350,
      cacheRead: 600,
      cacheWrite: 50,
    },
    codeChanges: {
      filesModified: ["src/auth.js"],
    },
  };

  return { events, turns, metadata };
}

describe("sessionInsights", function () {
  it("builds command and query summaries from tool calls", function () {
    var commands = buildCommandsAndQueries(makeSession().events);
    expect(commands).toHaveLength(2);
    expect(commands[0].kind).toBe("Search pattern");
    expect(commands[0].input).toContain("login");
    expect(commands[1].kind).toBe("Shell command");
    expect(commands[1].resultSummary).toContain("FAIL");
  });

  it("builds file access summaries with views, edits, and summary touches", function () {
    var files = buildFileAccessSummary(makeSession().events, makeSession().metadata);
    var authFile = files.find(function (item) { return item.path === "src/auth.js"; });
    expect(authFile).toBeDefined();
    expect(authFile.views).toBe(1);
    expect(authFile.edits).toBe(1);
    expect(authFile.summaryTouches).toBe(1);
  });

  it("builds a stable stats payload", function () {
    var stats = buildCliStats(makeSession());
    expect(stats.format).toBe("copilot-cli");
    expect(stats.totalToolCalls).toBe(4);
    expect(stats.totalCost).toBe(1.25);
    expect(stats.topTools[0][0]).toBe("bash");
    expect(stats.tokenUsage.cacheRead).toBe(600);
  });

  it("deduplicates tool and non-tool errors into digest-friendly summaries", function () {
    var errors = buildErrorSummary(makeSession().events);
    expect(errors).toHaveLength(2);
    expect(errors[0].toolName).toBe("bash");
    expect(errors[1].message).toContain("Rate limit");
  });

  it("builds digest evidence and renders markdown sections", function () {
    var evidence = buildDigestEvidence(makeSession(), "trace.jsonl");
    var markdown = renderSessionDigestMarkdown(evidence, {
      summary: "The agent traced the login path, edited auth.js, and then hit a failing test plus a rate limit.",
      hypotheses: [{ hypothesis: "login failure is in auth.js", outcome: "confirmed", evidence: "Turn 1 used grep, view, and edit on src/auth.js." }],
      decisions: [{ decision: "Patch src/auth.js first", rationale: "The grep and view results pointed at the auth helper.", evidence: "Turn 1 commands focused on src/auth.js." }],
      questions: [{ question: "What blocked completion?", answer: "A failing npm test plus a later rate limit interruption.", evidence: "Turn 1 bash output failed and the session recorded a rate limit error." }],
    }, {
      sourceFile: "C:\\work\\trace.jsonl",
      model: "copilot-sdk",
    });

    expect(evidence.commands).toHaveLength(2);
    expect(evidence.files[0].path).toBe("src/auth.js");
    expect(markdown).toContain("# Session Digest");
    expect(markdown).toContain("## Queries & Commands");
    expect(markdown).toContain("## Key Decisions");
    expect(markdown).toContain("src/auth.js");
    expect(markdown).toContain("copilot-sdk");
  });
});
