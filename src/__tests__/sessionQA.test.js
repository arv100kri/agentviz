import { describe, it, expect } from "vitest";
import {
  buildQAContext,
  buildQAPrompt,
  parseDetailRequests,
  buildDetailResponse,
  buildToolCallLedger,
  buildRawJsonlRecordIndex,
  buildToolCallRawLookup,
  extractToolCallEntities,
  classifyToolCall,
  buildToolCallSearchIndex,
  getToolCallRawSlice,
  findToolCallRawSlices,
  findToolCallEntries,
  sliceRawJsonlRange,
  buildSessionSummaryChunks,
  buildTurnSummaries,
  buildSessionQAArtifacts,
  buildSessionQAProgramCacheKey,
  classifySessionQAQuestion,
  compileSessionQAQueryProgram,
  routeSessionQAQuestion,
  scanRawJsonlQuestionMatches,
  generateBroadQueryRewrites,
  selectDiverseChunksFromRewrites,
} from "../../src/lib/sessionQA.js";

var SAMPLE_EVENTS = [
  { t: 0, agent: "user", track: "context", text: "Fix the bug in auth.js", duration: 0, intensity: 0.5, isError: false, turnIndex: 0 },
  { t: 1, agent: "assistant", track: "reasoning", text: "I think the issue is in the token validation logic", duration: 2, intensity: 0.8, isError: false, turnIndex: 0 },
  { t: 3, agent: "assistant", track: "tool_call", text: "Reading auth.js", duration: 1, intensity: 1, toolName: "view", toolInput: { path: "src/auth.js" }, isError: false, turnIndex: 0 },
  { t: 4, agent: "assistant", track: "tool_call", text: "Editing auth.js", duration: 1, intensity: 1, toolName: "edit", toolInput: { path: "src/auth.js" }, isError: false, turnIndex: 0 },
  { t: 5, agent: "assistant", track: "tool_call", text: "npm test failed with exit code 1", duration: 2, intensity: 1, toolName: "bash", toolInput: { command: "npm test" }, isError: true, turnIndex: 0 },
  { t: 8, agent: "user", track: "context", text: "Try a different approach", duration: 0, intensity: 0.5, isError: false, turnIndex: 1 },
  { t: 9, agent: "assistant", track: "tool_call", text: "Editing auth.js", duration: 1, intensity: 1, toolName: "edit", toolInput: { path: "src/auth.js" }, isError: false, turnIndex: 1 },
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

var QUESTION_FOCUS_EVENTS = SAMPLE_EVENTS.concat([
  { t: 12, agent: "user", track: "context", text: "Check issue tracker for auth regressions", duration: 0, intensity: 0.5, isError: false, turnIndex: 2 },
  {
    t: 13,
    agent: "assistant",
    track: "tool_call",
    text: "Searching issues for auth regression reports",
    duration: 1,
    intensity: 1,
    toolName: "github-mcp-server-search_issues",
    toolInput: { query: "label:bug repo:github/copilot-cli auth regression" },
    isError: false,
    turnIndex: 2,
  },
]);

var QUESTION_FOCUS_TURNS = SAMPLE_TURNS.concat([
  {
    index: 2,
    startTime: 12,
    endTime: 14,
    eventIndices: [8, 9],
    userMessage: "Check issue tracker for auth regressions",
    toolCount: 1,
    hasError: false,
  },
]);

var QUESTION_FOCUS_METADATA = {
  totalEvents: 10,
  totalTurns: 3,
  totalToolCalls: 5,
  errorCount: 1,
  duration: 14,
  primaryModel: "claude-sonnet-4",
  format: "copilot-cli",
  tokenUsage: { inputTokens: 5200, outputTokens: 2200 },
};

function buildLargeFocusedSession() {
  var events = [];
  var turns = [];

  for (var i = 0; i < 40; i++) {
    var base = i * 3;
    var path = "src/file-" + i + ".js";
    events.push({
      t: base,
      agent: "user",
      track: "context",
      text: "Inspect " + path,
      duration: 0,
      intensity: 0.5,
      isError: false,
      turnIndex: i,
    });
    events.push({
      t: base + 1,
      agent: "assistant",
      track: "tool_call",
      text: i === 37 ? "Failed to update " + path : "Opened " + path,
      duration: 1,
      intensity: 1,
      toolName: i % 2 === 0 ? "view" : "edit",
      toolInput: { path: path },
      isError: i === 37,
      turnIndex: i,
    });
    events.push({
      t: base + 2,
      agent: "assistant",
      track: "output",
      text: i === 37 ? "Patch failed because validator stayed stale" : "Completed work on " + path,
      duration: 0,
      intensity: 0.4,
      isError: false,
      turnIndex: i,
    });
    turns.push({
      index: i,
      startTime: base,
      endTime: base + 2,
      eventIndices: [base, base + 1, base + 2],
      userMessage: "Inspect " + path,
      toolCount: 1,
      hasError: i === 37,
    });
  }

  return {
    events: events,
    turns: turns,
    metadata: {
      totalEvents: events.length,
      totalTurns: turns.length,
      totalToolCalls: turns.length,
      errorCount: 1,
      duration: 120,
      primaryModel: "claude-sonnet-4",
      format: "copilot-cli",
    },
  };
}

var SEARCH_EVENTS = [
  { t: 0, agent: "user", track: "context", text: "Search the codebase and run tests", duration: 0, intensity: 0.5, isError: false, turnIndex: 0 },
  { t: 1, agent: "assistant", track: "tool_call", text: "Searching for token validation", duration: 1, intensity: 1, toolName: "rg", toolInput: { pattern: "token validation", path: "src/auth.js" }, isError: false, turnIndex: 0 },
  { t: 2, agent: "assistant", track: "tool_call", text: "Running npm test -- --runInBand", duration: 1, intensity: 1, toolName: "bash", toolInput: { command: "npm test -- --runInBand" }, isError: false, turnIndex: 0 },
  { t: 3, agent: "user", track: "context", text: "Check issue tracker", duration: 0, intensity: 0.5, isError: false, turnIndex: 1 },
  { t: 4, agent: "assistant", track: "tool_call", text: "Searching issues", duration: 1, intensity: 1, toolName: "github-mcp-server-search_issues", toolInput: { query: "label:bug repo:github/copilot-cli auth failure" }, isError: false, turnIndex: 1 },
];

var SEARCH_TURNS = [
  { index: 0, startTime: 0, endTime: 2, eventIndices: [0, 1, 2], userMessage: "Search the codebase and run tests", toolCount: 2, hasError: false },
  { index: 1, startTime: 3, endTime: 4, eventIndices: [3, 4], userMessage: "Check issue tracker", toolCount: 1, hasError: false },
];

var ENTITY_EVENTS = [
  {
    t: 0,
    agent: "assistant",
    track: "tool_call",
    text: "Found issue details at https://github.com/github/copilot-cli/issues/123 and https://example.com/logs/123",
    duration: 1,
    intensity: 1,
    toolName: "github-mcp-server-search_issues",
    toolInput: {
      query: "repo:github/copilot-cli label:bug #123 PR #45",
      nested: {
        command: "npm test -- src/__tests__/sessionQA.test.js",
        url: "https://github.com/github/copilot-cli/pull/45",
      },
      cwd: "src/lib",
    },
    isError: false,
    turnIndex: 0,
  },
  {
    t: 1,
    agent: "assistant",
    track: "tool_call",
    text: "Running npm test -- src/__tests__/sessionQA.test.js",
    duration: 1,
    intensity: 1,
    toolName: "bash",
    toolInput: {
      command: "npm test -- src/__tests__/sessionQA.test.js",
    },
    isError: false,
    turnIndex: 1,
  },
];

var ENTITY_TURNS = [
  { index: 0, startTime: 0, endTime: 1, eventIndices: [0], userMessage: "Inspect issue references", toolCount: 1, hasError: false },
  { index: 1, startTime: 1, endTime: 2, eventIndices: [1], userMessage: "Run the focused test file", toolCount: 1, hasError: false },
];

var RAW_DETAIL_RECORD_SOURCES = [
  {
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "tool.execution_start",
    data: {
      toolCallId: "call-1",
      toolName: "bash",
      arguments: { command: "npm test" },
    },
  },
  {
    timestamp: "2026-01-01T00:00:01.000Z",
    type: "tool.execution_complete",
    data: {
      toolCallId: "call-1",
      success: false,
      result: { content: "npm test failed" },
    },
  },
  {
    timestamp: "2026-01-01T00:00:02.000Z",
    type: "tool.execution_start",
    data: {
      toolCallId: "call-2",
      toolName: "view",
      arguments: { path: "src/auth.js" },
    },
  },
  {
    timestamp: "2026-01-01T00:00:03.000Z",
    type: "tool.execution_complete",
    data: {
      toolCallId: "call-2",
      success: true,
      result: { content: "export function login() {}" },
    },
  },
];

var RAW_DETAIL_JSONL = RAW_DETAIL_RECORD_SOURCES
  .map(function (record) { return JSON.stringify(record); })
  .join("\n");

var RAW_DETAIL_RECORDS = RAW_DETAIL_JSONL
  .split("\n")
  .map(function (line) { return JSON.parse(line); });

var RAW_DETAIL_EVENTS = [
  {
    t: 0,
    agent: "assistant",
    track: "tool_call",
    text: "npm test failed with exit code 1",
    duration: 1,
    intensity: 1,
    toolName: "bash",
    toolInput: { command: "npm test" },
    raw: RAW_DETAIL_RECORDS[0],
    isError: true,
    turnIndex: 0,
  },
  {
    t: 1,
    agent: "assistant",
    track: "tool_call",
    text: "Reading src/auth.js",
    duration: 1,
    intensity: 1,
    toolName: "view",
    toolInput: { path: "src/auth.js" },
    raw: null,
    isError: false,
    turnIndex: 1,
  },
];

var RAW_DETAIL_TURNS = [
  { index: 0, startTime: 0, endTime: 1, eventIndices: [0], userMessage: "Run the tests", toolCount: 1, hasError: true },
  { index: 1, startTime: 1, endTime: 2, eventIndices: [1], userMessage: "Inspect auth.js", toolCount: 1, hasError: false },
];

describe("extractToolCallEntities", function () {
  it("extracts nested commands, repos, identifiers, urls, and paths from text", function () {
    var entities = extractToolCallEntities(ENTITY_EVENTS[0].toolInput, ENTITY_EVENTS[0].text);

    expect(entities.commands).toContain("npm test -- src/__tests__/sessionQA.test.js");
    expect(entities.paths).toEqual(expect.arrayContaining(["src/lib", "src/__tests__/sessionQA.test.js"]));
    expect(entities.urls).toEqual(expect.arrayContaining([
      "https://github.com/github/copilot-cli/pull/45",
      "https://github.com/github/copilot-cli/issues/123",
      "https://example.com/logs/123",
    ]));
    expect(entities.repos).toEqual(expect.arrayContaining(["github/copilot-cli"]));
    expect(entities.identifiers).toEqual(expect.arrayContaining(["#123", "PR #45"]));
  });
});

describe("buildToolCallLedger", function () {
  it("normalizes tool calls into ledger entries", function () {
    var ledger = buildToolCallLedger(SAMPLE_EVENTS, SAMPLE_TURNS);
    expect(ledger).toHaveLength(4);
    expect(ledger[0]).toMatchObject({
      turnIndex: 0,
      turnToolIndex: 0,
      toolName: "view",
      inputText: "src/auth.js",
      outputText: "Reading auth.js",
      userMessage: "Fix the bug in auth.js",
      isError: false,
    });
    expect(ledger[0].classification).toMatchObject({
      payloadType: "path",
      operation: "read",
    });
    expect(ledger[0].entities.paths).toEqual(["src/auth.js"]);

    expect(ledger[2].classification).toMatchObject({
      payloadType: "command",
      operation: "execute",
    });
    expect(ledger[2].entities.commands).toEqual(["npm test"]);
    expect(ledger[2].id).toContain("turn-0-tool-2-event-4");
  });

  it("attaches raw line-range slices when JSONL text is available", function () {
    var ledger = buildToolCallLedger(RAW_DETAIL_EVENTS, RAW_DETAIL_TURNS, { rawText: RAW_DETAIL_JSONL });

    expect(ledger[0].rawSlice).toMatchObject({
      lineStart: 1,
      lineEnd: 2,
      startRecordIndex: 0,
      endRecordIndex: 1,
      strategy: "tool_call_id",
    });
    expect(ledger[0].rawSlice.text).toContain("\"tool.execution_start\"");
    expect(ledger[0].rawSlice.text).toContain("\"tool.execution_complete\"");

    expect(ledger[1].rawSlice).toMatchObject({
      lineStart: 3,
      lineEnd: 4,
      strategy: "signature",
    });
  });
});

describe("classifyToolCall", function () {
  it("classifies command, query, write, and fetch buckets", function () {
    expect(classifyToolCall("bash", { command: "npm test" })).toMatchObject({
      payloadType: "command",
      operation: "execute",
      buckets: expect.arrayContaining(["command", "execute"]),
    });

    expect(classifyToolCall("rg", { pattern: "token validation", path: "src/auth.js" })).toMatchObject({
      payloadType: "query",
      operation: "search",
      buckets: expect.arrayContaining(["query", "search", "path"]),
    });

    expect(classifyToolCall("edit", { path: "src/auth.js", oldString: "foo", newString: "bar" })).toMatchObject({
      payloadType: "content",
      operation: "write",
      buckets: expect.arrayContaining(["content", "write", "path"]),
    });

    expect(classifyToolCall("web_fetch", { url: "https://example.com" })).toMatchObject({
      payloadType: "url",
      operation: "fetch",
      buckets: expect.arrayContaining(["url", "fetch"]),
    });
  });
});

describe("tool call search index", function () {
  it("retrieves exact command-like entries from indexed data", function () {
    var ledger = buildToolCallLedger(SEARCH_EVENTS, SEARCH_TURNS);
    var index = buildToolCallSearchIndex(ledger);
    var matches = findToolCallEntries(index, "npm test -- --runInBand", { scopes: ["command"] });
    expect(matches).toHaveLength(1);
    expect(matches[0].toolName).toBe("bash");
    expect(matches[0].turnIndex).toBe(0);
  });

  it("retrieves exact query-like entries from indexed data", function () {
    var ledger = buildToolCallLedger(SEARCH_EVENTS, SEARCH_TURNS);
    var index = buildToolCallSearchIndex(ledger);
    var matches = findToolCallEntries(index, "label:bug repo:github/copilot-cli auth failure", { scopes: ["query"] });
    expect(matches).toHaveLength(1);
    expect(matches[0].toolName).toBe("github-mcp-server-search_issues");
    expect(matches[0].turnIndex).toBe(1);
  });

  it("retrieves exact path entities from indexed data", function () {
    var ledger = buildToolCallLedger(SAMPLE_EVENTS, SAMPLE_TURNS);
    var index = buildToolCallSearchIndex(ledger);
    var matches = findToolCallEntries(index, "src/auth.js", { scopes: ["path"] });
    expect(matches.map(function (entry) { return entry.toolName; })).toEqual(["view", "edit", "edit"]);
  });

  it("retrieves repo, tool, and bucket matches from indexed data", function () {
    var ledger = buildToolCallLedger(ENTITY_EVENTS, ENTITY_TURNS);
    var index = buildToolCallSearchIndex(ledger);

    expect(findToolCallEntries(index, "github/copilot-cli", { scopes: ["repo"] })).toHaveLength(1);
    expect(findToolCallEntries(index, "bash", { scopes: ["tool"] })).toHaveLength(1);
    expect(findToolCallEntries(index, "execute", { scopes: ["bucket"] })).toHaveLength(1);
    expect(findToolCallEntries(index, "1", { scopes: ["turn"] })[0].toolName).toBe("bash");
  });
});

describe("buildTurnSummaries", function () {
  it("creates compact per-turn summaries", function () {
    var summaries = buildTurnSummaries(SAMPLE_EVENTS, SAMPLE_TURNS);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      turnIndex: 0,
      toolCount: 3,
      hasError: true,
      errorCount: 1,
    });
    expect(summaries[0].toolNames).toEqual(["view", "edit", "bash"]);
    expect(summaries[0].focusEntities).toEqual(["src/auth.js", "npm test"]);
    expect(summaries[0].eventCount).toBe(5);
    expect(summaries[0].summary).toContain("Fix the bug in auth.js");
    expect(summaries[0].summary).toContain("tools: view, edit, bash");
    expect(summaries[0].summary).toContain("focus: src/auth.js, npm test");
    expect(summaries[0].summary).toContain("errors: 1");
    expect(summaries[1].summary).toContain("All tests pass now");
  });

  it("derives summaries from events when turns are unavailable", function () {
    var summaries = buildTurnSummaries(SAMPLE_EVENTS, null);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].userMessage).toBe("Fix the bug in auth.js");
    expect(summaries[1].toolNames).toEqual(["edit"]);
    expect(summaries[1].summary).toContain("Try a different approach");
  });
});

describe("buildSessionQAArtifacts", function () {
  it("reuses cached artifacts for the same session arrays", function () {
    var first = buildSessionQAArtifacts(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    var second = buildSessionQAArtifacts(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    expect(second).toBe(first);
    expect(second.ledger).toBe(first.ledger);
    expect(second.turnSummaries).toBe(first.turnSummaries);
    expect(second.turnRecords).toBe(first.turnRecords);
  });

  it("stores raw lookups when JSONL text is provided", function () {
    var artifacts = buildSessionQAArtifacts(RAW_DETAIL_EVENTS, RAW_DETAIL_TURNS, null, {
      rawText: RAW_DETAIL_JSONL,
    });

    expect(artifacts.rawLookup).toBeTruthy();
    expect(artifacts.rawLookup.matchedCount).toBe(2);
    expect(artifacts.ledger[0].rawSlice.lineStart).toBe(1);
    expect(artifacts.ledger[1].rawSlice.lineEnd).toBe(4);
  });

  it("precomputes metric facts and bounded summary chunks", function () {
    var artifacts = buildSessionQAArtifacts(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);

    expect(artifacts.metricCatalog).toBeTruthy();
    expect(artifacts.metricCatalog.totalToolCalls).toBe(4);
    expect(artifacts.metricCatalog.topTools[0]).toEqual({ name: "edit", count: 2 });
    expect(artifacts.metricCatalog.longestAutonomousRun).toMatchObject({
      turnIndex: 0,
      duration: 7,
    });
    expect(artifacts.summaryChunks).toHaveLength(1);
    expect(artifacts.summaryChunks[0].turnIndices).toEqual([0, 1]);
    expect(artifacts.summaryChunks[0].summary).toContain("Turn 0");
  });
});

describe("classifySessionQAQuestion", function () {
  it("classifies specific command, path, and error questions", function () {
    var artifacts = buildSessionQAArtifacts(QUESTION_FOCUS_EVENTS, QUESTION_FOCUS_TURNS, QUESTION_FOCUS_METADATA);
    var profile = classifySessionQAQuestion("Why did npm test fail in src/auth.js?", { artifacts: artifacts });

    expect(profile.scopes).toEqual(expect.arrayContaining(["command", "path", "error"]));
    expect(profile.broadSummary).toBe(false);
    expect(profile.confidence).toBe("high");
    expect(profile.matchers.map(function (matcher) { return matcher.value; }))
      .toEqual(expect.arrayContaining(["npm test", "src/auth.js"]));
  });
});

describe("compileSessionQAQueryProgram", function () {
  it("compiles metric questions into stable metric-family programs", function () {
    var artifacts = buildSessionQAArtifacts(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    var firstProgram = compileSessionQAQueryProgram(
      "How long was the longest autonomous agent run in this session?",
      artifacts
    );
    var paraphrasedProgram = compileSessionQAQueryProgram(
      "What was the duration of the longest autonomous run?",
      artifacts
    );

    expect(firstProgram.family).toBe("metric");
    expect(firstProgram.slots.metricKey).toBe("longest-autonomous-run");
    expect(
      buildSessionQAProgramCacheKey(firstProgram, { fingerprint: "session-1" })
    ).toBe(
      buildSessionQAProgramCacheKey(paraphrasedProgram, { fingerprint: "session-1" })
    );
  });

  it("compiles turn lookups with deterministic slots", function () {
    var artifacts = buildSessionQAArtifacts(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    var program = compileSessionQAQueryProgram("What happened in Turn 1?", artifacts);

    expect(program.family).toBe("turn-lookup");
    expect(program.deterministic).toBe(true);
    expect(program.slots.turnHints).toEqual([1]);
  });

  it("marks broad summaries as race-eligible fact-store programs", function () {
    var artifacts = buildSessionQAArtifacts(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    var program = compileSessionQAQueryProgram("What was the overall approach?", artifacts);

    expect(program.family).toBe("session-summary");
    expect(program.canAnswerFromFactStore).toBe(true);
    expect(program.raceEligible).toBe(true);
  });
});

describe("routeSessionQAQuestion", function () {
  it("routes longest-autonomous-run questions to precomputed metrics", function () {
    var artifacts = buildSessionQAArtifacts(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    var route = routeSessionQAQuestion("How long was the longest autonomous agent run in this session?", artifacts);

    expect(route.kind).toBe("metric");
    expect(route.phase).toBe("using-precomputed-metrics");
    expect(route.directAnswer).toContain("longest autonomous run lasted 7s");
    expect(route.references).toEqual([{ turnIndex: 0 }]);
  });

  it("routes open-ended summary questions to precomputed summary chunks", function () {
    var artifacts = buildSessionQAArtifacts(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    var route = routeSessionQAQuestion("What was the overall approach?", artifacts);

    expect(route.kind).toBe("chunk");
    expect(route.relevantChunks.length).toBeGreaterThan(0);
    expect(route.detail).toContain("summary chunks");
  });

  it("routes exact-evidence questions to targeted raw slices when available", function () {
    var artifacts = buildSessionQAArtifacts(RAW_DETAIL_EVENTS, RAW_DETAIL_TURNS, null, {
      rawText: RAW_DETAIL_JSONL,
    });
    var route = routeSessionQAQuestion("What exact output did npm test produce in Turn 0?", artifacts, {
      rawText: RAW_DETAIL_JSONL,
      rawIndex: artifacts.rawIndex,
    });

    expect(route.kind).toBe("raw-targeted");
    expect(route.relevantEntries[0].toolName).toBe("bash");
    expect(route.relevantEntries[0].rawSlice.text).toContain("\"toolCallId\":\"call-1\"");
  });
});

describe("turn-range and chunk diversity", function () {
  it("classifies out-of-range turn hints", function () {
    var artifacts = buildSessionQAArtifacts(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    var program = compileSessionQAQueryProgram("What happened in Turn 99?", artifacts);
    expect(program.family).toBe("turn-lookup");
    expect(program.slots.turnHints).toEqual([99]);
  });

  it("detects early-session intent in question profile", function () {
    var profile = classifySessionQAQuestion("What happened first in this session?");
    expect(profile.wantsEarlySession).toBe(true);
    expect(profile.wantsLateSession).toBeFalsy();
  });

  it("detects late-session intent in question profile", function () {
    var profile = classifySessionQAQuestion("What was the final outcome?");
    expect(profile.wantsLateSession).toBe(true);
    expect(profile.wantsEarlySession).toBeFalsy();
  });

  it("generates broad query rewrites only for broad-summary questions", function () {
    var broadProfile = classifySessionQAQuestion("What was the overall approach?");
    var rewrites = generateBroadQueryRewrites("What was the overall approach?", broadProfile);
    expect(rewrites.length).toBeGreaterThan(0);

    var narrowProfile = classifySessionQAQuestion("What error occurred in Turn 1?");
    var narrowRewrites = generateBroadQueryRewrites("What error occurred in Turn 1?", narrowProfile);
    expect(narrowRewrites).toEqual([]);
  });

  it("selects diverse chunks from rewrites without duplicates", function () {
    var events = [];
    var turns = [];
    // Build a synthetic session with 20 turns across 4 chunks
    for (var i = 0; i < 20; i++) {
      events.push({ t: i * 10, agent: i % 5 === 0 ? "user" : "assistant", track: i % 3 === 0 ? "tool_call" : "reasoning", text: "Event " + i, duration: 5, intensity: 0.5, isError: i === 15, turnIndex: i, toolName: i % 3 === 0 ? "bash" : undefined, toolInput: i % 3 === 0 ? { command: "test " + i } : undefined });
      turns.push({ index: i, startTime: i * 10, endTime: i * 10 + 9, eventIndices: [i], userMessage: "Turn " + i + " message", toolCount: i % 3 === 0 ? 1 : 0, hasError: i === 15 });
    }
    var metadata = { totalEvents: 20, totalTurns: 20, totalToolCalls: 7, errorCount: 1, duration: 200, format: "copilot-cli" };
    var artifacts = buildSessionQAArtifacts(events, turns, metadata);
    expect(artifacts.summaryChunks.length).toBeGreaterThan(1);

    var profile = classifySessionQAQuestion("What was the overall approach?", { artifacts: artifacts });
    var rewrites = generateBroadQueryRewrites("What was the overall approach?", profile);
    var chunks = selectDiverseChunksFromRewrites(artifacts, profile, rewrites, 4);

    // Should not have duplicate chunk indices
    var indices = chunks.map(function (c) { return c.chunkIndex; });
    var uniqueIndices = indices.filter(function (v, i, a) { return a.indexOf(v) === i; });
    expect(uniqueIndices.length).toBe(indices.length);
  });

  it("includes metric turn-count answer with zero-based guidance", function () {
    var artifacts = buildSessionQAArtifacts(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    var route = routeSessionQAQuestion("How many turns are in this session?", artifacts);
    expect(route.kind).toBe("metric");
    expect(route.directAnswer).toContain("2 turns");
    expect(route.directAnswer).toContain("zero-based");
  });
});

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
    expect(context).toContain("TURN SUMMARIES");
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
    expect(context).toContain("Turns: 0");
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
    expect(context.length).toBeLessThan(70000);
    expect(context).toMatch(/truncated/i);
  });

  it("includes a tool frequency ranking section", function () {
    var context = buildQAContext(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    expect(context).toContain("TOOL USAGE");
    // edit appears 2 times (turnIndex 0 and 1), view 1, bash 1
    expect(context).toContain("edit: 2 calls");
    expect(context).toContain("view: 1 calls");
    expect(context).toContain("bash: 1 calls");
  });

  it("includes an errors summary section", function () {
    var context = buildQAContext(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    expect(context).toContain("ERRORS");
    expect(context).toContain("bash");
    expect(context).toContain("npm test failed");
  });

  it("derives turn context when turn metadata is unavailable", function () {
    var context = buildQAContext(SAMPLE_EVENTS, null, null);
    expect(context).toContain("Turns: 2");
    expect(context).toContain("--- Turn 0 ---");
    expect(context).toContain("--- Turn 1 ---");
    expect(context).toContain("[tool] bash");
  });

  it("builds a question-aware focused context with relevant tool calls and nearby turns", function () {
    var focusedContext = buildQAContext(QUESTION_FOCUS_EVENTS, QUESTION_FOCUS_TURNS, QUESTION_FOCUS_METADATA, {
      question: "Why did npm test fail in src/auth.js?",
    });

    expect(focusedContext).toContain("QUESTION FOCUS");
    expect(focusedContext).toContain("MATCHING TOOL CALLS");
    expect(focusedContext).toContain("Turn 0 | bash (ERROR)");
    expect(focusedContext).toContain("Input: src/auth.js");
    expect(focusedContext).toContain("=== RELEVANT TURNS ===");
    expect(focusedContext).toContain("=== NEARBY TURN SUMMARIES ===");
    expect(focusedContext).not.toContain("Turn 2 | github-mcp-server-search_issues");
    expect(focusedContext).not.toContain("=== TURNS ===");
  });

  it("keeps focused retrieval bounded for large sessions", function () {
    var largeSession = buildLargeFocusedSession();
    var fullContext = buildQAContext(largeSession.events, largeSession.turns, largeSession.metadata);
    var focusedContext = buildQAContext(largeSession.events, largeSession.turns, largeSession.metadata, {
      question: "Why did turn 37 fail for src/file-37.js?",
    });

    expect(focusedContext.length).toBeLessThan(fullContext.length);
    expect(focusedContext).toContain("--- Turn 37 ---");
    expect(focusedContext).toContain("Turn 36");
    expect(focusedContext).toContain("Turn 38");
    expect(focusedContext).not.toContain("src/file-0.js");
  });

  it("falls back to a bounded summary for open-ended questions", function () {
    var context = buildQAContext(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA, {
      question: "What was the overall approach?",
    });

    expect(context).toContain("QUESTION FOCUS");
    expect(context).toContain("Confidence: low");
    expect(context).toContain("Fallback: broader summary coverage included.");
    expect(context).toContain("TOOL USAGE");
    expect(context).toContain("TURN SUMMARIES");
    expect(context).not.toContain("=== TURNS ===");
  });

  it("renders summary chunk context when the router selects chunk retrieval", function () {
    var artifacts = buildSessionQAArtifacts(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    var route = routeSessionQAQuestion("What was the overall approach?", artifacts);
    var context = buildQAContext(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA, {
      question: "What was the overall approach?",
      artifacts: artifacts,
      route: route,
    });

    expect(context).toContain("Route: summary chunks");
    expect(context).toContain("MATCHING SUMMARY CHUNKS");
    expect(context).not.toContain("=== TURNS ===");
  });

  it("renders targeted raw-slice context when the router selects exact raw evidence", function () {
    var artifacts = buildSessionQAArtifacts(RAW_DETAIL_EVENTS, RAW_DETAIL_TURNS, null, {
      rawText: RAW_DETAIL_JSONL,
    });
    var route = routeSessionQAQuestion("What exact output did npm test produce in Turn 0?", artifacts, {
      rawText: RAW_DETAIL_JSONL,
      rawIndex: artifacts.rawIndex,
    });
    var context = buildQAContext(RAW_DETAIL_EVENTS, RAW_DETAIL_TURNS, null, {
      question: "What exact output did npm test produce in Turn 0?",
      artifacts: artifacts,
      route: route,
    });

    expect(context).toContain("Route: targeted raw slices");
    expect(context).toContain("MATCHING RAW JSONL SLICES");
    expect(context).toContain("call-1");
  });

  it("re-slices raw JSONL when hydrated artifacts omit inline raw slice text", function () {
    var artifacts = buildSessionQAArtifacts(RAW_DETAIL_EVENTS, RAW_DETAIL_TURNS, null, {
      rawText: RAW_DETAIL_JSONL,
    });
    var route = routeSessionQAQuestion("What exact output did npm test produce in Turn 0?", artifacts, {
      rawText: RAW_DETAIL_JSONL,
      rawIndex: artifacts.rawIndex,
    });
    var compactLedger = artifacts.ledger.map(function (entry) {
      var cloned = JSON.parse(JSON.stringify(entry));
      if (cloned.rawSlice) delete cloned.rawSlice.text;
      return cloned;
    });
    var compactArtifacts = {
      turnRecords: artifacts.turnRecords,
      ledger: compactLedger,
      ledgerIndex: buildToolCallSearchIndex(compactLedger),
      turnSummaries: artifacts.turnSummaries,
      summaryChunks: artifacts.summaryChunks,
      stats: artifacts.stats,
      metricCatalog: artifacts.metricCatalog,
      rawLookup: {
        rawText: RAW_DETAIL_JSONL,
        ledger: compactLedger,
        ledgerIndex: buildToolCallSearchIndex(compactLedger),
      },
      rawIndex: null,
    };
    var compactRoute = Object.assign({}, route, {
      relevantEntries: [compactLedger[0]],
    });
    var context = buildQAContext(RAW_DETAIL_EVENTS, RAW_DETAIL_TURNS, null, {
      question: "What exact output did npm test produce in Turn 0?",
      artifacts: compactArtifacts,
      route: compactRoute,
    });

    expect(context).toContain("MATCHING RAW JSONL SLICES");
    expect(context).toContain("\"tool.execution_start\"");
    expect(context).toContain("\"tool.execution_complete\"");
  });
});

describe("buildQAPrompt", function () {
  it("returns system and user fields", function () {
    var prompt = buildQAPrompt("What tools were used?", "some context");
    expect(prompt).toHaveProperty("system");
    expect(prompt).toHaveProperty("user");
    expect(prompt.user).toContain("What tools were used?");
    expect(prompt.user).toContain("SESSION DATA:");
  });

  it("instructs the model to cite turn numbers", function () {
    var prompt = buildQAPrompt("question", "context");
    expect(prompt.system).toContain("[Turn");
  });

  it("instructs the model to answer based on session data only", function () {
    var prompt = buildQAPrompt("question", "context");
    expect(prompt.system).toContain("session data");
  });

  it("embeds the context in the user message", function () {
    var context = buildQAContext(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    var prompt = buildQAPrompt("What happened?", context);
    expect(prompt.user).toContain("SESSION OVERVIEW");
    expect(prompt.user).toContain("Turn 0");
    expect(prompt.user).toContain("QUESTION: What happened?");
  });

  it("includes NEED_DETAIL instructions in the system prompt", function () {
    var prompt = buildQAPrompt("question", "context");
    expect(prompt.system).toContain("NEED_DETAIL");
  });

  it("allows raw session file reads when a session file path is provided", function () {
    var prompt = buildQAPrompt("question", "context", {
      sessionFilePath: "C:\\sessions\\agentviz.jsonl",
    });
    expect(prompt.system).toContain("file-search and file-read tools");
    expect(prompt.system).not.toContain("DO NOT use any tools");
    expect(prompt.user).toContain("FULL SESSION FILE ACCESS");
    expect(prompt.user).toContain("C:\\sessions\\agentviz.jsonl");
  });

  it("prefers the structured summary first for broad questions even when raw file access is available", function () {
    var prompt = buildQAPrompt("What was the overall approach?", "context", {
      sessionFilePath: "C:\\sessions\\agentviz.jsonl",
    });

    expect(prompt.user).toContain("Use the structured session data below first.");
    expect(prompt.system).toContain("do NOT inspect the raw file or request NEED_DETAIL");
    expect(prompt.system).toContain("Do not request extra detail just to confirm");
  });

  it("keeps exact-evidence raw file guidance for specific tool questions", function () {
    var prompt = buildQAPrompt("What grep query was run against src/auth.js?", "context", {
      sessionFilePath: "C:\\sessions\\agentviz.jsonl",
    });

    expect(prompt.user).toContain("Use the retrieved snippets in the structured session data below first.");
    expect(prompt.user).toContain("only if exact tool input/output is still missing or truncated");
  });

  it("still forbids tool use when no session file path is provided", function () {
    var prompt = buildQAPrompt("question", "context");
    expect(prompt.system).toContain("DO NOT use any tools");
    expect(prompt.user).not.toContain("FULL SESSION FILE ACCESS");
  });
});

describe("tool I/O in context", function () {
  it("includes tool input in per-turn events", function () {
    var context = buildQAContext(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    expect(context).toContain("Input: npm test");
    expect(context).toContain("Input: src/auth.js");
  });

  it("includes tool output in per-turn events", function () {
    var context = buildQAContext(SAMPLE_EVENTS, SAMPLE_TURNS, SAMPLE_METADATA);
    expect(context).toContain("Output: npm test failed");
    expect(context).toContain("Output: Reading auth.js");
  });
});

describe("parseDetailRequests", function () {
  it("parses single NEED_DETAIL marker", function () {
    var reqs = parseDetailRequests("[NEED_DETAIL: Turn 5, powershell]");
    expect(reqs).toEqual([{ turnIndex: 5, toolName: "powershell" }]);
  });

  it("parses multiple NEED_DETAIL markers", function () {
    var text = "I need more info.\n[NEED_DETAIL: Turn 3, kusto]\n[NEED_DETAIL: Turn 7, bash]\nThanks.";
    var reqs = parseDetailRequests(text);
    expect(reqs).toEqual([
      { turnIndex: 3, toolName: "kusto" },
      { turnIndex: 7, toolName: "bash" },
    ]);
  });

  it("returns empty array when no markers present", function () {
    var reqs = parseDetailRequests("This is a normal answer with no markers.");
    expect(reqs).toEqual([]);
  });

  it("handles whitespace variations", function () {
    var reqs = parseDetailRequests("[NEED_DETAIL:  Turn  12 ,  grep ]");
    expect(reqs).toEqual([{ turnIndex: 12, toolName: "grep" }]);
  });
});

describe("raw JSONL detail lookup", function () {
  it("captures record offsets and line metadata from raw JSONL", function () {
    var rawIndex = buildRawJsonlRecordIndex(RAW_DETAIL_JSONL);

    expect(rawIndex.records).toHaveLength(4);
    expect(rawIndex.records[0]).toMatchObject({
      recordIndex: 0,
      lineStart: 1,
      lineEnd: 1,
      charStart: 0,
    });
    expect(rawIndex.toolStartsByCallId["call-1"][0].lineStart).toBe(1);
    expect(rawIndex.toolCompletesByCallId["call-2"][0].lineStart).toBe(4);
    expect(RAW_DETAIL_JSONL.substring(rawIndex.records[0].charStart, rawIndex.records[0].charEnd))
      .toBe(JSON.stringify(RAW_DETAIL_RECORD_SOURCES[0]));
  });

  it("slices targeted raw text from stored range metadata", function () {
    var rawLookup = buildToolCallRawLookup(RAW_DETAIL_EVENTS, RAW_DETAIL_TURNS, RAW_DETAIL_JSONL);
    var bashSlice = findToolCallRawSlices(rawLookup, { turnIndex: 0, toolName: "bash" })[0];

    expect(sliceRawJsonlRange(RAW_DETAIL_JSONL, bashSlice)).toContain("\"toolCallId\":\"call-1\"");
    expect(sliceRawJsonlRange(RAW_DETAIL_JSONL, {
      lineStart: 3,
      lineEnd: 4,
    })).toContain("\"src/auth.js\"");
  });

  it("looks up raw slices for turn and tool requests", function () {
    var rawLookup = buildToolCallRawLookup(RAW_DETAIL_EVENTS, RAW_DETAIL_TURNS, RAW_DETAIL_JSONL);
    var bashSlices = findToolCallRawSlices(rawLookup, { turnIndex: 0, toolName: "bash" });
    var viewSlices = findToolCallRawSlices(rawLookup, { turnIndex: 1, toolName: "view" });

    expect(bashSlices).toHaveLength(1);
    expect(bashSlices[0]).toMatchObject({ lineStart: 1, lineEnd: 2 });
    expect(viewSlices).toHaveLength(1);
    expect(viewSlices[0]).toMatchObject({ lineStart: 3, lineEnd: 4 });
    expect(RAW_DETAIL_JSONL.substring(viewSlices[0].charStart, viewSlices[0].charEnd))
      .toContain("\"src/auth.js\"");
  });

  it("scores raw JSONL records for full-file fallback", function () {
    var rawIndex = buildRawJsonlRecordIndex(RAW_DETAIL_JSONL);
    var matches = scanRawJsonlQuestionMatches(rawIndex, "What did npm test return?", {});

    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some(function (match) {
      return match.text.indexOf("npm test") !== -1;
    })).toBe(true);
  });

  it("retrieves a single targeted raw slice for a chosen tool-call entry", function () {
    var rawLookup = buildToolCallRawLookup(RAW_DETAIL_EVENTS, RAW_DETAIL_TURNS, RAW_DETAIL_JSONL);
    var rawSlice = getToolCallRawSlice(rawLookup, rawLookup.ledger[1]);

    expect(rawSlice).toMatchObject({
      lineStart: 3,
      lineEnd: 4,
      startRecordIndex: 2,
      endRecordIndex: 3,
    });
    expect(rawSlice.text).toContain("\"src/auth.js\"");
  });
});

describe("buildDetailResponse", function () {
  it("returns full I/O for matching events", function () {
    var detail = buildDetailResponse(
      [{ turnIndex: 0, toolName: "bash" }],
      SAMPLE_EVENTS
    );
    expect(detail).toContain("Turn 0, bash");
    expect(detail).toContain("npm test");
    expect(detail).toContain("npm test failed");
  });

  it("handles multiple requests", function () {
    var detail = buildDetailResponse(
      [{ turnIndex: 0, toolName: "view" }, { turnIndex: 0, toolName: "bash" }],
      SAMPLE_EVENTS
    );
    expect(detail).toContain("view");
    expect(detail).toContain("bash");
    expect(detail).toContain("src/auth.js");
  });

  it("reports not found for missing events", function () {
    var detail = buildDetailResponse(
      [{ turnIndex: 99, toolName: "nonexistent" }],
      SAMPLE_EVENTS
    );
    expect(detail).toContain("not found");
  });

  it("is case-insensitive for tool name matching", function () {
    var detail = buildDetailResponse(
      [{ turnIndex: 0, toolName: "BASH" }],
      SAMPLE_EVENTS
    );
    expect(detail).toContain("npm test");
  });

  it("handles empty events array", function () {
    var detail = buildDetailResponse(
      [{ turnIndex: 0, toolName: "bash" }],
      []
    );
    expect(detail).toContain("not found");
  });

  it("includes targeted raw JSONL slices when lookup metadata is available", function () {
    var detail = buildDetailResponse(
      [{ turnIndex: 0, toolName: "bash" }],
      RAW_DETAIL_EVENTS,
      { turns: RAW_DETAIL_TURNS, rawText: RAW_DETAIL_JSONL }
    );

    expect(detail).toContain("Raw JSONL lines 1-2");
    expect(detail).toContain("\"toolCallId\":\"call-1\"");
    expect(detail).toContain("\"tool.execution_complete\"");
  });
});
