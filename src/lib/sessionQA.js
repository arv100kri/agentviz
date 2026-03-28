import { estimateCost } from "./pricing.js";

/**
 * Session Q&A helpers for compact, retrievable session context.
 *
 * Hybrid retrieval strategy:
 *   Pass 1: Send aggregate stats + per-turn tool index with truncated I/O.
 *   Pass 2: If the model needs full output for specific tool calls, it responds with
 *           [NEED_DETAIL: Turn X, tool_name] markers. The client detects these, resolves
 *           the full event data, and sends a follow-up automatically.
 */

var MAX_CONTEXT_CHARS = 64000;
var MAX_FOCUSED_CONTEXT_CHARS = 22000;
var MAX_INPUT_CHARS = 500;
var MAX_OUTPUT_CHARS = 500;
var MAX_DETAIL_CHARS = 4000;
var MAX_FOCUSED_TOOL_CALLS = 6;
var MAX_FOCUSED_TURNS = 3;
var MAX_FOCUSED_NEIGHBOR_SUMMARIES = 8;
var MAX_FOCUSED_TOOLS_PER_TURN = 4;
var MAX_FOCUSED_MATCH_CHARS = 240;
var MAX_FOCUSED_INPUT_CHARS = 900;
var MAX_FOCUSED_OUTPUT_CHARS = 1400;
var MAX_FOCUSED_TEXT_CHARS = 320;
var MAX_FALLBACK_TOOL_RANKING = 8;
var MAX_FALLBACK_FILE_ENTRIES = 10;
var MAX_FALLBACK_ERRORS = 8;
var MAX_FALLBACK_TURN_SUMMARIES = 10;
var MAX_SUMMARY_CHUNK_CHARS = 1400;
var MAX_SUMMARY_CHUNK_TURNS = 6;
var MAX_SUMMARY_CHUNK_RESULTS = 4;
var MAX_SUMMARY_CHUNK_CONTEXT_CHARS = 7000;
var MAX_RAW_MATCH_RESULTS = 8;
var MAX_RAW_MATCH_CONTEXT_CHARS = 7000;
var MAX_RAW_SLICE_CONTEXT_CHARS = 6000;
var MAX_RAW_SLICE_RESULTS = 4;
var MAX_RAW_MATCH_PREVIEW_CHARS = 900;
var MAX_DIRECT_TOOL_LIST = 5;
var LONG_IDLE_GAP_SECONDS = 30;
var SIGNIFICANT_GAP_SECONDS = 5;
var MAX_BABYSITTING_GAP_SECONDS = 45;
var SESSION_QA_CACHE = new WeakMap();
var QUESTION_STOP_WORDS = buildLookup([
  "a", "about", "all", "an", "and", "around", "be", "did", "do", "does", "for", "from",
  "happen", "happened", "how", "i", "in", "into", "is", "it", "me", "of", "on", "or",
  "show", "tell", "that", "the", "this", "to", "was", "what", "when", "where", "which",
  "who", "why", "with",
]);
var BROAD_SUMMARY_TERMS = buildLookup([
  "approach", "overall", "summary", "summarize", "recap", "timeline", "story",
  "happened", "doing", "did", "goal", "intent",
]);
var EARLY_SESSION_TERMS = buildLookup(["first", "early", "initially", "start", "started", "began", "beginning", "initial", "opening"]);
var LATE_SESSION_TERMS = buildLookup(["last", "final", "end", "ended", "eventually", "concluded", "outcome", "result", "finish", "finished", "closing"]);
var QUERY_HINT_TERMS = buildLookup([
  "search", "searched", "grep", "rg", "query", "queries", "kusto", "lookup", "find",
]);
var COMMAND_HINT_TERMS = buildLookup([
  "bash", "command", "commands", "powershell", "shell", "terminal", "run", "ran", "execute", "executed",
]);
var COMMAND_STOP_WORDS = buildLookup([
  "what", "why", "how", "when", "where", "which", "who", "did", "does", "do", "is", "are", "was", "were",
  "can", "could", "would", "should", "after", "before", "because", "fail", "failed", "failure", "error",
  "errors", "output", "outputs", "result", "results", "return", "returned", "show", "showed", "tool",
  "tools", "query", "queries", "pattern", "patterns", "path", "paths", "file", "files", "session",
  "turn", "turns",
]);
var TOOL_HINT_TERMS = buildLookup([
  "tool", "tools", "used", "usage", "call", "calls",
]);
var PATH_HINT_TERMS = buildLookup([
  "file", "files", "path", "paths", "read", "view", "edit", "edited", "modify", "modified", "write", "wrote", "diff",
]);
var ERROR_HINT_TERMS = buildLookup([
  "error", "errors", "fail", "failed", "failure", "crash", "broken", "issue", "issues", "exception", "stack", "trace",
]);
var EXACT_EVIDENCE_TERMS = buildLookup([
  "exact", "search", "searched", "query", "queries", "command", "commands", "output", "outputs",
  "error", "errors", "log", "logs", "file", "files", "path", "paths", "diff", "grep", "rg", "kusto",
]);
var COMMAND_PREFIXES = buildLookup([
  "npm", "npx", "pnpm", "yarn", "node", "python", "python3", "pip", "pip3", "go", "cargo", "git",
  "bash", "powershell", "pwsh", "cmd", "rg", "grep", "findstr", "vitest", "jest", "tsc",
]);
var QUERY_START_WORDS = buildLookup(["select", "with", "match", "where", "from"]);
var QUERY_STOP_WORDS = buildLookup([
  "what", "why", "how", "when", "where", "which", "who", "did", "does", "do", "is", "are", "was", "were",
  "can", "could", "would", "should", "after", "before", "because", "file", "files", "path", "paths",
  "tool", "tools", "turn", "turns", "output", "outputs", "result", "results", "return", "returned",
]);

var COMMAND_INPUT_KEYS = buildLookup(["command", "script", "cmd"]);
var QUERY_INPUT_KEYS = buildLookup(["query", "pattern", "sql", "kusto", "statement", "searchQuery"]);
var PATH_INPUT_KEYS = buildLookup(["path", "file", "file_path", "filename", "cwd"]);
var CONTENT_INPUT_KEYS = buildLookup(["content", "text", "replacement", "newString", "oldString", "patch", "diff", "insert"]);
var URL_INPUT_KEYS = buildLookup(["url", "uri"]);

var READ_TOOL_NAMES = buildLookup([
  "view",
  "read",
  "cat",
  "get_file_contents",
  "github-mcp-server-get_file_contents",
  "file-read",
]);
var WRITE_TOOL_NAMES = buildLookup([
  "edit",
  "write",
  "create",
  "insert",
  "apply_patch",
  "replace",
  "delete",
]);
var SEARCH_TOOL_NAMES = buildLookup([
  "rg",
  "grep",
  "glob",
  "kusto",
  "search",
  "web_search",
  "github-mcp-server-search_code",
  "github-mcp-server-search_issues",
  "github-mcp-server-search_pull_requests",
  "github-mcp-server-search_repositories",
  "github-mcp-server-search_users",
  "file-search",
]);
var COMMAND_TOOL_NAMES = buildLookup([
  "bash",
  "powershell",
  "cmd",
  "shell",
  "terminal",
  "python",
  "node",
  "go",
]);
var FETCH_TOOL_NAMES = buildLookup([
  "web_fetch",
  "fetch",
  "curl",
  "http",
  "request",
]);

function buildLookup(values) {
  var lookup = {};
  for (var i = 0; i < values.length; i++) {
    lookup[String(values[i]).toLowerCase()] = true;
  }
  return lookup;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getEventEnd(event) {
  return (event && event.t || 0) + Math.max(0, event && event.duration || 0);
}

function isContinuationMessage(text) {
  if (!text) return false;
  return String(text).trim().toLowerCase() === "(continuation)";
}

function getQASessionCost(metadata) {
  if (!metadata) return 0;
  if (metadata.format === "copilot-cli") return metadata.totalCost || 0;
  return estimateCost(metadata.tokenUsage, metadata.primaryModel);
}

function buildQAAutonomyMetrics(events, turns, metadata) {
  var safeEvents = Array.isArray(events) ? events : [];
  var safeTurns = Array.isArray(turns) ? turns : [];
  var safeMetadata = metadata && typeof metadata === "object" ? metadata : {};
  var eventRuntime = safeEvents.reduce(function (sum, event) {
    return sum + Math.max(0, event && event.duration || 0);
  }, 0);
  var realUserTurns = safeTurns.filter(function (turn) {
    return !isContinuationMessage(turn && turn.userMessage);
  });
  var interventionCount = Math.max(0, realUserTurns.length - 1);
  var idleTime = 0;
  var babysittingTime = 0;

  for (var index = 0; index < safeEvents.length - 1; index += 1) {
    var current = safeEvents[index];
    var next = safeEvents[index + 1];
    var gap = Math.max(0, (next && next.t || 0) - getEventEnd(current));
    if (gap < SIGNIFICANT_GAP_SECONDS) continue;

    if (next && next.agent === "user" && current && current.agent !== "user") {
      babysittingTime += Math.min(gap, MAX_BABYSITTING_GAP_SECONDS);
      continue;
    }

    if (gap >= LONG_IDLE_GAP_SECONDS) idleTime += gap;
  }

  var autonomyEfficiencyDenominator = eventRuntime + babysittingTime + idleTime;
  var autonomyEfficiency = autonomyEfficiencyDenominator > 0
    ? clamp(eventRuntime / autonomyEfficiencyDenominator, 0, 1)
    : 0;

  return {
    productiveRuntime: eventRuntime,
    babysittingTime: babysittingTime,
    idleTime: idleTime,
    interventionCount: interventionCount,
    autonomyEfficiency: autonomyEfficiency,
    errorCount: safeMetadata.errorCount || 0,
    totalToolCalls: safeMetadata.totalToolCalls || 0,
    totalTurns: safeMetadata.totalTurns || safeTurns.length,
    cost: getQASessionCost(safeMetadata),
  };
}

function normalizeSearchValue(value) {
  if (value == null) return "";
  return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function toSlug(value) {
  var slug = normalizeSearchValue(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "tool";
}

function pushUniqueValue(list, value) {
  if (value == null) return;
  var raw = String(value).trim();
  if (!raw) return;
  var normalized = normalizeSearchValue(raw);
  for (var i = 0; i < list.length; i++) {
    if (normalizeSearchValue(list[i]) === normalized) return;
  }
  list.push(raw);
}

function addIndexEntry(map, key, value) {
  var normalizedKey = normalizeSearchValue(key);
  if (!normalizedKey) return;
  if (!map[normalizedKey]) map[normalizedKey] = [];
  if (map[normalizedKey].indexOf(value) === -1) map[normalizedKey].push(value);
}

function addManyIndexEntries(map, values, id) {
  for (var i = 0; i < values.length; i++) addIndexEntry(map, values[i], id);
}

function collectPrimitiveValues(value, results) {
  if (value == null) return;
  if (typeof value === "string" || typeof value === "number") {
    pushUniqueValue(results, value);
    return;
  }
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) collectPrimitiveValues(value[i], results);
  }
}

function collectFieldValues(value, keyLookup, results, depth) {
  if (value == null || depth < 0) return;
  if (Array.isArray(value)) {
    for (var ai = 0; ai < value.length; ai++) {
      collectFieldValues(value[ai], keyLookup, results, depth - 1);
    }
    return;
  }
  if (typeof value !== "object") return;

  for (var key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    var child = value[key];
    if (keyLookup[String(key).toLowerCase()]) {
      collectPrimitiveValues(child, results);
    }
    if (child && typeof child === "object") {
      collectFieldValues(child, keyLookup, results, depth - 1);
    }
  }
}

function buildTurnRecord(turn, index) {
  var safeTurn = turn || {};
  return {
    index: safeTurn.index != null ? safeTurn.index : index,
    startTime: safeTurn.startTime != null ? safeTurn.startTime : null,
    endTime: safeTurn.endTime != null ? safeTurn.endTime : null,
    eventIndices: Array.isArray(safeTurn.eventIndices) ? safeTurn.eventIndices.slice() : [],
    userMessage: typeof safeTurn.userMessage === "string" ? safeTurn.userMessage : "",
    toolCount: typeof safeTurn.toolCount === "number" ? safeTurn.toolCount : 0,
    hasError: Boolean(safeTurn.hasError),
  };
}

function buildTurnRecords(events, turns) {
  var safeTurns = Array.isArray(turns) ? turns : [];
  if (safeTurns.length > 0) {
    var normalizedTurns = [];
    for (var turnIndex = 0; turnIndex < safeTurns.length; turnIndex++) {
      normalizedTurns.push(buildTurnRecord(safeTurns[turnIndex], turnIndex));
    }
    return normalizedTurns;
  }

  var safeEvents = Array.isArray(events) ? events : [];
  var derivedTurns = [];
  var turnsByKey = {};

  for (var eventIndex = 0; eventIndex < safeEvents.length; eventIndex++) {
    var event = safeEvents[eventIndex];
    if (!event) continue;

    var currentTurnIndex = event.turnIndex != null ? event.turnIndex : 0;
    var turnKey = String(currentTurnIndex);
    if (!turnsByKey[turnKey]) {
      turnsByKey[turnKey] = {
        index: currentTurnIndex,
        startTime: typeof event.t === "number" ? event.t : null,
        endTime: typeof event.t === "number"
          ? event.t + (typeof event.duration === "number" ? event.duration : 0)
          : null,
        eventIndices: [],
        userMessage: "",
        toolCount: 0,
        hasError: false,
      };
      derivedTurns.push(turnsByKey[turnKey]);
    }

    var derivedTurn = turnsByKey[turnKey];
    derivedTurn.eventIndices.push(eventIndex);

    if (derivedTurn.startTime == null && typeof event.t === "number") {
      derivedTurn.startTime = event.t;
    }
    if (typeof event.t === "number") {
      var eventEndTime = event.t + (typeof event.duration === "number" ? event.duration : 0);
      if (derivedTurn.endTime == null || eventEndTime > derivedTurn.endTime) {
        derivedTurn.endTime = eventEndTime;
      }
    }

    if (!derivedTurn.userMessage && event.agent === "user" && typeof event.text === "string") {
      derivedTurn.userMessage = event.text;
    }
    if (event.track === "tool_call") derivedTurn.toolCount += 1;
    if (event.isError) derivedTurn.hasError = true;
  }

  return derivedTurns;
}

function getTurnLookup(events, turns) {
  var eventToTurn = {};
  var userMessageByTurn = {};
  var turnByIndex = {};
  var safeTurns = buildTurnRecords(events, turns);

  for (var i = 0; i < safeTurns.length; i++) {
    var turn = safeTurns[i] || {};
    var turnIndex = turn.index != null ? turn.index : i;
    turnByIndex[turnIndex] = turn;
    userMessageByTurn[turnIndex] = typeof turn.userMessage === "string" ? turn.userMessage : "";
    var eventIndices = Array.isArray(turn.eventIndices) ? turn.eventIndices : [];
    for (var j = 0; j < eventIndices.length; j++) eventToTurn[eventIndices[j]] = turnIndex;
  }

  return {
    eventToTurn: eventToTurn,
    userMessageByTurn: userMessageByTurn,
    turnByIndex: turnByIndex,
  };
}

/**
 * Serialize a toolInput object into a readable one-liner.
 */
function formatToolInput(toolInput) {
  if (!toolInput) return "";
  if (typeof toolInput === "string") return toolInput;

  var cmd = toolInput.command || toolInput.query || toolInput.pattern || toolInput.content || toolInput.script;
  var path = toolInput.path || toolInput.file || toolInput.file_path || toolInput.filename;
  var parts = [];
  if (cmd) parts.push(cmd);
  if (path && !cmd) parts.push(path);
  else if (path) parts.push("(" + path + ")");
  if (parts.length > 0) return parts.join(" ");

  if (toolInput.url) return String(toolInput.url);
  if (toolInput.owner && toolInput.repo) return String(toolInput.owner) + "/" + String(toolInput.repo);

  try { return JSON.stringify(toolInput); } catch (e) { return ""; }
}

function collectTextEntities(text, entities) {
  if (typeof text !== "string") return;
  var trimmedText = text.trim();
  if (!trimmedText) return;

  var urlMatches = trimmedText.match(/https?:\/\/[^\s)]+/g) || [];
  for (var urlIndex = 0; urlIndex < urlMatches.length; urlIndex++) {
    var rawUrl = urlMatches[urlIndex].replace(/[),.;]+$/g, "");
    pushUniqueValue(entities.urls, rawUrl);

    var githubRepoMatch = rawUrl.match(/^https?:\/\/github\.com\/([^\/\s]+)\/([^\/\s#?]+)/i);
    if (githubRepoMatch) {
      pushUniqueValue(entities.repos, githubRepoMatch[1] + "/" + githubRepoMatch[2]);
    }

    var issueMatch = rawUrl.match(/\/issues\/(\d+)\b/i);
    if (issueMatch) pushUniqueValue(entities.identifiers, "#" + issueMatch[1]);

    var pullMatch = rawUrl.match(/\/pull\/(\d+)\b/i);
    if (pullMatch) pushUniqueValue(entities.identifiers, "PR #" + pullMatch[1]);
  }

  var repoRegex = /\brepo:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/gi;
  var repoMatch;
  while ((repoMatch = repoRegex.exec(trimmedText)) !== null) {
    pushUniqueValue(entities.repos, repoMatch[1]);
  }

  var prRegex = /\bPR\s*#(\d+)\b/gi;
  var prMatch;
  while ((prMatch = prRegex.exec(trimmedText)) !== null) {
    pushUniqueValue(entities.identifiers, "PR #" + prMatch[1]);
  }

  var issueRegex = /(^|[^\w])#(\d+)\b/g;
  var inlineIssueMatch;
  while ((inlineIssueMatch = issueRegex.exec(trimmedText)) !== null) {
    pushUniqueValue(entities.identifiers, "#" + inlineIssueMatch[2]);
  }

  var pathMatches = trimmedText.match(/(?:[A-Za-z]:\\|\.{0,2}[\\/])?[A-Za-z0-9_.-]+(?:[\\/][A-Za-z0-9_.-]+)+\.[A-Za-z0-9_.-]+/g) || [];
  for (var pathIndex = 0; pathIndex < pathMatches.length; pathIndex++) {
    var pathValue = pathMatches[pathIndex];
    if (pathValue.indexOf("://") !== -1) continue;
    pushUniqueValue(entities.paths, pathValue);
  }
}

export function extractToolCallEntities(toolInput, toolOutput) {
  var entities = {
    commands: [],
    queries: [],
    paths: [],
    urls: [],
    repos: [],
    identifiers: [],
  };
  var textCandidates = [];

  function addTextCandidate(value) {
    if (typeof value !== "string") return;
    pushUniqueValue(textCandidates, value);
  }

  function addTextCandidates(values) {
    for (var valueIndex = 0; valueIndex < values.length; valueIndex++) {
      addTextCandidate(values[valueIndex]);
    }
  }

  if (toolInput && typeof toolInput === "object") {
    collectFieldValues(toolInput, COMMAND_INPUT_KEYS, entities.commands, 3);
    collectFieldValues(toolInput, QUERY_INPUT_KEYS, entities.queries, 3);
    collectFieldValues(toolInput, PATH_INPUT_KEYS, entities.paths, 3);
    collectFieldValues(toolInput, URL_INPUT_KEYS, entities.urls, 3);

    if (toolInput.owner && toolInput.repo) {
      pushUniqueValue(entities.repos, String(toolInput.owner) + "/" + String(toolInput.repo));
    }
    if (toolInput.issue_number != null) pushUniqueValue(entities.identifiers, "#" + toolInput.issue_number);
    if (toolInput.pullNumber != null) pushUniqueValue(entities.identifiers, "PR #" + toolInput.pullNumber);
    if (toolInput.resource_id != null) pushUniqueValue(entities.identifiers, toolInput.resource_id);
    if (toolInput.branch) pushUniqueValue(entities.identifiers, toolInput.branch);
    if (toolInput.ref) pushUniqueValue(entities.identifiers, toolInput.ref);

    addTextCandidates(entities.commands);
    addTextCandidates(entities.queries);
    addTextCandidates(entities.urls);
    addTextCandidate(formatToolInput(toolInput));
  }

  if (typeof toolInput === "string") {
    var trimmedInput = toolInput.trim();
    if (trimmedInput) {
      pushUniqueValue(entities.identifiers, trimmedInput);
      addTextCandidate(trimmedInput);
    }
  }

  if (typeof toolOutput === "string") {
    addTextCandidate(toolOutput);
  }

  for (var candidateIndex = 0; candidateIndex < textCandidates.length; candidateIndex++) {
    collectTextEntities(textCandidates[candidateIndex], entities);
  }

  return entities;
}

function classifyToolCallFromEntities(toolName, toolInput, entities) {
  var normalizedToolName = normalizeSearchValue(toolName);
  var hasCommand = entities.commands.length > 0 || COMMAND_TOOL_NAMES[normalizedToolName];
  var hasQuery = entities.queries.length > 0 || SEARCH_TOOL_NAMES[normalizedToolName];
  var hasPath = entities.paths.length > 0 || READ_TOOL_NAMES[normalizedToolName] || WRITE_TOOL_NAMES[normalizedToolName];
  var hasContent = false;
  if (toolInput && typeof toolInput === "object") {
    var contentSignals = [];
    collectFieldValues(toolInput, CONTENT_INPUT_KEYS, contentSignals, 3);
    hasContent = contentSignals.length > 0;
  }
  var hasUrl = entities.urls.length > 0 || FETCH_TOOL_NAMES[normalizedToolName];

  var payloadType = "other";
  if (hasCommand) payloadType = "command";
  else if (hasQuery) payloadType = "query";
  else if (hasContent) payloadType = "content";
  else if (hasPath) payloadType = "path";
  else if (hasUrl) payloadType = "url";

  var operation = "other";
  if (WRITE_TOOL_NAMES[normalizedToolName]) operation = "write";
  else if (READ_TOOL_NAMES[normalizedToolName]) operation = "read";
  else if (SEARCH_TOOL_NAMES[normalizedToolName] || hasQuery) operation = "search";
  else if (COMMAND_TOOL_NAMES[normalizedToolName] || hasCommand) operation = "execute";
  else if (FETCH_TOOL_NAMES[normalizedToolName] || hasUrl) operation = "fetch";

  var buckets = [];
  pushUniqueValue(buckets, payloadType);
  pushUniqueValue(buckets, operation);
  if (hasPath) pushUniqueValue(buckets, "path");
  if (hasCommand) pushUniqueValue(buckets, "command");
  if (hasQuery) pushUniqueValue(buckets, "query");
  if (hasContent) pushUniqueValue(buckets, "content");
  if (hasUrl) pushUniqueValue(buckets, "url");

  return {
    payloadType: payloadType,
    operation: operation,
    buckets: buckets,
  };
}

export function classifyToolCall(toolName, toolInput, toolOutput) {
  var entities = extractToolCallEntities(toolInput, toolOutput);
  return classifyToolCallFromEntities(toolName, toolInput, entities);
}

function stableSerialize(value) {
  if (value == null) return "";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    var arrayParts = [];
    for (var arrayIndex = 0; arrayIndex < value.length; arrayIndex++) {
      arrayParts.push(stableSerialize(value[arrayIndex]));
    }
    return "[" + arrayParts.join(",") + "]";
  }
  if (typeof value === "object") {
    var keys = Object.keys(value).sort();
    var objectParts = [];
    for (var keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      var key = keys[keyIndex];
      objectParts.push(JSON.stringify(key) + ":" + stableSerialize(value[key]));
    }
    return "{" + objectParts.join(",") + "}";
  }
  return "";
}

function buildToolSignature(toolName, toolInput) {
  return normalizeSearchValue(String(toolName || "") + "|" + stableSerialize(toolInput || null));
}

function getRawOutputPreview(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    var arrayPreview = [];
    for (var arrayIndex = 0; arrayIndex < value.length; arrayIndex++) {
      arrayPreview.push(getRawOutputPreview(value[arrayIndex]));
    }
    return arrayPreview.filter(Boolean).join(" ");
  }
  if (typeof value === "object") {
    if (typeof value.content === "string") return value.content;
    if (typeof value.detailedContent === "string") return value.detailedContent;
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.content)) return getRawOutputPreview(value.content);
  }
  try { return JSON.stringify(value); } catch (e) { return ""; }
}

function describeToolRawObject(raw) {
  if (!raw || typeof raw !== "object") return null;

  if (raw.type === "tool.execution_start") {
    var startData = raw.data && typeof raw.data === "object" ? raw.data : {};
    return {
      stage: "start",
      kind: "tool.execution_start",
      toolName: startData.toolName || "",
      toolInput: startData.arguments || null,
      toolCallId: startData.toolCallId || null,
      toolUseId: null,
      outputText: "",
    };
  }

  if (raw.type === "tool.execution_complete") {
    var completeData = raw.data && typeof raw.data === "object" ? raw.data : {};
    return {
      stage: "complete",
      kind: "tool.execution_complete",
      toolName: completeData.toolName || "",
      toolInput: completeData.arguments || null,
      toolCallId: completeData.toolCallId || null,
      toolUseId: null,
      outputText: getRawOutputPreview((completeData.result || completeData.error || "")),
    };
  }

  if (raw.type === "tool_use") {
    return {
      stage: "start",
      kind: "tool_use",
      toolName: raw.name || raw.tool_name || "",
      toolInput: raw.input || raw.parameters || null,
      toolCallId: null,
      toolUseId: raw.id || raw.tool_use_id || null,
      outputText: "",
    };
  }

  if (raw.type === "tool_result") {
    return {
      stage: "complete",
      kind: "tool_result",
      toolName: raw.name || raw.tool_name || "",
      toolInput: raw.input || raw.parameters || null,
      toolCallId: null,
      toolUseId: raw.tool_use_id || raw.id || null,
      outputText: getRawOutputPreview(raw.content || raw.output || raw.result || ""),
    };
  }

  return null;
}

function buildToolDescriptorFingerprint(descriptor) {
  if (!descriptor) return "";
  return normalizeSearchValue([
    descriptor.stage || "",
    descriptor.kind || "",
    descriptor.toolCallId || "",
    descriptor.toolUseId || "",
    descriptor.toolName || "",
    stableSerialize(descriptor.toolInput || null),
  ].join("|"));
}

function appendRawFragment(fragments, indexes, recordEntry, descriptor, path) {
  if (!descriptor) return;

  var fragment = {
    fragmentIndex: fragments.length,
    stage: descriptor.stage,
    kind: descriptor.kind,
    path: path || "$",
    toolName: descriptor.toolName || "",
    toolInput: descriptor.toolInput || null,
    toolCallId: descriptor.toolCallId || null,
    toolUseId: descriptor.toolUseId || null,
    outputText: descriptor.outputText || "",
    signature: buildToolSignature(descriptor.toolName, descriptor.toolInput),
    fingerprint: buildToolDescriptorFingerprint(descriptor),
    recordIndex: recordEntry.recordIndex,
    lineStart: recordEntry.lineStart,
    lineEnd: recordEntry.lineEnd,
    charStart: recordEntry.charStart,
    charEnd: recordEntry.charEnd,
  };

  fragments.push(fragment);

  if (fragment.stage === "start") {
    addIndexEntry(indexes.toolStartsByCallId, fragment.toolCallId, fragment);
    addIndexEntry(indexes.toolStartsByUseId, fragment.toolUseId, fragment);
    addIndexEntry(indexes.toolStartsByFingerprint, fragment.fingerprint, fragment);
    addIndexEntry(indexes.toolStartsBySignature, fragment.signature, fragment);
    return;
  }

  addIndexEntry(indexes.toolCompletesByCallId, fragment.toolCallId, fragment);
  addIndexEntry(indexes.toolResultsByUseId, fragment.toolUseId, fragment);
}

function collectRawFragmentsFromRecord(recordEntry, fragments, indexes) {
  if (!recordEntry || !recordEntry.value || typeof recordEntry.value !== "object") return;

  var record = recordEntry.value;
  appendRawFragment(fragments, indexes, recordEntry, describeToolRawObject(record), "$");

  var nestedCollections = [];
  if (record.message && Array.isArray(record.message.content)) {
    nestedCollections.push({ path: "$.message.content", items: record.message.content });
  }
  if (Array.isArray(record.content)) {
    nestedCollections.push({ path: "$.content", items: record.content });
  }

  for (var collectionIndex = 0; collectionIndex < nestedCollections.length; collectionIndex++) {
    var collection = nestedCollections[collectionIndex];
    for (var itemIndex = 0; itemIndex < collection.items.length; itemIndex++) {
      appendRawFragment(
        fragments,
        indexes,
        recordEntry,
        describeToolRawObject(collection.items[itemIndex]),
        collection.path + "[" + itemIndex + "]"
      );
    }
  }
}

export function buildRawJsonlRecordIndex(rawText) {
  var sourceText = typeof rawText === "string" ? rawText : "";
  var records = [];
  var fragments = [];
  var indexes = {
    toolStartsByCallId: {},
    toolCompletesByCallId: {},
    toolStartsByUseId: {},
    toolResultsByUseId: {},
    toolStartsByFingerprint: {},
    toolStartsBySignature: {},
  };
  var malformedLines = 0;
  var lineNumber = 1;
  var cursor = 0;

  while (cursor <= sourceText.length) {
    var newlineIndex = sourceText.indexOf("\n", cursor);
    var hasNewline = newlineIndex !== -1;
    var lineEnd = hasNewline ? newlineIndex : sourceText.length;
    var rawLine = sourceText.substring(cursor, lineEnd);
    var parseLine = rawLine.replace(/\r$/, "");
    var trimmedLine = parseLine.trim();

    if (trimmedLine) {
      var parsedValue = null;
      try {
        parsedValue = JSON.parse(trimmedLine);
      } catch (e) {
        malformedLines += 1;
      }

      var recordEntry = {
        recordIndex: records.length,
        lineStart: lineNumber,
        lineEnd: lineNumber,
        charStart: cursor,
        charEnd: lineEnd,
        text: parseLine,
        value: parsedValue,
      };
      records.push(recordEntry);
      collectRawFragmentsFromRecord(recordEntry, fragments, indexes);
    }

    if (!hasNewline) break;
    cursor = newlineIndex + 1;
    lineNumber += 1;
  }

  return {
    rawText: sourceText,
    records: records,
    fragments: fragments,
    malformedLines: malformedLines,
    toolStartsByCallId: indexes.toolStartsByCallId,
    toolCompletesByCallId: indexes.toolCompletesByCallId,
    toolStartsByUseId: indexes.toolStartsByUseId,
    toolResultsByUseId: indexes.toolResultsByUseId,
    toolStartsByFingerprint: indexes.toolStartsByFingerprint,
    toolStartsBySignature: indexes.toolStartsBySignature,
  };
}

function buildRawFragmentKey(fragment) {
  if (!fragment) return "";
  return [
    fragment.stage || "",
    fragment.recordIndex != null ? fragment.recordIndex : "",
    fragment.toolCallId || "",
    fragment.toolUseId || "",
    fragment.signature || "",
    fragment.fragmentIndex != null ? fragment.fragmentIndex : "",
  ].join("|");
}

function pickUnusedFragment(fragments, usedFragments) {
  if (!Array.isArray(fragments) || fragments.length === 0) return null;
  for (var i = 0; i < fragments.length; i++) {
    var key = buildRawFragmentKey(fragments[i]);
    if (!key || !usedFragments[key]) return fragments[i];
  }
  return null;
}

function pickEndFragment(fragments, startRecordIndex) {
  if (!Array.isArray(fragments) || fragments.length === 0) return null;
  for (var i = 0; i < fragments.length; i++) {
    if (fragments[i].recordIndex >= startRecordIndex) return fragments[i];
  }
  return fragments[fragments.length - 1];
}

function buildRawSlice(startFragment, endFragment, rawIndex, strategy) {
  if (!startFragment || !rawIndex) return null;
  var safeEndFragment = endFragment || startFragment;
  var startRecord = rawIndex.records[startFragment.recordIndex];
  var endRecord = rawIndex.records[safeEndFragment.recordIndex];
  if (!startRecord || !endRecord) return null;

  var charStart = startRecord.charStart;
  var charEnd = endRecord.charEnd;
  if (typeof charStart !== "number" || typeof charEnd !== "number" || charEnd < charStart) return null;

  return {
    strategy: strategy || "unknown",
    lineStart: startRecord.lineStart,
    lineEnd: endRecord.lineEnd,
    charStart: charStart,
    charEnd: charEnd,
    startRecordIndex: startRecord.recordIndex,
    endRecordIndex: endRecord.recordIndex,
    toolCallId: startFragment.toolCallId || safeEndFragment.toolCallId || null,
    toolUseId: startFragment.toolUseId || safeEndFragment.toolUseId || null,
    text: rawIndex.rawText.substring(charStart, charEnd),
  };
}

export function sliceRawJsonlRange(rawText, range) {
  var sourceText = typeof rawText === "string" ? rawText : "";
  if (!sourceText || !range || typeof range !== "object") return "";

  if (typeof range.charStart === "number" && typeof range.charEnd === "number") {
    if (range.charStart < 0 || range.charEnd < range.charStart) return "";
    return sourceText.substring(range.charStart, range.charEnd);
  }

  if (typeof range.lineStart !== "number" || typeof range.lineEnd !== "number") return "";

  var lines = sourceText.split("\n");
  if (range.lineStart < 1 || range.lineEnd < range.lineStart) return "";
  return lines.slice(range.lineStart - 1, range.lineEnd).join("\n");
}

function resolveRawSliceForEntry(event, entry, rawIndex, usedFragments) {
  if (!event || !entry || !rawIndex) return null;

  var rawDescriptor = describeToolRawObject(event.raw);
  var startFragment = null;
  var strategy = "";

  if (rawDescriptor && rawDescriptor.toolCallId) {
    startFragment = pickUnusedFragment(rawIndex.toolStartsByCallId[rawDescriptor.toolCallId], usedFragments);
    if (startFragment) strategy = "tool_call_id";
  }

  if (!startFragment && rawDescriptor && rawDescriptor.toolUseId) {
    startFragment = pickUnusedFragment(rawIndex.toolStartsByUseId[rawDescriptor.toolUseId], usedFragments);
    if (startFragment) strategy = "tool_use_id";
  }

  if (!startFragment && rawDescriptor) {
    startFragment = pickUnusedFragment(rawIndex.toolStartsByFingerprint[buildToolDescriptorFingerprint(rawDescriptor)], usedFragments);
    if (startFragment) strategy = "raw_fingerprint";
  }

  if (!startFragment) {
    startFragment = pickUnusedFragment(rawIndex.toolStartsBySignature[buildToolSignature(entry.toolName, entry.toolInput)], usedFragments);
    if (startFragment) strategy = "signature";
  }

  if (!startFragment) return null;

  var startKey = buildRawFragmentKey(startFragment);
  if (startKey) usedFragments[startKey] = true;

  var endFragment = startFragment;
  if (startFragment.toolCallId) {
    endFragment = pickEndFragment(rawIndex.toolCompletesByCallId[startFragment.toolCallId], startFragment.recordIndex) || endFragment;
  } else if (startFragment.toolUseId) {
    endFragment = pickEndFragment(rawIndex.toolResultsByUseId[startFragment.toolUseId], startFragment.recordIndex) || endFragment;
  }

  return buildRawSlice(startFragment, endFragment, rawIndex, strategy);
}

function attachRawSlicesToLedger(ledger, rawLookup) {
  var safeLedger = Array.isArray(ledger) ? ledger : [];
  var byEventIndex = rawLookup && rawLookup.byEventIndex ? rawLookup.byEventIndex : {};
  var byLedgerId = rawLookup && rawLookup.byLedgerId ? rawLookup.byLedgerId : {};

  for (var i = 0; i < safeLedger.length; i++) {
    var entry = safeLedger[i];
    var rawSlice = byLedgerId[entry.id] || byEventIndex[entry.eventIndex] || null;
    entry.rawSlice = rawSlice;
    if (rawSlice && rawLookup) byLedgerId[entry.id] = rawSlice;
  }
}

export function buildToolCallRawLookup(events, turns, rawText, options) {
  var safeEvents = Array.isArray(events) ? events : [];
  var opts = options && typeof options === "object" ? options : {};
  var rawIndex = opts.rawIndex || buildRawJsonlRecordIndex(rawText);
  var safeLedger = Array.isArray(opts.ledger) ? opts.ledger : buildToolCallLedger(safeEvents, turns);
  var ledgerIndex = opts.ledgerIndex || buildToolCallSearchIndex(safeLedger);
  var usedFragments = {};
  var byEventIndex = {};
  var byLedgerId = {};

  for (var i = 0; i < safeLedger.length; i++) {
    var entry = safeLedger[i];
    var event = safeEvents[entry.eventIndex];
    var rawSlice = resolveRawSliceForEntry(event, entry, rawIndex, usedFragments);
    if (!rawSlice) continue;
    byEventIndex[entry.eventIndex] = rawSlice;
    byLedgerId[entry.id] = rawSlice;
  }

  return {
    rawText: rawIndex.rawText,
    rawIndex: rawIndex,
    ledger: safeLedger,
    ledgerIndex: ledgerIndex,
    byEventIndex: byEventIndex,
    byLedgerId: byLedgerId,
    matchedCount: Object.keys(byEventIndex).length,
  };
}

function findToolCallRawEntries(rawLookup, request) {
  if (!rawLookup || !request) return [];

  var ledgerIndex = rawLookup.ledgerIndex ||
    (Array.isArray(rawLookup.ledger) ? buildToolCallSearchIndex(rawLookup.ledger) : null);
  if (!ledgerIndex) return [];

  var directEntry = null;
  if (request.id && ledgerIndex.entriesById && ledgerIndex.entriesById[request.id]) {
    directEntry = ledgerIndex.entriesById[request.id];
  } else if (request.eventIndex != null && ledgerIndex.byEventIndex) {
    var directEntryId = ledgerIndex.byEventIndex[request.eventIndex];
    if (directEntryId && ledgerIndex.entriesById) directEntry = ledgerIndex.entriesById[directEntryId];
  }
  if (directEntry) return [directEntry];

  var turnMatches = ledgerIndex.byTurn[normalizeSearchValue(request.turnIndex)];
  if (!Array.isArray(turnMatches) || turnMatches.length === 0) return [];

  var normalizedToolName = normalizeSearchValue(request.toolName);
  var results = [];
  for (var i = 0; i < turnMatches.length; i++) {
    var entry = ledgerIndex.entriesById[turnMatches[i]];
    if (!entry) continue;
    if (normalizedToolName && entry.toolNameNormalized !== normalizedToolName) continue;
    if (request.turnToolIndex != null && entry.turnToolIndex !== request.turnToolIndex) continue;
    results.push(entry);
  }

  results.sort(compareLedgerEntries);
  return results;
}

function getRawSliceForEntry(rawLookup, entry) {
  if (!entry) return null;
  if (rawLookup && rawLookup.byLedgerId && rawLookup.byLedgerId[entry.id]) {
    return rawLookup.byLedgerId[entry.id];
  }
  if (rawLookup && rawLookup.byEventIndex && rawLookup.byEventIndex[entry.eventIndex]) {
    return rawLookup.byEventIndex[entry.eventIndex];
  }
  return entry.rawSlice || null;
}

export function findToolCallRawSlices(rawLookup, request) {
  var entries = findToolCallRawEntries(rawLookup, request);
  var matches = [];
  for (var i = 0; i < entries.length; i++) {
    var rawSlice = getRawSliceForEntry(rawLookup, entries[i]);
    if (rawSlice) matches.push(rawSlice);
  }
  return matches;
}

export function getToolCallRawSlice(rawLookup, request) {
  var matches = findToolCallRawSlices(rawLookup, request);
  return matches.length > 0 ? matches[0] : null;
}

/**
 * Build a normalized per-tool-call ledger for a parsed session.
 */
export function buildToolCallLedger(events, turns, options) {
  var safeEvents = Array.isArray(events) ? events : [];
  var turnLookup = getTurnLookup(safeEvents, turns);
  var perTurnCounts = {};
  var ledger = [];

  for (var eventIndex = 0; eventIndex < safeEvents.length; eventIndex++) {
    var event = safeEvents[eventIndex];
    if (!event || event.track !== "tool_call") continue;

    var turnIndex = event.turnIndex != null ? event.turnIndex : turnLookup.eventToTurn[eventIndex];
    var turnKey = turnIndex != null ? String(turnIndex) : "unknown";
    if (perTurnCounts[turnKey] == null) perTurnCounts[turnKey] = 0;
    var turnToolIndex = perTurnCounts[turnKey];
    perTurnCounts[turnKey] += 1;

    var toolName = String(event.toolName || "unknown");
    var inputText = formatToolInput(event.toolInput);
    var outputText = typeof event.text === "string" ? event.text : "";
    var entities = extractToolCallEntities(event.toolInput, outputText);
    var classification = classifyToolCallFromEntities(toolName, event.toolInput, entities);
    var userMessage = turnIndex != null ? turnLookup.userMessageByTurn[turnIndex] || "" : "";
    var searchParts = [toolName, inputText, outputText, userMessage];
    var entityKeys = Object.keys(entities);
    for (var keyIndex = 0; keyIndex < entityKeys.length; keyIndex++) {
      var entityValues = entities[entityKeys[keyIndex]];
      if (entityValues.length > 0) searchParts.push(entityValues.join(" "));
    }
    searchParts.push(classification.buckets.join(" "));

    ledger.push({
      id: "turn-" + (turnIndex != null ? turnIndex : "unknown") +
        "-tool-" + turnToolIndex +
        "-event-" + eventIndex +
        "-" + toSlug(toolName),
      eventIndex: eventIndex,
      turnIndex: turnIndex != null ? turnIndex : null,
      turnToolIndex: turnToolIndex,
      toolName: toolName,
      toolNameNormalized: normalizeSearchValue(toolName),
      startedAt: typeof event.t === "number" ? event.t : null,
      duration: typeof event.duration === "number" ? event.duration : 0,
      isError: Boolean(event.isError),
      inputText: inputText,
      outputText: outputText,
      inputPreview: truncate(inputText, MAX_INPUT_CHARS),
      outputPreview: truncate(outputText, MAX_OUTPUT_CHARS),
      userMessage: userMessage,
      classification: classification,
      entities: entities,
      toolInput: event.toolInput || null,
      searchText: searchParts.filter(Boolean).join(" | "),
      searchTextNormalized: normalizeSearchValue(searchParts.filter(Boolean).join(" | ")),
      });
  }

  if (options && (options.rawLookup || options.rawIndex || typeof options.rawText === "string")) {
    var rawLookup = options.rawLookup || buildToolCallRawLookup(safeEvents, turns, options.rawText, {
      ledger: ledger,
      rawIndex: options.rawIndex,
    });
    attachRawSlicesToLedger(ledger, rawLookup);
  }

  return ledger;
}

/**
 * Build lightweight exact-match indexes for the tool-call ledger.
 */
export function buildToolCallSearchIndex(ledger) {
  var safeLedger = Array.isArray(ledger) ? ledger : [];
  var entriesById = {};
  var byEventIndex = {};
  var byTurn = {};
  var byToolName = {};
  var byBucket = {};
  var exactInput = {};
  var exactOutput = {};
  var entityIndexes = {
    command: {},
    query: {},
    path: {},
    url: {},
    repo: {},
    identifier: {},
  };

  for (var i = 0; i < safeLedger.length; i++) {
    var entry = safeLedger[i];
    entriesById[entry.id] = entry;
    byEventIndex[entry.eventIndex] = entry.id;
    addIndexEntry(byTurn, entry.turnIndex != null ? entry.turnIndex : "unknown", entry.id);
    addIndexEntry(byToolName, entry.toolNameNormalized, entry.id);
    addIndexEntry(exactInput, entry.inputText, entry.id);
    addIndexEntry(exactOutput, entry.outputText, entry.id);

    for (var bucketIndex = 0; bucketIndex < entry.classification.buckets.length; bucketIndex++) {
      addIndexEntry(byBucket, entry.classification.buckets[bucketIndex], entry.id);
    }

    addManyIndexEntries(entityIndexes.command, entry.entities.commands, entry.id);
    addManyIndexEntries(entityIndexes.query, entry.entities.queries, entry.id);
    addManyIndexEntries(entityIndexes.path, entry.entities.paths, entry.id);
    addManyIndexEntries(entityIndexes.url, entry.entities.urls, entry.id);
    addManyIndexEntries(entityIndexes.repo, entry.entities.repos, entry.id);
    addManyIndexEntries(entityIndexes.identifier, entry.entities.identifiers, entry.id);
  }

  return {
    entries: safeLedger.slice(),
    entriesById: entriesById,
    byEventIndex: byEventIndex,
    byTurn: byTurn,
    byToolName: byToolName,
    byBucket: byBucket,
    exactInput: exactInput,
    exactOutput: exactOutput,
    entities: entityIndexes,
  };
}

function collectIndexMatches(map, searchText, ids) {
  var normalized = normalizeSearchValue(searchText);
  if (!normalized || !map || !map[normalized]) return;
  var matches = map[normalized];
  for (var i = 0; i < matches.length; i++) {
    if (ids.indexOf(matches[i]) === -1) ids.push(matches[i]);
  }
}

function scopeMatches(scopes, singular, plural) {
  if (!Array.isArray(scopes) || scopes.length === 0) return true;
  return scopes.indexOf(singular) !== -1 || scopes.indexOf(plural) !== -1;
}

function entryMatchesBuckets(entry, buckets) {
  if (!Array.isArray(buckets) || buckets.length === 0) return true;
  for (var i = 0; i < buckets.length; i++) {
    var normalizedBucket = normalizeSearchValue(buckets[i]);
    if (!normalizedBucket) continue;
    if (entry.classification.payloadType === normalizedBucket) return true;
    if (entry.classification.operation === normalizedBucket) return true;
    if (entry.classification.buckets.indexOf(normalizedBucket) !== -1) return true;
  }
  return false;
}

function compareLedgerEntries(a, b) {
  var aTurn = typeof a.turnIndex === "number" ? a.turnIndex : Number.MAX_SAFE_INTEGER;
  var bTurn = typeof b.turnIndex === "number" ? b.turnIndex : Number.MAX_SAFE_INTEGER;
  if (aTurn !== bTurn) return aTurn - bTurn;
  return a.eventIndex - b.eventIndex;
}

/**
 * Exact-match retrieval for indexed tool-call entries. Optional substring fallback can be enabled
 * with { allowContains: true } when callers want a looser search.
 */
export function findToolCallEntries(index, searchText, options) {
  if (!index || !searchText || !normalizeSearchValue(searchText)) return [];

  var opts = options || {};
  var scopes = Array.isArray(opts.scopes) ? opts.scopes : null;
  var ids = [];

  if (scopeMatches(scopes, "input", "inputs")) collectIndexMatches(index.exactInput, searchText, ids);
  if (scopeMatches(scopes, "output", "outputs")) collectIndexMatches(index.exactOutput, searchText, ids);
  if (scopeMatches(scopes, "tool", "tools") || scopeMatches(scopes, "toolname", "toolnames")) {
    collectIndexMatches(index.byToolName, searchText, ids);
  }
  if (scopeMatches(scopes, "bucket", "buckets")) collectIndexMatches(index.byBucket, searchText, ids);
  if (scopeMatches(scopes, "turn", "turns")) collectIndexMatches(index.byTurn, searchText, ids);

  if (scopeMatches(scopes, "entity", "entities") || scopeMatches(scopes, "command", "commands")) {
    collectIndexMatches(index.entities.command, searchText, ids);
  }
  if (scopeMatches(scopes, "entity", "entities") || scopeMatches(scopes, "query", "queries")) {
    collectIndexMatches(index.entities.query, searchText, ids);
  }
  if (scopeMatches(scopes, "entity", "entities") || scopeMatches(scopes, "path", "paths")) {
    collectIndexMatches(index.entities.path, searchText, ids);
  }
  if (scopeMatches(scopes, "entity", "entities") || scopeMatches(scopes, "url", "urls")) {
    collectIndexMatches(index.entities.url, searchText, ids);
  }
  if (scopeMatches(scopes, "entity", "entities") || scopeMatches(scopes, "repo", "repos")) {
    collectIndexMatches(index.entities.repo, searchText, ids);
  }
  if (scopeMatches(scopes, "entity", "entities") || scopeMatches(scopes, "identifier", "identifiers")) {
    collectIndexMatches(index.entities.identifier, searchText, ids);
  }

  if (ids.length === 0 && opts.allowContains === true) {
    var normalizedSearch = normalizeSearchValue(searchText);
    for (var i = 0; i < index.entries.length; i++) {
      if (index.entries[i].searchTextNormalized.indexOf(normalizedSearch) !== -1) ids.push(index.entries[i].id);
    }
  }

  var results = [];
  for (var resultIndex = 0; resultIndex < ids.length; resultIndex++) {
    var entry = index.entriesById[ids[resultIndex]];
    if (!entry) continue;
    if (opts.turnIndex != null && entry.turnIndex !== opts.turnIndex) continue;
    if (opts.toolName && entry.toolNameNormalized !== normalizeSearchValue(opts.toolName)) continue;
    if (!entryMatchesBuckets(entry, opts.buckets)) continue;
    results.push(entry);
  }

  results.sort(compareLedgerEntries);

  if (opts.limit && results.length > opts.limit) {
    return results.slice(0, opts.limit);
  }
  return results;
}

function summarizeToolNames(toolNames) {
  if (toolNames.length <= 4) return toolNames.join(", ");
  return toolNames.slice(0, 4).join(", ") + " +" + (toolNames.length - 4);
}

function collectTurnFocusEntities(turnEntries, limit) {
  var focusEntities = [];
  var maxValues = typeof limit === "number" && limit > 0 ? limit : 3;

  for (var entryIndex = 0; entryIndex < turnEntries.length; entryIndex++) {
    var entry = turnEntries[entryIndex];
    var groups = [
      entry.entities.paths,
      entry.entities.commands,
      entry.entities.queries,
      entry.entities.repos,
      entry.entities.identifiers,
    ];

    for (var groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      var values = groups[groupIndex];
      for (var valueIndex = 0; valueIndex < values.length; valueIndex++) {
        pushUniqueValue(focusEntities, values[valueIndex]);
        if (focusEntities.length >= maxValues) return focusEntities;
      }
    }
  }

  return focusEntities;
}

/**
 * Build compact, cache-friendly turn summaries for Q&A context construction.
 */
export function buildTurnSummaries(events, turns, options) {
  var safeEvents = Array.isArray(events) ? events : [];
  var turnRecords = buildTurnRecords(safeEvents, turns);
  var ledger = options && Array.isArray(options.ledger) ? options.ledger : buildToolCallLedger(safeEvents, turnRecords);
  var ledgerByTurn = {};

  for (var i = 0; i < ledger.length; i++) {
    var ledgerEntry = ledger[i];
    var turnKey = ledgerEntry.turnIndex != null ? String(ledgerEntry.turnIndex) : "unknown";
    if (!ledgerByTurn[turnKey]) ledgerByTurn[turnKey] = [];
    ledgerByTurn[turnKey].push(ledgerEntry);
  }

  var summaries = [];
  for (var turnIndex = 0; turnIndex < turnRecords.length; turnIndex++) {
    var turn = turnRecords[turnIndex] || {};
    var currentTurnIndex = turn.index != null ? turn.index : turnIndex;
    var turnEntries = ledgerByTurn[String(currentTurnIndex)] || [];
    var toolNames = [];
    var focusEntities = collectTurnFocusEntities(turnEntries, 3);
    var reasoningPreview = "";
    var outputPreview = "";
    var errorCount = 0;
    var eventIndices = Array.isArray(turn.eventIndices) ? turn.eventIndices : [];

    for (var eventOffset = 0; eventOffset < eventIndices.length; eventOffset++) {
      var event = safeEvents[eventIndices[eventOffset]];
      if (!event) continue;
      if (event.isError) errorCount += 1;
      if (!reasoningPreview && event.track === "reasoning" && event.text) {
        reasoningPreview = truncate(event.text, 140);
      }
      if (!outputPreview && event.track === "output" && event.text) {
        outputPreview = truncate(event.text, 140);
      }
    }

    for (var toolIndex = 0; toolIndex < turnEntries.length; toolIndex++) {
      pushUniqueValue(toolNames, turnEntries[toolIndex].toolName);
    }

    if (!outputPreview && turnEntries.length > 0) {
      outputPreview = truncate(turnEntries[turnEntries.length - 1].outputText, 140);
    }

    var summaryParts = [];
    if (turn.userMessage) summaryParts.push(truncate(turn.userMessage, 180));
    if (toolNames.length > 0) summaryParts.push("tools: " + summarizeToolNames(toolNames));
    if (focusEntities.length > 0) summaryParts.push("focus: " + focusEntities.join(", "));
    if (outputPreview) summaryParts.push("result: " + outputPreview);
    else if (reasoningPreview) summaryParts.push("reasoning: " + reasoningPreview);
    if (errorCount > 0) summaryParts.push("errors: " + errorCount);

    summaries.push({
      turnIndex: currentTurnIndex,
      startTime: turn.startTime != null ? turn.startTime : null,
      endTime: turn.endTime != null ? turn.endTime : null,
      userMessage: typeof turn.userMessage === "string" ? turn.userMessage : "",
      eventCount: eventIndices.length,
      toolCount: turnEntries.length || turn.toolCount || 0,
      toolNames: toolNames,
      focusEntities: focusEntities,
      errorCount: errorCount,
      hasError: Boolean(turn.hasError || errorCount > 0),
      reasoningPreview: reasoningPreview,
      outputPreview: outputPreview,
      summary: summaryParts.join(" | ") || "Turn " + currentTurnIndex,
    });
  }

  return summaries;
}

function formatMetricDuration(seconds) {
  var numericSeconds = typeof seconds === "number" ? seconds : Number(seconds);
  if (!Number.isFinite(numericSeconds) || numericSeconds < 0) return "0s";
  var totalSeconds = Math.round(numericSeconds);
  var hours = Math.floor(totalSeconds / 3600);
  var minutes = Math.floor((totalSeconds % 3600) / 60);
  var remainingSeconds = totalSeconds % 60;
  var parts = [];
  if (hours > 0) parts.push(hours + "h");
  if (minutes > 0) parts.push(minutes + "m");
  if (remainingSeconds > 0 || parts.length === 0) parts.push(remainingSeconds + "s");
  return parts.join(" ");
}

function formatMetricCount(value, singular, plural) {
  var numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) numericValue = 0;
  var roundedValue = Math.max(0, Math.round(numericValue));
  return roundedValue.toLocaleString() + " " + (roundedValue === 1 ? singular : (plural || singular + "s"));
}

function formatMetricCurrency(value) {
  var numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) numericValue = 0;
  return "$" + numericValue.toFixed(numericValue >= 100 ? 0 : 2);
}

function hasAnyTerm(text, values) {
  var normalizedText = normalizeSearchValue(text);
  if (!normalizedText) return false;
  for (var i = 0; i < values.length; i++) {
    if (normalizedText.indexOf(normalizeSearchValue(values[i])) !== -1) return true;
  }
  return false;
}

function buildLongestAutonomousRunStat(turns) {
  var safeTurns = Array.isArray(turns) ? turns : [];
  var longest = null;
  for (var i = 0; i < safeTurns.length; i++) {
    var turn = safeTurns[i];
    if (!turn) continue;
    var startTime = typeof turn.startTime === "number" ? turn.startTime : null;
    var endTime = typeof turn.endTime === "number" ? turn.endTime : null;
    if (startTime === null || endTime === null || endTime < startTime) continue;
    var duration = endTime - startTime;
    if (!longest || duration > longest.duration) {
      longest = {
        duration: duration,
        startTime: startTime,
        endTime: endTime,
        turnIndex: turn.index != null ? turn.index : i,
        userMessage: typeof turn.userMessage === "string" ? turn.userMessage : "",
        eventCount: Array.isArray(turn.eventIndices) ? turn.eventIndices.length : 0,
      };
    }
  }
  return longest;
}

function buildLongestToolCallStat(ledger) {
  var safeLedger = Array.isArray(ledger) ? ledger : [];
  var longest = null;
  for (var i = 0; i < safeLedger.length; i++) {
    var entry = safeLedger[i];
    var duration = typeof entry.duration === "number" ? entry.duration : Number(entry.duration);
    if (!Number.isFinite(duration) || duration < 0) continue;
    if (!longest || duration > longest.duration) {
      longest = {
        duration: duration,
        toolName: entry.toolName,
        turnIndex: entry.turnIndex,
        inputPreview: entry.inputPreview || "",
        outputPreview: entry.outputPreview || "",
        id: entry.id,
      };
    }
  }
  return longest;
}

function buildSessionMetricCatalog(events, turns, metadata, options) {
  var safeEvents = Array.isArray(events) ? events : [];
  var safeTurns = Array.isArray(turns) ? turns : [];
  var safeMetadata = metadata && typeof metadata === "object" ? metadata : {};
  var opts = options && typeof options === "object" ? options : {};
  var ledger = Array.isArray(opts.ledger) ? opts.ledger : [];
  var stats = opts.stats && typeof opts.stats === "object" ? opts.stats : buildLedgerStats(safeEvents, ledger);
  var summaryChunks = Array.isArray(opts.summaryChunks) ? opts.summaryChunks : [];
  var autonomy = buildQAAutonomyMetrics(safeEvents, safeTurns, safeMetadata);
  var longestAutonomousRun = buildLongestAutonomousRunStat(safeTurns);
  var longestToolCall = buildLongestToolCallStat(ledger);
  var toolRanking = Array.isArray(stats.toolRanking) ? stats.toolRanking : [];
  var tokenUsage = safeMetadata.tokenUsage && typeof safeMetadata.tokenUsage === "object"
    ? safeMetadata.tokenUsage
    : null;
  var inputTokens = tokenUsage && tokenUsage.inputTokens != null ? Number(tokenUsage.inputTokens) : 0;
  var outputTokens = tokenUsage && tokenUsage.outputTokens != null ? Number(tokenUsage.outputTokens) : 0;
  if (!Number.isFinite(inputTokens)) inputTokens = 0;
  if (!Number.isFinite(outputTokens)) outputTokens = 0;
  var queryCount = 0;
  var commandCount = 0;
  var rawRecordCount = opts.rawIndex && Array.isArray(opts.rawIndex.records) ? opts.rawIndex.records.length : 0;

  for (var i = 0; i < ledger.length; i++) {
    var classification = ledger[i] && ledger[i].classification ? ledger[i].classification : null;
    if (!classification) continue;
    if (classification.payloadType === "query" || classification.operation === "search" || classification.buckets.indexOf("query") !== -1) {
      queryCount += 1;
    }
    if (classification.payloadType === "command" || classification.operation === "execute" || classification.buckets.indexOf("command") !== -1) {
      commandCount += 1;
    }
  }

  return {
    duration: safeMetadata.duration != null ? Number(safeMetadata.duration) || 0 : 0,
    totalTurns: safeMetadata.totalTurns != null ? Number(safeMetadata.totalTurns) || 0 : safeTurns.length,
    totalToolCalls: safeMetadata.totalToolCalls != null ? Number(safeMetadata.totalToolCalls) || 0 : ledger.length,
    errorCount: safeMetadata.errorCount != null ? Number(safeMetadata.errorCount) || 0 : (stats.errorList || []).length,
    inputTokens: inputTokens,
    outputTokens: outputTokens,
    totalTokens: inputTokens + outputTokens,
    totalCost: getQASessionCost(safeMetadata),
    topTools: toolRanking.slice(0, MAX_DIRECT_TOOL_LIST).map(function (entry) {
      return { name: entry[0], count: entry[1] };
    }),
    autonomy: autonomy,
    longestAutonomousRun: longestAutonomousRun,
    longestToolCall: longestToolCall,
    queryCount: queryCount,
    commandCount: commandCount,
    fileCount: Array.isArray(stats.fileEntries) ? stats.fileEntries.length : 0,
    summaryChunkCount: summaryChunks.length,
    rawRecordCount: rawRecordCount,
  };
}

function mergeSummaryChunkRawRange(currentRange, nextRange) {
  if (!nextRange || typeof nextRange !== "object") return currentRange;
  if (!currentRange) {
    return {
      lineStart: nextRange.lineStart,
      lineEnd: nextRange.lineEnd,
      charStart: nextRange.charStart,
      charEnd: nextRange.charEnd,
      startRecordIndex: nextRange.startRecordIndex,
      endRecordIndex: nextRange.endRecordIndex,
    };
  }
  return {
    lineStart: typeof currentRange.lineStart === "number" && typeof nextRange.lineStart === "number"
      ? Math.min(currentRange.lineStart, nextRange.lineStart)
      : (currentRange.lineStart != null ? currentRange.lineStart : nextRange.lineStart),
    lineEnd: typeof currentRange.lineEnd === "number" && typeof nextRange.lineEnd === "number"
      ? Math.max(currentRange.lineEnd, nextRange.lineEnd)
      : (currentRange.lineEnd != null ? currentRange.lineEnd : nextRange.lineEnd),
    charStart: typeof currentRange.charStart === "number" && typeof nextRange.charStart === "number"
      ? Math.min(currentRange.charStart, nextRange.charStart)
      : (currentRange.charStart != null ? currentRange.charStart : nextRange.charStart),
    charEnd: typeof currentRange.charEnd === "number" && typeof nextRange.charEnd === "number"
      ? Math.max(currentRange.charEnd, nextRange.charEnd)
      : (currentRange.charEnd != null ? currentRange.charEnd : nextRange.charEnd),
    startRecordIndex: typeof currentRange.startRecordIndex === "number" && typeof nextRange.startRecordIndex === "number"
      ? Math.min(currentRange.startRecordIndex, nextRange.startRecordIndex)
      : (currentRange.startRecordIndex != null ? currentRange.startRecordIndex : nextRange.startRecordIndex),
    endRecordIndex: typeof currentRange.endRecordIndex === "number" && typeof nextRange.endRecordIndex === "number"
      ? Math.max(currentRange.endRecordIndex, nextRange.endRecordIndex)
      : (currentRange.endRecordIndex != null ? currentRange.endRecordIndex : nextRange.endRecordIndex),
  };
}

function buildSummaryChunkRawRange(ledger, startTurn, endTurn) {
  var safeLedger = Array.isArray(ledger) ? ledger : [];
  var rawRange = null;
  for (var i = 0; i < safeLedger.length; i++) {
    var entry = safeLedger[i];
    if (typeof entry.turnIndex !== "number") continue;
    if (entry.turnIndex < startTurn || entry.turnIndex > endTurn) continue;
    rawRange = mergeSummaryChunkRawRange(rawRange, entry.rawSlice);
  }
  return rawRange;
}

export function buildSessionSummaryChunks(events, turns, options) {
  var safeEvents = Array.isArray(events) ? events : [];
  var safeTurns = Array.isArray(turns) ? turns : [];
  var opts = options && typeof options === "object" ? options : {};
  var turnSummaries = Array.isArray(opts.turnSummaries) ? opts.turnSummaries : buildTurnSummaries(safeEvents, safeTurns, opts);
  var ledger = Array.isArray(opts.ledger) ? opts.ledger : buildToolCallLedger(safeEvents, safeTurns, opts);
  var maxChars = typeof opts.maxChars === "number" && opts.maxChars > 0 ? opts.maxChars : MAX_SUMMARY_CHUNK_CHARS;
  var maxTurns = typeof opts.maxTurns === "number" && opts.maxTurns > 0 ? opts.maxTurns : MAX_SUMMARY_CHUNK_TURNS;
  var chunks = [];
  var current = [];
  var currentChars = 0;

  function flushChunk() {
    if (current.length === 0) return;
    var startSummary = current[0];
    var endSummary = current[current.length - 1];
    var toolNames = [];
    var focusEntities = [];
    var turnIndices = [];
    var errorCount = 0;
    var summaryLines = [];

    for (var summaryIndex = 0; summaryIndex < current.length; summaryIndex++) {
      var summary = current[summaryIndex];
      turnIndices.push(summary.turnIndex);
      errorCount += summary.errorCount || 0;
      for (var toolIndex = 0; toolIndex < summary.toolNames.length; toolIndex++) {
        pushUniqueValue(toolNames, summary.toolNames[toolIndex]);
      }
      for (var focusIndex = 0; focusIndex < summary.focusEntities.length; focusIndex++) {
        pushUniqueValue(focusEntities, summary.focusEntities[focusIndex]);
      }
      summaryLines.push("Turn " + summary.turnIndex + ": " + truncate(summary.summary, 260));
    }

    var chunkIndex = chunks.length;
    var summaryText = summaryLines.join("\n");
    chunks.push({
      id: "summary-chunk-" + chunkIndex,
      chunkIndex: chunkIndex,
      startTurn: startSummary.turnIndex,
      endTurn: endSummary.turnIndex,
      startTime: startSummary.startTime,
      endTime: endSummary.endTime,
      turnCount: current.length,
      turnIndices: turnIndices,
      toolNames: toolNames,
      focusEntities: focusEntities,
      errorCount: errorCount,
      hasError: errorCount > 0,
      summary: summaryText,
      searchTextNormalized: normalizeSearchValue(summaryText + " | " + toolNames.join(" | ") + " | " + focusEntities.join(" | ")),
      rawRange: buildSummaryChunkRawRange(ledger, startSummary.turnIndex, endSummary.turnIndex),
    });

    current = [];
    currentChars = 0;
  }

  for (var i = 0; i < turnSummaries.length; i++) {
    var line = "Turn " + turnSummaries[i].turnIndex + ": " + truncate(turnSummaries[i].summary, 260);
    if (current.length > 0 && (current.length >= maxTurns || currentChars + line.length + 1 > maxChars)) {
      flushChunk();
    }
    current.push(turnSummaries[i]);
    currentChars += line.length + 1;
  }

  flushChunk();
  return chunks;
}

function scoreSummaryChunkForQuestion(chunk, questionProfile, totalChunks) {
  if (!chunk || !questionProfile || !questionProfile.normalizedQuestion) return 0;
  var normalizedSearch = chunk.searchTextNormalized || "";
  var score = 0;

  if (questionProfile.wantsErrors && chunk.hasError) score += 5;
  score += countNormalizedMatches(chunk.toolNames, questionProfile.matchedToolNames) * 6;
  score += countNormalizedMatches(chunk.focusEntities, questionProfile.pathTerms) * 5;
  score += countNormalizedMatches(chunk.focusEntities, questionProfile.entities.identifiers) * 4;
  score += countNormalizedMatches(chunk.focusEntities, questionProfile.entities.repos) * 4;
  score += countNormalizedMatches(chunk.focusEntities, questionProfile.entities.urls) * 4;

  for (var matcherIndex = 0; matcherIndex < questionProfile.matchers.length; matcherIndex++) {
    if (normalizedSearch.indexOf(questionProfile.matchers[matcherIndex].value) !== -1) score += 6;
  }

  for (var tokenIndex = 0; tokenIndex < questionProfile.tokens.length; tokenIndex++) {
    var token = questionProfile.tokens[tokenIndex];
    if (normalizedSearch.indexOf(token) !== -1) score += token.length >= 6 ? 2 : 1;
  }

  if (questionProfile.broadSummary) {
    score += 1;
    // Position-diversity bonus: middle and late chunks get +2 to counteract
    // the early-first tie-break that would otherwise always favor early chunks
    var tc = typeof totalChunks === "number" && totalChunks > 0 ? totalChunks : 1;
    var chunkPos = typeof chunk.chunkIndex === "number" ? chunk.chunkIndex / tc : 0;
    if (chunkPos >= 0.25) score += 2;
  }

  // Temporal signal scoring
  var tc2 = typeof totalChunks === "number" && totalChunks > 0 ? totalChunks : 1;
  var chunkPos2 = typeof chunk.chunkIndex === "number" ? chunk.chunkIndex / tc2 : 0;
  if (questionProfile.wantsLateSession && chunkPos2 >= 0.75) score += 4;
  if (questionProfile.wantsEarlySession && chunkPos2 < 0.25) score += 4;

  return score;
}

function selectRelevantSummaryChunks(artifacts, questionProfile, limit) {
  if (!artifacts || !Array.isArray(artifacts.summaryChunks)) return [];
  var maxCount = typeof limit === "number" && limit > 0 ? limit : MAX_SUMMARY_CHUNK_RESULTS;
  var totalChunks = artifacts.summaryChunks.length;
  var scored = [];

  for (var i = 0; i < totalChunks; i++) {
    var score = scoreSummaryChunkForQuestion(artifacts.summaryChunks[i], questionProfile, totalChunks);
    if (score <= 0 && !questionProfile.broadSummary) continue;
    scored.push({ chunk: artifacts.summaryChunks[i], score: score });
  }

  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    // Spread ties across the session: prefer chunks closer to the middle,
    // then alternate early/late to avoid always favoring early chunks.
    var aPos = totalChunks > 0 ? a.chunk.chunkIndex / totalChunks : 0;
    var bPos = totalChunks > 0 ? b.chunk.chunkIndex / totalChunks : 0;
    var aDist = Math.abs(aPos - 0.5);
    var bDist = Math.abs(bPos - 0.5);
    return aDist - bDist;
  });

  // Diversity filter: prevent adjacent same-score chunks from dominating
  var results = [];
  var maxTurnsPerChunk = MAX_SUMMARY_CHUNK_TURNS;
  for (var resultIndex = 0; resultIndex < scored.length && results.length < maxCount; resultIndex++) {
    var candidate = scored[resultIndex];
    if (results.length > 0 && questionProfile.broadSummary) {
      var minSelectedScore = results[results.length - 1].score;
      if (candidate.score === minSelectedScore) {
        var isAdjacent = false;
        for (var si = 0; si < results.length; si++) {
          if (Math.abs(candidate.chunk.startTurn - results[si].chunk.startTurn) <= maxTurnsPerChunk) {
            isAdjacent = true;
            break;
          }
        }
        if (isAdjacent) continue;
      }
    }
    results.push(candidate);
  }

  // For broad-summary questions, ensure at least one chunk from the last
  // third of the session is included if any scored > 0
  if (questionProfile.broadSummary && results.length > 0) {
    var lastThirdStart = Math.floor(totalChunks * 2 / 3);
    var hasLateChunk = false;
    for (var li = 0; li < results.length; li++) {
      if (results[li].chunk.chunkIndex >= lastThirdStart) {
        hasLateChunk = true;
        break;
      }
    }
    if (!hasLateChunk) {
      var bestLateChunk = null;
      for (var lci = 0; lci < scored.length; lci++) {
        if (scored[lci].chunk.chunkIndex >= lastThirdStart && scored[lci].score > 0) {
          bestLateChunk = scored[lci];
          break;
        }
      }
      if (bestLateChunk) {
        results[results.length - 1] = bestLateChunk;
      }
    }
  }

  var finalResults = [];
  for (var fi = 0; fi < results.length && finalResults.length < maxCount; fi++) {
    finalResults.push(results[fi].chunk);
  }
  return finalResults;
}

export function generateBroadQueryRewrites(question, questionProfile) {
  if (!questionProfile || !questionProfile.broadSummary) return [];
  var rewrites = [];
  var q = typeof question === "string" ? question.trim() : "";
  if (!q) return [];

  // Intent paraphrase
  rewrites.push("What was the main goal and how was it achieved in this session?");
  // Outcome paraphrase
  rewrites.push("What was the final outcome and what changed by the end of this session?");
  // Evidence paraphrase
  rewrites.push("What were the key decisions, errors, and tools used throughout this session?");

  return rewrites;
}

export function selectDiverseChunksFromRewrites(artifacts, questionProfile, rewrites, limit) {
  if (!artifacts || !Array.isArray(artifacts.summaryChunks) || artifacts.summaryChunks.length === 0) {
    return selectRelevantSummaryChunks(artifacts, questionProfile, limit);
  }

  var maxCount = typeof limit === "number" && limit > 0 ? limit : MAX_SUMMARY_CHUNK_RESULTS;
  var allProfiles = [questionProfile];

  for (var i = 0; i < rewrites.length; i++) {
    allProfiles.push(classifySessionQAQuestion(rewrites[i], { artifacts: artifacts }));
  }

  // Score each chunk against all profiles, take the max score per chunk
  var totalChunks = artifacts.summaryChunks.length;
  var scored = [];
  for (var ci = 0; ci < totalChunks; ci++) {
    var chunk = artifacts.summaryChunks[ci];
    var bestScore = 0;
    for (var pi = 0; pi < allProfiles.length; pi++) {
      var s = scoreSummaryChunkForQuestion(chunk, allProfiles[pi], totalChunks);
      if (s > bestScore) bestScore = s;
    }
    if (bestScore > 0 || questionProfile.broadSummary) {
      scored.push({ chunk: chunk, score: bestScore });
    }
  }

  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    var aPos = totalChunks > 0 ? a.chunk.chunkIndex / totalChunks : 0;
    var bPos = totalChunks > 0 ? b.chunk.chunkIndex / totalChunks : 0;
    return Math.abs(aPos - 0.5) - Math.abs(bPos - 0.5);
  });

  // Deduplicate and diversify
  var results = [];
  var selectedIndices = {};
  for (var ri = 0; ri < scored.length && results.length < maxCount; ri++) {
    var idx = scored[ri].chunk.chunkIndex;
    if (selectedIndices[idx]) continue;
    selectedIndices[idx] = true;
    results.push(scored[ri].chunk);
  }

  return results;
}

function buildQuestionFocusBlock(questionProfile, options) {
  if (!questionProfile || !questionProfile.question) return "";
  var opts = options && typeof options === "object" ? options : {};
  var lines = [
    "=== QUESTION FOCUS ===",
    "Question: " + truncate(questionProfile.question, 240),
  ];
  if (opts.routeLabel) lines.push("Route: " + opts.routeLabel);
  if (questionProfile.scopes.length > 0) lines.push("Scopes: " + questionProfile.scopes.join(", "));
  lines.push("Confidence: " + questionProfile.confidence);
  if (questionProfile.bucketHints.length > 0) lines.push("Likely focus: " + questionProfile.bucketHints.join(", "));
  if (questionProfile.matchers.length > 0) {
    lines.push("Matches: " + questionProfile.matchers.slice(0, 6).map(function (matcher) { return matcher.value; }).join(" | "));
  }
  if (questionProfile.turnHints.length > 0) lines.push("Turn hints: " + questionProfile.turnHints.join(", "));
  if (opts.note) {
    lines.push(opts.note.indexOf(":") !== -1 ? opts.note : ("Note: " + opts.note));
  }
  return lines.join("\n");
}

function buildMetricQuestionMatch(questionProfile, metricCatalog) {
  if (!questionProfile || !questionProfile.normalizedQuestion || !metricCatalog) return null;
  var normalizedQuestion = questionProfile.normalizedQuestion;
  var longestAutonomousRun = metricCatalog.longestAutonomousRun;
  var longestToolCall = metricCatalog.longestToolCall;
  var topTool = Array.isArray(metricCatalog.topTools) && metricCatalog.topTools.length > 0 ? metricCatalog.topTools[0] : null;
  var autonomy = metricCatalog.autonomy || {};

  if (normalizedQuestion.indexOf("longest") !== -1 &&
      normalizedQuestion.indexOf("autonomous") !== -1 &&
      hasAnyTerm(normalizedQuestion, ["run", "turn", "stretch", "span"])) {
    if (!longestAutonomousRun) return null;
    return {
      key: "longest-autonomous-run",
      answer: "The longest autonomous run lasted " + formatMetricDuration(longestAutonomousRun.duration) +
        " in [Turn " + longestAutonomousRun.turnIndex + "]." +
        (longestAutonomousRun.userMessage ? " It started from \"" + truncate(longestAutonomousRun.userMessage, 140) + "\"." : ""),
      references: [{ turnIndex: longestAutonomousRun.turnIndex }],
      detail: "Matched the longest autonomous run from the precomputed metrics catalog.",
    };
  }

  if (normalizedQuestion.indexOf("longest") !== -1 &&
      hasAnyTerm(normalizedQuestion, ["tool call", "tool", "execution", "command"])) {
    if (!longestToolCall) return null;
    return {
      key: "longest-tool-call",
      answer: "The longest tool call was " + longestToolCall.toolName +
        " in [Turn " + longestToolCall.turnIndex + "], lasting " +
        formatMetricDuration(longestToolCall.duration) + ".",
      references: longestToolCall.turnIndex != null ? [{ turnIndex: longestToolCall.turnIndex }] : [],
      detail: "Matched the longest tool execution from the precomputed metrics catalog.",
    };
  }

  if ((normalizedQuestion.indexOf("tool call") !== -1 || normalizedQuestion.indexOf("tool calls") !== -1) &&
      hasAnyTerm(normalizedQuestion, ["how many", "total", "number of"])) {
    return {
      key: "total-tool-calls",
      answer: "The session made " + formatMetricCount(metricCatalog.totalToolCalls, "tool call") + ".",
      references: [],
      detail: "Matched the total tool-call count from the precomputed metrics catalog.",
    };
  }

  if (normalizedQuestion.indexOf("turn") !== -1 && hasAnyTerm(normalizedQuestion, ["how many", "total", "number of"])) {
    var turnCount = metricCatalog.totalTurns;
    var turnAnswer = "The session has " + formatMetricCount(turnCount, "turn") + ".";
    if (typeof turnCount === "number" && turnCount > 0) {
      turnAnswer += " Turn indices are zero-based (0 through " + (turnCount - 1) + ").";
    }
    return {
      key: "total-turns",
      answer: turnAnswer,
      references: [],
      detail: "Matched the total turn count from the precomputed metrics catalog.",
    };
  }

  if (normalizedQuestion.indexOf("error") !== -1 && hasAnyTerm(normalizedQuestion, ["how many", "total", "number of", "count"])) {
    return {
      key: "error-count",
      answer: "The session recorded " + formatMetricCount(metricCatalog.errorCount, "error") + ".",
      references: [],
      detail: "Matched the error count from the precomputed metrics catalog.",
    };
  }

  if ((normalizedQuestion.indexOf("input token") !== -1 || normalizedQuestion.indexOf("output token") !== -1 || normalizedQuestion.indexOf("token") !== -1) &&
      hasAnyTerm(normalizedQuestion, ["how many", "total", "count", "usage"])) {
    return {
      key: "token-usage",
      answer: "The session used " + formatMetricCount(metricCatalog.inputTokens, "input token") +
        " and " + formatMetricCount(metricCatalog.outputTokens, "output token") +
        " for " + formatMetricCount(metricCatalog.totalTokens, "token") + " total.",
      references: [],
      detail: "Matched token usage from the precomputed metrics catalog.",
    };
  }

  if (normalizedQuestion.indexOf("cost") !== -1 || normalizedQuestion.indexOf("price") !== -1) {
    return {
      key: "session-cost",
      answer: "The estimated session cost is " + formatMetricCurrency(metricCatalog.totalCost) + ".",
      references: [],
      detail: "Matched the session cost from the precomputed metrics catalog.",
    };
  }

  if ((normalizedQuestion.indexOf("most used tool") !== -1 || normalizedQuestion.indexOf("top tool") !== -1 ||
      normalizedQuestion.indexOf("used most") !== -1 || normalizedQuestion.indexOf("most frequent tool") !== -1) && topTool) {
    return {
      key: "top-tool",
      answer: "The most-used tool was " + topTool.name + " with " + formatMetricCount(topTool.count, "call") + ".",
      references: [],
      detail: "Matched top tool usage from the precomputed metrics catalog.",
    };
  }

  if (normalizedQuestion.indexOf("autonomy efficiency") !== -1 && autonomy.autonomyEfficiency != null) {
    return {
      key: "autonomy-efficiency",
      answer: "Autonomy efficiency was " + Math.round(autonomy.autonomyEfficiency * 100) + "%.",
      references: [],
      detail: "Matched autonomy efficiency from the precomputed metrics catalog.",
    };
  }

  if ((normalizedQuestion.indexOf("human response") !== -1 || normalizedQuestion.indexOf("babysitting") !== -1) &&
      autonomy.babysittingTime != null) {
    return {
      key: "human-response-time",
      answer: "Total human response time was " + formatMetricDuration(autonomy.babysittingTime) + ".",
      references: [],
      detail: "Matched human response time from the precomputed metrics catalog.",
    };
  }

  if (normalizedQuestion.indexOf("idle time") !== -1 && autonomy.idleTime != null) {
    return {
      key: "idle-time",
      answer: "Total idle time was " + formatMetricDuration(autonomy.idleTime) + ".",
      references: [],
      detail: "Matched idle time from the precomputed metrics catalog.",
    };
  }

  if (normalizedQuestion.indexOf("intervention") !== -1 && autonomy.interventionCount != null) {
    return {
      key: "interventions",
      answer: "The session had " + formatMetricCount(autonomy.interventionCount, "intervention") + ".",
      references: [],
      detail: "Matched intervention count from the precomputed metrics catalog.",
    };
  }

  if ((normalizedQuestion.indexOf("how long") !== -1 || normalizedQuestion.indexOf("duration") !== -1) &&
      normalizedQuestion.indexOf("session") !== -1) {
    return {
      key: "session-duration",
      answer: "The session lasted " + formatMetricDuration(metricCatalog.duration) + ".",
      references: [],
      detail: "Matched session duration from the precomputed metrics catalog.",
    };
  }

  return null;
}

function questionAsksForCount(normalizedQuestion) {
  if (!normalizedQuestion) return false;
  return hasAnyTerm(normalizedQuestion, ["how many", "count", "number of", "total"]);
}

function questionAsksForSummary(normalizedQuestion) {
  if (!normalizedQuestion) return false;
  return hasAnyTerm(normalizedQuestion, [
    "what happened",
    "what did",
    "summarize",
    "summary",
    "overall approach",
    "walk me through",
  ]);
}

function normalizeProgramSlotValues(values) {
  if (!Array.isArray(values) || values.length === 0) return [];
  var normalized = [];
  for (var i = 0; i < values.length; i++) {
    var value = normalizeSearchValue(values[i]);
    if (!value) continue;
    pushUniqueValue(normalized, value);
  }
  return normalized.sort();
}

function buildSessionQAQueryProgramSlots(questionProfile, metricMatch) {
  var safeProfile = questionProfile && typeof questionProfile === "object" ? questionProfile : {};
  var turnHints = Array.isArray(safeProfile.turnHints)
    ? safeProfile.turnHints
      .map(function (value) { return Number(value); })
      .filter(function (value) { return Number.isFinite(value) && value >= 0; })
      .sort(function (left, right) { return left - right; })
    : [];

  return {
    metricKey: metricMatch ? metricMatch.key : null,
    turnHints: turnHints,
    toolNames: normalizeProgramSlotValues(safeProfile.matchedToolNames),
    pathTerms: normalizeProgramSlotValues(safeProfile.pathTerms),
    commandTerms: normalizeProgramSlotValues(safeProfile.commandTerms),
    queryTerms: normalizeProgramSlotValues(safeProfile.queryTerms),
    repoTerms: normalizeProgramSlotValues(safeProfile.entities && safeProfile.entities.repos),
    identifierTerms: normalizeProgramSlotValues(safeProfile.entities && safeProfile.entities.identifiers),
    wantsErrors: Boolean(safeProfile.wantsErrors),
    wantsCommands: Boolean(safeProfile.wantsCommands),
    wantsQueries: Boolean(safeProfile.wantsQueries),
    wantsPaths: Boolean(safeProfile.wantsPaths),
    wantsTools: Boolean(safeProfile.wantsTools),
    broadSummary: Boolean(safeProfile.broadSummary),
    requiresExactEvidence: Boolean(safeProfile.requiresExactEvidence),
  };
}

function determineSessionQAProgramFamily(questionProfile, metricMatch) {
  var normalizedQuestion = questionProfile && questionProfile.normalizedQuestion
    ? questionProfile.normalizedQuestion
    : "";

  if (metricMatch) {
    return {
      family: "metric",
      intent: metricMatch.key || "metric-lookup",
      routePreference: "metric",
      canAnswerFromFactStore: true,
      deterministic: true,
      needsModel: false,
      raceEligible: false,
    };
  }

  if (questionProfile && questionProfile.requiresExactEvidence &&
      !(questionProfile.wantsPaths && (!questionProfile.pathTerms || questionProfile.pathTerms.length === 0) && questionProfile.matchers.length === 0) &&
      !(questionProfile.wantsErrors && questionProfile.matchers.length === 0 && (!questionProfile.pathTerms || questionProfile.pathTerms.length === 0))) {
    return {
      family: "exact-raw-evidence",
      intent: "exact-evidence",
      routePreference: questionMentionsRawJsonl(questionProfile) ? "raw-full" : "raw-targeted",
      canAnswerFromFactStore: true,
      deterministic: true,
      needsModel: false,
      raceEligible: false,
    };
  }

  if (questionProfile && questionProfile.turnHints && questionProfile.turnHints.length > 0) {
    return {
      family: "turn-lookup",
      intent: questionAsksForCount(normalizedQuestion) ? "turn-count" : "turn-summary",
      routePreference: "index",
      canAnswerFromFactStore: true,
      deterministic: true,
      needsModel: false,
      raceEligible: false,
    };
  }

  if (questionProfile && questionProfile.matchedToolNames && questionProfile.matchedToolNames.length > 0) {
    return {
      family: "tool-lookup",
      intent: questionAsksForCount(normalizedQuestion) ? "tool-count" : "tool-summary",
      routePreference: "index",
      canAnswerFromFactStore: true,
      deterministic: true,
      needsModel: false,
      raceEligible: false,
    };
  }

  if (questionProfile && questionProfile.pathTerms && questionProfile.pathTerms.length > 0) {
    return {
      family: "file-lookup",
      intent: questionAsksForCount(normalizedQuestion) ? "file-count" : "file-summary",
      routePreference: "index",
      canAnswerFromFactStore: true,
      deterministic: true,
      needsModel: false,
      raceEligible: false,
    };
  }

  if (questionProfile && questionProfile.wantsPaths && questionProfile.pathTerms.length === 0) {
    return {
      family: "file-lookup",
      intent: "file-list",
      routePreference: "index",
      canAnswerFromFactStore: true,
      deterministic: true,
      needsModel: false,
      raceEligible: false,
    };
  }

  if (questionProfile && (questionProfile.wantsCommands || questionProfile.wantsQueries)) {
    return {
      family: "command-query-lookup",
      intent: questionAsksForCount(normalizedQuestion) ? "query-count" : "query-summary",
      routePreference: "index",
      canAnswerFromFactStore: true,
      deterministic: true,
      needsModel: false,
      raceEligible: false,
    };
  }

  if (questionProfile && questionProfile.wantsErrors) {
    return {
      family: "error-diagnosis",
      intent: "error-diagnosis",
      routePreference: "index",
      canAnswerFromFactStore: true,
      deterministic: false,
      needsModel: true,
      raceEligible: true,
    };
  }

  if (questionProfile && questionProfile.broadSummary) {
    return {
      family: "session-summary",
      intent: questionAsksForSummary(normalizedQuestion) ? "summary" : "broad-summary",
      routePreference: "chunk",
      canAnswerFromFactStore: true,
      deterministic: false,
      needsModel: true,
      raceEligible: true,
    };
  }

  return {
    family: "broad-synthesis",
    intent: "structured-synthesis",
    routePreference: "model",
    canAnswerFromFactStore: true,
    deterministic: false,
    needsModel: true,
    raceEligible: true,
  };
}

export function compileSessionQAQueryProgram(question, artifacts, options) {
  var opts = options && typeof options === "object" ? options : {};
  var questionProfile = opts.questionProfile || buildQAQuestionProfile(question, { artifacts: artifacts });
  var metricCatalog = artifacts && artifacts.metricCatalog ? artifacts.metricCatalog : null;
  var metricMatch = opts.metricMatch || buildMetricQuestionMatch(questionProfile, metricCatalog);
  var familyInfo = determineSessionQAProgramFamily(questionProfile, metricMatch);
  var slots = buildSessionQAQueryProgramSlots(questionProfile, metricMatch);

  return {
    family: familyInfo.family,
    intent: familyInfo.intent,
    routePreference: familyInfo.routePreference,
    canAnswerFromFactStore: familyInfo.canAnswerFromFactStore,
    deterministic: familyInfo.deterministic,
    needsModel: familyInfo.needsModel,
    raceEligible: familyInfo.raceEligible,
    confidence: questionProfile.confidence || "low",
    question: questionProfile.question || "",
    normalizedQuestion: questionProfile.normalizedQuestion || "",
    evidenceMode: slots.requiresExactEvidence
      ? "exact"
      : (slots.broadSummary ? "summary" : "structured"),
    slots: slots,
    totalTurns: metricCatalog && typeof metricCatalog.totalTurns === "number" ? metricCatalog.totalTurns : null,
    metricMatch: metricMatch ? {
      key: metricMatch.key || null,
      answer: metricMatch.answer || "",
      references: Array.isArray(metricMatch.references) ? metricMatch.references : [],
      detail: metricMatch.detail || "",
    } : null,
    questionProfile: questionProfile,
  };
}

export function buildSessionQAProgramCacheKey(program, options) {
  if (!program || typeof program !== "object") return "";
  var opts = options && typeof options === "object" ? options : {};
  return stableSerialize({
    version: 1,
    fingerprint: opts.fingerprint ? String(opts.fingerprint) : "",
    family: program.family || "",
    intent: program.intent || "",
    routePreference: program.routePreference || "",
    evidenceMode: program.evidenceMode || "",
    slots: program.slots || {},
  });
}

export function describeSessionQAQueryProgram(program) {
  if (!program || typeof program !== "object") return "the structured session router";
  var family = String(program.family || "").trim();
  if (!family) return "the structured session router";
  return family.replace(/-/g, " ");
}

function questionMentionsRawJsonl(questionProfile) {
  if (!questionProfile || !questionProfile.normalizedQuestion) return false;
  return hasAnyTerm(questionProfile.normalizedQuestion, [
    "raw jsonl",
    "full jsonl",
    "entire jsonl",
    "whole jsonl",
    "raw file",
    "entire file",
    "whole file",
  ]);
}

export function routeSessionQAQuestion(question, artifacts, options) {
  var opts = options && typeof options === "object" ? options : {};
  var queryProgram = opts.queryProgram || compileSessionQAQueryProgram(question, artifacts, opts);
  var questionProfile = queryProgram.questionProfile || opts.questionProfile || buildQAQuestionProfile(question, { artifacts: artifacts });
  var metricMatch = queryProgram.metricMatch || null;
  if (metricMatch) {
    return {
      kind: "metric",
      phase: "using-precomputed-metrics",
      status: "Using precomputed metrics...",
      detail: metricMatch.detail,
      profile: questionProfile,
      directAnswer: metricMatch.answer,
      references: metricMatch.references || [],
      metricKey: metricMatch.key,
      queryProgram: queryProgram,
    };
  }

  var relevantEntries = selectRelevantToolCallEntries(artifacts, questionProfile, MAX_FOCUSED_TOOL_CALLS);
  var relevantChunks = selectRelevantSummaryChunks(artifacts, questionProfile, MAX_SUMMARY_CHUNK_RESULTS);
  var rawAvailable = Boolean(
    opts.rawText ||
    (opts.rawIndex && Array.isArray(opts.rawIndex.records) && opts.rawIndex.records.length > 0) ||
    opts.sessionFilePath ||
    (artifacts && artifacts.rawLookup && artifacts.rawLookup.rawText)
  );
  var exactRawEntries = relevantEntries.filter(function (entry) {
    return Boolean(entry && entry.rawSlice);
  });

  if (questionMentionsRawJsonl(questionProfile) && rawAvailable) {
    return {
      kind: "raw-full",
      phase: "reading-full-raw",
      status: "Reading full raw JSONL...",
      detail: "Falling back to the full raw JSONL scan. This may take a while.",
      profile: questionProfile,
      relevantEntries: relevantEntries,
      relevantChunks: relevantChunks,
      queryProgram: queryProgram,
    };
  }

  if (exactRawEntries.length > 0 && questionProfile.requiresExactEvidence) {
    return {
      kind: "raw-targeted",
      phase: "reading-targeted-raw",
      status: "Reading targeted raw JSONL slices...",
      detail: "Using exact raw JSONL slices for the best matching tool calls.",
      profile: questionProfile,
      relevantEntries: exactRawEntries,
      relevantChunks: relevantChunks,
      queryProgram: queryProgram,
    };
  }

  if (questionProfile.broadSummary) {
    var rewrites = generateBroadQueryRewrites(question, questionProfile);
    var relevantChunksForBroad = rewrites.length > 0
      ? selectDiverseChunksFromRewrites(artifacts, questionProfile, rewrites, MAX_SUMMARY_CHUNK_RESULTS)
      : selectRelevantSummaryChunks(artifacts, questionProfile, MAX_SUMMARY_CHUNK_RESULTS);
    return {
      kind: "chunk",
      phase: "scanning-summary-chunks",
      status: "Scanning summary chunks...",
      detail: rewrites.length > 0
        ? "Using rewrite-expanded retrieval across precomputed summary chunks."
        : "Using bounded session summary chunks instead of the full session timeline.",
      profile: questionProfile,
      relevantEntries: relevantEntries,
      relevantChunks: relevantChunks.length > 0
        ? relevantChunks
        : relevantChunksForBroad,
      queryProgram: queryProgram,
    };
  }

  if (relevantEntries.length > 0) {
    return {
      kind: "index",
      phase: "searching-index",
      status: "Searching tool and query index...",
      detail: "Using the precomputed tool, query, and path indexes.",
      profile: questionProfile,
      relevantEntries: relevantEntries,
      relevantChunks: relevantChunks,
      queryProgram: queryProgram,
    };
  }

  if (relevantChunks.length > 0 || questionProfile.broadSummary) {
    var fallbackRewrites = questionProfile.broadSummary ? generateBroadQueryRewrites(question, questionProfile) : [];
    var fallbackChunks = relevantChunks.length > 0
      ? relevantChunks
      : (fallbackRewrites.length > 0
        ? selectDiverseChunksFromRewrites(artifacts, questionProfile, fallbackRewrites, MAX_SUMMARY_CHUNK_RESULTS)
        : selectRelevantSummaryChunks(artifacts, questionProfile, MAX_SUMMARY_CHUNK_RESULTS));
    return {
      kind: "chunk",
      phase: "scanning-summary-chunks",
      status: "Scanning summary chunks...",
      detail: fallbackRewrites.length > 0
        ? "Using rewrite-expanded retrieval across precomputed summary chunks."
        : "Using bounded session summary chunks instead of the full session timeline.",
      profile: questionProfile,
      relevantEntries: relevantEntries,
      relevantChunks: fallbackChunks,
      queryProgram: queryProgram,
    };
  }

  if (rawAvailable && questionProfile.requiresExactEvidence) {
    return {
      kind: "raw-full",
      phase: "reading-full-raw",
      status: "Reading full raw JSONL...",
      detail: "No strong structured match was found, so AGENTVIZ is falling back to the full raw JSONL. This may take a while.",
      profile: questionProfile,
      relevantEntries: relevantEntries,
      relevantChunks: relevantChunks,
      queryProgram: queryProgram,
    };
  }

  return {
    kind: "model",
    phase: "retrieving-context",
    status: "Retrieving session context...",
    detail: "Falling back to the broader structured session context.",
    profile: questionProfile,
    relevantEntries: relevantEntries,
    relevantChunks: relevantChunks,
    queryProgram: queryProgram,
  };
}

export function scanRawJsonlQuestionMatches(rawIndex, question, options) {
  if (!rawIndex || !Array.isArray(rawIndex.records)) return [];
  var opts = options && typeof options === "object" ? options : {};
  var questionProfile = opts.questionProfile || buildQAQuestionProfile(question, { artifacts: opts.artifacts });
  if (!questionProfile.normalizedQuestion) return [];
  var maxCount = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : MAX_RAW_MATCH_RESULTS;
  var scored = [];

  for (var i = 0; i < rawIndex.records.length; i++) {
    var record = rawIndex.records[i];
    var normalizedSearch = normalizeSearchValue(record && (record.text || JSON.stringify(record.value || {})));
    if (!normalizedSearch) continue;
    var score = 0;

    for (var matcherIndex = 0; matcherIndex < questionProfile.matchers.length; matcherIndex++) {
      if (normalizedSearch.indexOf(questionProfile.matchers[matcherIndex].value) !== -1) score += 8;
    }
    for (var tokenIndex = 0; tokenIndex < questionProfile.tokens.length; tokenIndex++) {
      var token = questionProfile.tokens[tokenIndex];
      if (normalizedSearch.indexOf(token) !== -1) score += token.length >= 6 ? 2 : 1;
    }
    if (questionProfile.wantsErrors && normalizedSearch.indexOf("error") !== -1) score += 3;
    if (countNormalizedMatches([normalizedSearch], questionProfile.entities.urls) > 0) score += 3;
    if (countNormalizedMatches([normalizedSearch], questionProfile.entities.repos) > 0) score += 3;

    if (score <= 0) continue;
    scored.push({
      recordIndex: record.recordIndex,
      lineStart: record.lineStart,
      lineEnd: record.lineEnd,
      text: record.text,
      score: score,
    });
  }

  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return a.recordIndex - b.recordIndex;
  });

  return scored.slice(0, maxCount);
}

function buildRawSourceFingerprint(options) {
  if (!options || typeof options !== "object") return "";
  if (typeof options.rawText === "string" && options.rawText) {
    return [
      options.rawText.length,
      options.rawText.substring(0, 48),
      options.rawText.substring(Math.max(0, options.rawText.length - 48)),
    ].join("|");
  }
  if (options.rawIndex && Array.isArray(options.rawIndex.records)) {
    return [
      "index",
      options.rawIndex.records.length,
      options.rawIndex.malformedLines || 0,
    ].join("|");
  }
  if (options.rawLookup && options.rawLookup.rawIndex && Array.isArray(options.rawLookup.rawIndex.records)) {
    return [
      "lookup",
      options.rawLookup.rawIndex.records.length,
      options.rawLookup.rawIndex.malformedLines || 0,
    ].join("|");
  }
  return "";
}

function buildArtifactsFingerprint(events, turns, options) {
  var lastEvent = events && events.length > 0 ? events[events.length - 1] : null;
  var lastTurn = turns && turns.length > 0 ? turns[turns.length - 1] : null;
  return [
    Array.isArray(events) ? events.length : 0,
    Array.isArray(turns) ? turns.length : 0,
    lastEvent && lastEvent.t != null ? lastEvent.t : "",
    lastEvent && lastEvent.toolName ? lastEvent.toolName : "",
    lastTurn && lastTurn.index != null ? lastTurn.index : "",
    lastTurn && lastTurn.endTime != null ? lastTurn.endTime : "",
    buildRawSourceFingerprint(options),
  ].join("|");
}

function buildLedgerStats(events, ledger) {
  var safeEvents = Array.isArray(events) ? events : [];
  var safeLedger = Array.isArray(ledger) ? ledger : [];
  var toolCounts = {};
  var fileCounts = {};
  var errorList = [];

  for (var i = 0; i < safeLedger.length; i++) {
    var entry = safeLedger[i];
    toolCounts[entry.toolName] = (toolCounts[entry.toolName] || 0) + 1;
    for (var pathIndex = 0; pathIndex < entry.entities.paths.length; pathIndex++) {
      var filePath = entry.entities.paths[pathIndex];
      if (!fileCounts[filePath]) fileCounts[filePath] = { views: 0, edits: 0 };
      if (entry.classification.operation === "write") fileCounts[filePath].edits += 1;
      else fileCounts[filePath].views += 1;
    }
  }

  for (var eventIndex = 0; eventIndex < safeEvents.length; eventIndex++) {
    var event = safeEvents[eventIndex];
    if (!event || !event.isError) continue;
    errorList.push({
      turn: event.turnIndex != null ? event.turnIndex : "?",
      tool: event.toolName || "unknown",
      text: truncate(event.text, 200),
    });
  }

  return {
    toolCounts: toolCounts,
    toolRanking: Object.entries(toolCounts).sort(function (a, b) { return b[1] - a[1]; }),
    fileEntries: Object.entries(fileCounts)
      .sort(function (a, b) { return (b[1].views + b[1].edits) - (a[1].views + a[1].edits); }),
    errorList: errorList,
  };
}

function getCachedArtifacts(events, turns, fingerprint) {
  if (!Array.isArray(events) || !Array.isArray(turns)) return null;
  var turnsCache = SESSION_QA_CACHE.get(events);
  if (!turnsCache) return null;
  var cached = turnsCache.get(turns);
  if (!cached || cached.fingerprint !== fingerprint) return null;
  return cached.value;
}

function storeCachedArtifacts(events, turns, fingerprint, value) {
  if (!Array.isArray(events) || !Array.isArray(turns)) return value;
  var turnsCache = SESSION_QA_CACHE.get(events);
  if (!turnsCache) {
    turnsCache = new WeakMap();
    SESSION_QA_CACHE.set(events, turnsCache);
  }
  turnsCache.set(turns, { fingerprint: fingerprint, value: value });
  return value;
}

/**
 * Build reusable Q&A artifacts that can later be cached at the session level.
 */
export function buildSessionQAArtifacts(events, turns, metadata, options) {
  var opts = options && typeof options === "object" ? options : null;
  var safeEvents = Array.isArray(events) ? events : [];
  var safeTurns = Array.isArray(turns) ? turns : [];
  var fingerprint = buildArtifactsFingerprint(safeEvents, safeTurns, opts);
  var cached = getCachedArtifacts(safeEvents, safeTurns, fingerprint);
  if (cached) return cached;

  var turnRecords = buildTurnRecords(safeEvents, safeTurns);
  var ledger = buildToolCallLedger(safeEvents, turnRecords);
  var rawLookup = null;
  if (opts && (opts.rawLookup || opts.rawIndex || typeof opts.rawText === "string")) {
    rawLookup = opts.rawLookup || buildToolCallRawLookup(safeEvents, turnRecords, opts.rawText, {
      ledger: ledger,
      rawIndex: opts.rawIndex,
    });
    attachRawSlicesToLedger(ledger, rawLookup);
  }
  var ledgerIndex = buildToolCallSearchIndex(ledger);
  if (rawLookup) {
    rawLookup.ledger = ledger;
    rawLookup.ledgerIndex = ledgerIndex;
  }
  var turnSummaries = buildTurnSummaries(safeEvents, turnRecords, { ledger: ledger });
  var stats = buildLedgerStats(safeEvents, ledger);
  var summaryChunks = buildSessionSummaryChunks(safeEvents, turnRecords, {
    ledger: ledger,
    turnSummaries: turnSummaries,
  });
  var metricCatalog = buildSessionMetricCatalog(safeEvents, turnRecords, metadata, {
    ledger: ledger,
    stats: stats,
    summaryChunks: summaryChunks,
    rawIndex: rawLookup ? rawLookup.rawIndex : (opts && opts.rawIndex ? opts.rawIndex : null),
  });
  var artifacts = {
    turnRecords: turnRecords,
    ledger: ledger,
    ledgerIndex: ledgerIndex,
    turnSummaries: turnSummaries,
    summaryChunks: summaryChunks,
    stats: stats,
    metricCatalog: metricCatalog,
    metadata: metadata || null,
    rawLookup: rawLookup,
    rawIndex: rawLookup ? rawLookup.rawIndex : (opts && opts.rawIndex ? opts.rawIndex : null),
  };

  return storeCachedArtifacts(safeEvents, safeTurns, fingerprint, artifacts);
}

function extractQuestionSearchText(question) {
  var text = typeof question === "string" ? question : "";
  if (!text) return "";

  var normalized = text.toLowerCase();
  var marker = "current question:";
  var markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex !== -1) {
    return text.substring(markerIndex + marker.length).trim();
  }
  return text.trim();
}

function extractQuotedQuestionPhrases(question) {
  var phrases = [];
  if (typeof question !== "string" || !question.trim()) return phrases;

  var regex = /`([^`]+)`|"([^"]+)"|'([^']+)'/g;
  var match;
  while ((match = regex.exec(question)) !== null) {
    var phrase = normalizeSearchValue(match[1] || match[2] || match[3] || "");
    if (phrase.length < 3) continue;
    pushUniqueValue(phrases, phrase);
  }
  return phrases;
}

function tokenizeQuestion(question) {
  var normalized = normalizeSearchValue(question);
  if (!normalized) return [];

  var rawTokens = normalized.split(/[^a-z0-9#./:_-]+/g);
  var tokens = [];
  for (var i = 0; i < rawTokens.length; i++) {
    var token = rawTokens[i];
    if (!token || token.length < 2) continue;
    if (/^\d+$/.test(token)) continue;
    if (QUESTION_STOP_WORDS[token]) continue;
    pushUniqueValue(tokens, token);
  }
  return tokens;
}

function trimQuestionPhrase(value) {
  return normalizeSearchValue(String(value || "").replace(/^[\s"'`([{]+/, "").replace(/[\s"'`)\]}?!,;]+$/, ""));
}

function extractQuestionTurnHints(question) {
  var turnHints = [];
  if (typeof question !== "string") return turnHints;

  var regex = /\bturn\s+(\d+)\b/gi;
  var match;
  while ((match = regex.exec(question)) !== null) {
    pushUniqueValue(turnHints, String(parseInt(match[1], 10)));
  }
  return turnHints.map(function (value) { return parseInt(value, 10); });
}

function normalizeQuestionSequenceToken(value) {
  return trimQuestionPhrase(String(value || "").replace(/^[\s"'`([{]+/, "").replace(/[\s"'`)\]}]+$/, ""));
}

function looksLikeQuestionSequenceArgument(value) {
  return /^[-./\\]/.test(value) || value.indexOf("=") !== -1 || /^[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function collectQuestionSequences(question, isStartToken, stopLookup, minTokens) {
  var sequences = [];
  if (typeof question !== "string" || !question.trim()) return sequences;

  var rawTokens = question.split(/\s+/);
  var minimumTokens = typeof minTokens === "number" && minTokens > 0 ? minTokens : 1;

  for (var i = 0; i < rawTokens.length; i++) {
    var firstToken = normalizeQuestionSequenceToken(rawTokens[i]);
    var normalizedFirstToken = normalizeSearchValue(firstToken);
    if (!normalizedFirstToken || !isStartToken(firstToken, normalizedFirstToken)) continue;

    var parts = [firstToken];
    for (var j = i + 1; j < rawTokens.length && parts.length < 8; j++) {
      var nextToken = normalizeQuestionSequenceToken(rawTokens[j]);
      var normalizedNextToken = normalizeSearchValue(nextToken);
      if (!normalizedNextToken) break;
      if (stopLookup[normalizedNextToken] && !looksLikeQuestionSequenceArgument(nextToken)) break;
      parts.push(nextToken);
      if (/[?!.]$/.test(rawTokens[j])) break;
    }

    if (parts.length < minimumTokens) continue;
    pushUniqueValue(sequences, parts.join(" "));
  }

  return sequences;
}

function looksLikeCommandPhrase(value) {
  if (!value) return false;
  var normalized = normalizeSearchValue(value);
  if (!normalized) return false;
  var firstToken = normalized.split(/\s+/)[0];
  return Boolean(COMMAND_PREFIXES[firstToken] || /\s--/.test(normalized) || /^(\.\/|\.\\)/.test(normalized));
}

function looksLikeQueryPhrase(value) {
  if (!value) return false;
  return /(^|[\s(])(repo:|label:|path:|is:|language:|sort:|order:)/i.test(value) ||
    /\b(select|from|where|match|regex|sql|kusto)\b/i.test(value);
}

function extractQuestionPathTerms(question, entities) {
  var paths = [];
  var safeEntities = entities && typeof entities === "object" ? entities : null;

  if (safeEntities && Array.isArray(safeEntities.paths)) {
    for (var i = 0; i < safeEntities.paths.length; i++) pushUniqueValue(paths, safeEntities.paths[i]);
  }

  if (typeof question !== "string") return paths;
  var fileMatches = question.match(/\b[A-Za-z0-9_.-]+\.[A-Za-z0-9_-]+\b/g) || [];
  for (var fileIndex = 0; fileIndex < fileMatches.length; fileIndex++) {
    var candidate = trimQuestionPhrase(fileMatches[fileIndex]);
    if (!candidate || candidate.indexOf("://") !== -1) continue;
    pushUniqueValue(paths, candidate);
  }
  return paths;
}

function questionContainsToolName(question, toolName) {
  var normalizedQuestion = normalizeSearchValue(question);
  var normalizedToolName = normalizeSearchValue(toolName);
  if (!normalizedQuestion || !normalizedToolName) return false;
  if (normalizedToolName.length <= 2) {
    var escaped = normalizedToolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp("(^|[^a-z0-9_])" + escaped + "([^a-z0-9_]|$)").test(normalizedQuestion);
  }
  return normalizedQuestion.indexOf(normalizedToolName) !== -1;
}

function addQuestionScope(scopes, value) {
  if (!value) return;
  pushUniqueValue(scopes, value);
}

function addQuestionMatcher(matchers, value, scopes, allowContains) {
  var normalizedValue = normalizeSearchValue(value);
  if (!normalizedValue) return;

  for (var i = 0; i < matchers.length; i++) {
    if (matchers[i].value !== normalizedValue) continue;
    var nextScopes = Array.isArray(scopes) ? scopes : [];
    for (var scopeIndex = 0; scopeIndex < nextScopes.length; scopeIndex++) {
      pushUniqueValue(matchers[i].scopes, nextScopes[scopeIndex]);
    }
    if (allowContains) matchers[i].allowContains = true;
    return;
  }

  matchers.push({
    value: normalizedValue,
    scopes: Array.isArray(scopes) ? scopes.slice() : [],
    allowContains: Boolean(allowContains),
  });
}

export function classifySessionQAQuestion(question, options) {
  var searchQuestion = extractQuestionSearchText(question);
  var normalizedQuestion = normalizeSearchValue(searchQuestion);
  var tokens = tokenizeQuestion(searchQuestion);
  var phrases = extractQuotedQuestionPhrases(searchQuestion);
  var commandTerms = collectQuestionSequences(searchQuestion, function (token, normalizedToken) {
    return Boolean(COMMAND_PREFIXES[normalizedToken]);
  }, COMMAND_STOP_WORDS, 2);
  var queryTerms = collectQuestionSequences(searchQuestion, function (token, normalizedToken) {
    return Boolean(QUERY_START_WORDS[normalizedToken] || normalizedToken.indexOf(":") !== -1);
  }, QUERY_STOP_WORDS, 1);
  var entities = extractToolCallEntities(null, searchQuestion);
  var pathTerms = extractQuestionPathTerms(searchQuestion, entities);
  var turnHints = extractQuestionTurnHints(searchQuestion);
  var artifacts = options && options.artifacts ? options.artifacts : null;
  var matchedToolNames = [];
  var scopes = [];
  var matchers = [];
  var bucketHints = [];

  var wantsErrors = false;
  var wantsTools = false;
  var wantsCommands = false;
  var wantsQueries = false;
  var wantsPaths = false;
  var wantsEarlySession = false;
  var wantsLateSession = false;

  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    if (EARLY_SESSION_TERMS[token]) wantsEarlySession = true;
    if (LATE_SESSION_TERMS[token]) wantsLateSession = true;
    if (QUERY_HINT_TERMS[token]) {
      wantsQueries = true;
      pushUniqueValue(bucketHints, "query");
      pushUniqueValue(bucketHints, "search");
    }
    if (COMMAND_HINT_TERMS[token]) {
      wantsCommands = true;
      pushUniqueValue(bucketHints, "command");
      pushUniqueValue(bucketHints, "execute");
    }
    if (TOOL_HINT_TERMS[token]) wantsTools = true;
    if (PATH_HINT_TERMS[token]) {
      wantsPaths = true;
      pushUniqueValue(bucketHints, "path");
    }
    if (ERROR_HINT_TERMS[token]) wantsErrors = true;
  }

  for (var pathIndex = 0; pathIndex < pathTerms.length; pathIndex++) {
    var pathValue = pathTerms[pathIndex];
    addQuestionScope(scopes, "path");
    addQuestionMatcher(matchers, pathValue, ["path"], pathValue.indexOf("/") === -1 && pathValue.indexOf("\\") === -1);
  }

  for (var commandIndex = 0; commandIndex < commandTerms.length; commandIndex++) {
    addQuestionScope(scopes, "command");
    addQuestionMatcher(matchers, commandTerms[commandIndex], ["command"], false);
  }

  for (var queryIndex = 0; queryIndex < queryTerms.length; queryIndex++) {
    addQuestionScope(scopes, "query");
    addQuestionMatcher(matchers, queryTerms[queryIndex], ["query"], false);
  }

  for (var urlIndex = 0; urlIndex < entities.urls.length; urlIndex++) {
    addQuestionMatcher(matchers, entities.urls[urlIndex], ["url"], false);
  }
  if (entities.urls.length > 0) addQuestionScope(scopes, "path");

  for (var repoIndex = 0; repoIndex < entities.repos.length; repoIndex++) {
    addQuestionMatcher(matchers, entities.repos[repoIndex], ["repo"], false);
  }
  if (entities.repos.length > 0) addQuestionScope(scopes, "query");

  for (var identifierIndex = 0; identifierIndex < entities.identifiers.length; identifierIndex++) {
    addQuestionMatcher(matchers, entities.identifiers[identifierIndex], ["identifier"], false);
  }

  for (var phraseIndex = 0; phraseIndex < phrases.length; phraseIndex++) {
    var phrase = phrases[phraseIndex];
    if (looksLikeCommandPhrase(phrase)) {
      addQuestionScope(scopes, "command");
      addQuestionMatcher(matchers, phrase, ["command"], false);
      continue;
    }
    if (looksLikeQueryPhrase(phrase)) {
      addQuestionScope(scopes, "query");
      addQuestionMatcher(matchers, phrase, ["query"], false);
    }
  }

  if (artifacts && artifacts.ledgerIndex && artifacts.ledgerIndex.byToolName) {
    var toolNames = Object.keys(artifacts.ledgerIndex.byToolName);
    for (var toolIndex = 0; toolIndex < toolNames.length; toolIndex++) {
      if (!questionContainsToolName(searchQuestion, toolNames[toolIndex])) continue;
      pushUniqueValue(matchedToolNames, toolNames[toolIndex]);
      addQuestionScope(scopes, "tool");
      addQuestionMatcher(matchers, toolNames[toolIndex], ["tool"], false);
    }
  }

  if (wantsCommands) addQuestionScope(scopes, "command");
  if (wantsQueries) addQuestionScope(scopes, "query");
  if (wantsPaths || pathTerms.length > 0) addQuestionScope(scopes, "path");
  if (wantsTools || matchedToolNames.length > 0) addQuestionScope(scopes, "tool");
  if (wantsErrors) addQuestionScope(scopes, "error");
  if (turnHints.length > 0) addQuestionScope(scopes, "turn");

  var broadSummary = normalizedQuestion ? matchers.length === 0 : false;
  if (broadSummary) {
    if (wantsErrors || wantsCommands || wantsQueries || wantsPaths || wantsTools) {
      broadSummary = false;
    } else {
      for (var tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
        if (BROAD_SUMMARY_TERMS[tokens[tokenIndex]]) {
          broadSummary = true;
          break;
        }
      }
    }
  }
  if (broadSummary) addQuestionScope(scopes, "broad summary");

  var requiresExactEvidence = matchers.length > 0;
  if (!requiresExactEvidence) {
    for (var exactIndex = 0; exactIndex < tokens.length; exactIndex++) {
      if (EXACT_EVIDENCE_TERMS[tokens[exactIndex]]) {
        requiresExactEvidence = true;
        break;
      }
    }
  }
  if (!requiresExactEvidence && bucketHints.length > 0 && !broadSummary) {
    requiresExactEvidence = true;
  }

  var confidence = "low";
  if (matchers.length >= 2 || turnHints.length > 0 || (matchers.length > 0 && matchedToolNames.length > 0)) confidence = "high";
  else if (matchers.length === 1 || wantsErrors || wantsCommands || wantsQueries || wantsPaths || wantsTools) confidence = "medium";
  if (broadSummary && matchers.length === 0) confidence = "low";

  return {
    question: searchQuestion,
    normalizedQuestion: normalizedQuestion,
    tokens: tokens,
    phrases: phrases,
    entities: entities,
    pathTerms: pathTerms,
    commandTerms: commandTerms,
    queryTerms: queryTerms,
    turnHints: turnHints,
    matchedToolNames: matchedToolNames,
    scopes: scopes,
    bucketHints: bucketHints,
    matchers: matchers,
    broadSummary: broadSummary,
    wantsErrors: wantsErrors,
    wantsTools: wantsTools,
    wantsCommands: wantsCommands,
    wantsQueries: wantsQueries,
    wantsPaths: wantsPaths,
    wantsEarlySession: wantsEarlySession,
    wantsLateSession: wantsLateSession,
    requiresExactEvidence: requiresExactEvidence,
    confidence: confidence,
  };
}

function buildQAQuestionProfile(question, options) {
  return classifySessionQAQuestion(question, options);
}

function countNormalizedMatches(entryValues, questionValues) {
  if (!Array.isArray(entryValues) || !Array.isArray(questionValues)) return 0;
  var count = 0;

  for (var i = 0; i < questionValues.length; i++) {
    var questionValue = normalizeSearchValue(questionValues[i]);
    if (!questionValue) continue;

    for (var j = 0; j < entryValues.length; j++) {
      var entryValue = normalizeSearchValue(entryValues[j]);
      if (!entryValue) continue;
      if (entryValue === questionValue || entryValue.indexOf(questionValue) !== -1 || questionValue.indexOf(entryValue) !== -1) {
        count += 1;
        break;
      }
    }
  }

  return count;
}

function collectQuestionCandidateEntries(artifacts, questionProfile) {
  if (!artifacts || !artifacts.ledgerIndex) return [];
  var index = artifacts.ledgerIndex;
  var ids = [];

  function addMatches(searchText, scopes, allowContains) {
    var matches = findToolCallEntries(index, searchText, {
      scopes: scopes,
      allowContains: allowContains === true,
      limit: 8,
    });
    for (var matchIndex = 0; matchIndex < matches.length; matchIndex++) {
      if (ids.indexOf(matches[matchIndex].id) === -1) ids.push(matches[matchIndex].id);
    }
  }

  for (var matcherIndex = 0; matcherIndex < questionProfile.matchers.length; matcherIndex++) {
    var matcher = questionProfile.matchers[matcherIndex];
    addMatches(matcher.value, matcher.scopes, matcher.allowContains);
  }
  for (var turnIndex = 0; turnIndex < questionProfile.turnHints.length; turnIndex++) {
    addMatches(String(questionProfile.turnHints[turnIndex]), ["turn"], false);
  }

  if (ids.length === 0) {
    return Array.isArray(artifacts.ledger) ? artifacts.ledger : [];
  }

  var entries = [];
  for (var idIndex = 0; idIndex < ids.length; idIndex++) {
    var entry = index.entriesById[ids[idIndex]];
    if (entry) entries.push(entry);
  }
  return entries;
}

function scoreEntryForQuestion(entry, questionProfile) {
  if (!entry || !questionProfile || !questionProfile.normalizedQuestion) return 0;

  var score = 0;
  var normalizedSearch = entry.searchTextNormalized || "";
  var normalizedUserMessage = normalizeSearchValue(entry.userMessage);
  var commandTerms = [];
  var queryTerms = [];
  var toolTerms = [];

  for (var matcherIndex = 0; matcherIndex < questionProfile.matchers.length; matcherIndex++) {
    var matcher = questionProfile.matchers[matcherIndex];
    if (matcher.scopes.indexOf("command") !== -1) pushUniqueValue(commandTerms, matcher.value);
    if (matcher.scopes.indexOf("query") !== -1) pushUniqueValue(queryTerms, matcher.value);
    if (matcher.scopes.indexOf("tool") !== -1) pushUniqueValue(toolTerms, matcher.value);
    if (matcher.scopes.indexOf("turn") !== -1 && String(entry.turnIndex) === matcher.value) score += 12;
  }

  if (questionProfile.normalizedQuestion.indexOf(entry.toolNameNormalized) !== -1) score += 8;
  if (countNormalizedMatches([entry.toolNameNormalized], toolTerms) > 0) score += 10;
  if (questionProfile.wantsErrors && entry.isError) score += questionProfile.matchers.length === 0 ? 8 : 6;

  for (var bucketIndex = 0; bucketIndex < questionProfile.bucketHints.length; bucketIndex++) {
    var bucketHint = questionProfile.bucketHints[bucketIndex];
    if (entry.classification.payloadType === bucketHint || entry.classification.operation === bucketHint) score += 4;
    else if (entry.classification.buckets.indexOf(bucketHint) !== -1) score += 4;
  }

  score += countNormalizedMatches(entry.entities.commands, commandTerms) * 10;
  score += countNormalizedMatches(entry.entities.queries, queryTerms) * 10;
  score += countNormalizedMatches(entry.entities.paths, questionProfile.pathTerms) * 8;
  score += countNormalizedMatches(entry.entities.urls, questionProfile.entities.urls) * 8;
  score += countNormalizedMatches(entry.entities.repos, questionProfile.entities.repos) * 6;
  score += countNormalizedMatches(entry.entities.identifiers, questionProfile.entities.identifiers) * 6;

  if (questionProfile.wantsCommands && commandTerms.length === 0) {
    if (entry.classification.payloadType === "command" || entry.classification.operation === "execute") score += 3;
  }
  if (questionProfile.wantsQueries && queryTerms.length === 0) {
    if (entry.classification.payloadType === "query" || entry.classification.operation === "search") score += 3;
  }
  if (questionProfile.wantsPaths && questionProfile.pathTerms.length === 0) {
    if (entry.classification.buckets.indexOf("path") !== -1) score += 2;
  }
  if (questionProfile.wantsTools && toolTerms.length === 0) score += 1;

  for (var phraseIndex = 0; phraseIndex < questionProfile.phrases.length; phraseIndex++) {
    if (normalizedSearch.indexOf(questionProfile.phrases[phraseIndex]) !== -1) score += 8;
  }

  var tokenHits = 0;
  for (var tokenIndex = 0; tokenIndex < questionProfile.tokens.length; tokenIndex++) {
    var token = questionProfile.tokens[tokenIndex];
    if (normalizedSearch.indexOf(token) !== -1) {
      tokenHits += 1;
      score += token.length >= 6 ? 2 : 1;
      if (normalizedUserMessage && normalizedUserMessage.indexOf(token) !== -1) score += 1;
    }
    if (tokenHits >= 8) break;
  }

  return score;
}

function selectRelevantToolCallEntries(artifacts, questionProfile, limit) {
  if (!artifacts || !questionProfile || !questionProfile.normalizedQuestion) return [];

  var maxCount = typeof limit === "number" && limit > 0 ? limit : MAX_FOCUSED_TOOL_CALLS;
  var candidates = collectQuestionCandidateEntries(artifacts, questionProfile);
  var scored = [];

  for (var i = 0; i < candidates.length; i++) {
    var score = scoreEntryForQuestion(candidates[i], questionProfile);
    if (score <= 0) continue;
    scored.push({ entry: candidates[i], score: score });
  }

  scored.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return compareLedgerEntries(a.entry, b.entry);
  });

  var entries = [];
  for (var scoredIndex = 0; scoredIndex < scored.length && entries.length < maxCount; scoredIndex++) {
    if (entries.indexOf(scored[scoredIndex].entry) === -1) entries.push(scored[scoredIndex].entry);
  }
  return entries;
}

function findTurnRecordByIndex(turnRecords, turnIndex) {
  for (var i = 0; i < turnRecords.length; i++) {
    if (turnRecords[i] && turnRecords[i].index === turnIndex) return turnRecords[i];
  }
  return null;
}

function collectFocusedTurnGroups(turnRecords, turnSummaries, entries, questionProfile) {
  var primary = [];
  var nearby = [];
  var scoredTurns = {};
  var orderByTurn = {};

  for (var summaryIndex = 0; summaryIndex < turnSummaries.length; summaryIndex++) {
    orderByTurn[turnSummaries[summaryIndex].turnIndex] = summaryIndex;
  }

  function addTurn(list, turnIndex) {
    if (turnIndex == null) return;
    if (findTurnRecordByIndex(turnRecords, turnIndex) && list.indexOf(turnIndex) === -1) list.push(turnIndex);
  }

  function addScore(turnIndex, score) {
    if (turnIndex == null || !findTurnRecordByIndex(turnRecords, turnIndex)) return;
    var key = String(turnIndex);
    scoredTurns[key] = (scoredTurns[key] || 0) + score;
  }

  for (var i = 0; i < entries.length; i++) {
    var turnIndex = entries[i].turnIndex;
    if (turnIndex == null) continue;
    addScore(turnIndex, Math.max(10 - i, 4));
  }

  for (var hintIndex = 0; hintIndex < questionProfile.turnHints.length; hintIndex++) {
    addScore(questionProfile.turnHints[hintIndex], 12);
  }

  if (entries.length === 0 || questionProfile.confidence !== "high") {
    for (var turnSummaryIndex = 0; turnSummaryIndex < turnSummaries.length; turnSummaryIndex++) {
      var summary = turnSummaries[turnSummaryIndex];
      var summaryText = normalizeSearchValue((summary.userMessage || "") + " | " + (summary.summary || ""));
      var summaryScore = 0;

      if (questionProfile.wantsErrors && summary.hasError) summaryScore += 4;
      if (countNormalizedMatches(summary.toolNames, questionProfile.matchedToolNames) > 0) {
        summaryScore += countNormalizedMatches(summary.toolNames, questionProfile.matchedToolNames) * 5;
      }

      for (var matcherIndex = 0; matcherIndex < questionProfile.matchers.length; matcherIndex++) {
        var matcherValue = questionProfile.matchers[matcherIndex].value;
        if (summaryText.indexOf(matcherValue) !== -1) summaryScore += 4;
      }

      if (summaryScore > 0) addScore(summary.turnIndex, summaryScore);
    }
  }

  var rankedTurns = Object.keys(scoredTurns).map(function (key) {
    return { turnIndex: parseInt(key, 10), score: scoredTurns[key] };
  }).sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    var aOrder = orderByTurn[a.turnIndex] != null ? orderByTurn[a.turnIndex] : Number.MAX_SAFE_INTEGER;
    var bOrder = orderByTurn[b.turnIndex] != null ? orderByTurn[b.turnIndex] : Number.MAX_SAFE_INTEGER;
    return aOrder - bOrder;
  });

  for (var rankedIndex = 0; rankedIndex < rankedTurns.length && primary.length < MAX_FOCUSED_TURNS; rankedIndex++) {
    addTurn(primary, rankedTurns[rankedIndex].turnIndex);
  }

  for (var primaryIndex = 0; primaryIndex < primary.length; primaryIndex++) {
    addTurn(nearby, primary[primaryIndex] - 1);
    addTurn(nearby, primary[primaryIndex] + 1);
  }

  primary.sort(function (a, b) { return a - b; });
  nearby = nearby.filter(function (turnIndex) { return primary.indexOf(turnIndex) === -1; });
  nearby.sort(function (a, b) { return a - b; });

  return { primary: primary, nearby: nearby };
}

function buildContextPreamble(turnRecords, metadata, qaArtifacts, options) {
  var opts = options && typeof options === "object" ? options : {};
  var stats = qaArtifacts.stats;
  var parts = [];
  var totalTurns = metadata && metadata.totalTurns != null ? metadata.totalTurns : turnRecords.length;
  var totalToolCalls = metadata && metadata.totalToolCalls != null
    ? metadata.totalToolCalls
    : qaArtifacts.ledger.length;
  var totalErrors = metadata && metadata.errorCount != null
    ? metadata.errorCount
    : stats.errorList.length;

  parts.push("=== SESSION OVERVIEW ===");
  if (metadata) {
    parts.push("Format: " + (metadata.format || "unknown"));
    parts.push("Duration: " + Math.round(metadata.duration || 0) + "s");
    if (metadata.primaryModel) parts.push("Model: " + metadata.primaryModel);
    if (metadata.tokenUsage) {
      parts.push("Tokens: " + (metadata.tokenUsage.inputTokens || 0) + " in / " +
        (metadata.tokenUsage.outputTokens || 0) + " out");
    }
  }
  parts.push("Turns: " + totalTurns);
  parts.push("Tool calls: " + totalToolCalls);
  parts.push("Errors: " + totalErrors);
  parts.push("");

  var includeToolUsage = opts.includeToolUsage !== false;
  if (includeToolUsage && stats.toolRanking.length > 0) {
    var toolLimit = typeof opts.toolLimit === "number" && opts.toolLimit > 0 ? opts.toolLimit : stats.toolRanking.length;
    parts.push("=== TOOL USAGE (sorted by frequency) ===");
    for (var rankingIndex = 0; rankingIndex < Math.min(stats.toolRanking.length, toolLimit); rankingIndex++) {
      parts.push("  " + stats.toolRanking[rankingIndex][0] + ": " + stats.toolRanking[rankingIndex][1] + " calls");
    }
    if (stats.toolRanking.length > toolLimit) {
      parts.push("  ... and " + (stats.toolRanking.length - toolLimit) + " more tools");
    }
    parts.push("");
  }

  var includeFiles = opts.includeFiles !== false;
  if (includeFiles && stats.fileEntries.length > 0) {
    var fileLimit = typeof opts.fileLimit === "number" && opts.fileLimit > 0 ? opts.fileLimit : 30;
    parts.push("=== FILES ACCESSED (sorted by frequency) ===");
    for (var fileIndex = 0; fileIndex < Math.min(stats.fileEntries.length, fileLimit); fileIndex++) {
      var fileEntry = stats.fileEntries[fileIndex];
      parts.push("  " + fileEntry[0] + " (views: " + fileEntry[1].views + ", edits: " + fileEntry[1].edits + ")");
    }
    if (stats.fileEntries.length > fileLimit) {
      parts.push("  ... and " + (stats.fileEntries.length - fileLimit) + " more files");
    }
    parts.push("");
  }

  var includeErrors = opts.includeErrors !== false;
  if (includeErrors && stats.errorList.length > 0) {
    var errorLimit = typeof opts.errorLimit === "number" && opts.errorLimit > 0 ? opts.errorLimit : 20;
    parts.push("=== ERRORS (" + stats.errorList.length + " total) ===");
    for (var errorIndex = 0; errorIndex < Math.min(stats.errorList.length, errorLimit); errorIndex++) {
      var error = stats.errorList[errorIndex];
      parts.push("  Turn " + error.turn + " [" + error.tool + "]: " + error.text);
    }
    if (stats.errorList.length > errorLimit) {
      parts.push("  ... and " + (stats.errorList.length - errorLimit) + " more errors");
    }
    parts.push("");
  }

  return parts;
}

function buildTurnBlock(turn, safeEvents, ledgerIndex, fallbackTurnIndex, options) {
  var opts = options && typeof options === "object" ? options : {};
  var inputLimit = typeof opts.inputLimit === "number" && opts.inputLimit > 0 ? opts.inputLimit : MAX_INPUT_CHARS;
  var outputLimit = typeof opts.outputLimit === "number" && opts.outputLimit > 0 ? opts.outputLimit : MAX_OUTPUT_CHARS;
  var textLimit = typeof opts.textLimit === "number" && opts.textLimit > 0 ? opts.textLimit : MAX_OUTPUT_CHARS;
  var maxTools = typeof opts.maxTools === "number" && opts.maxTools > 0 ? opts.maxTools : Number.MAX_SAFE_INTEGER;
  var compact = opts.compact === true;
  var selectedEntryIds = opts.selectedEntryIds && typeof opts.selectedEntryIds === "object" ? opts.selectedEntryIds : null;
  var turnLabel = turn && turn.index != null ? turn.index : fallbackTurnIndex;
  var turnHeader = "--- Turn " + turnLabel + " ---";
  if (turn && turn.userMessage) {
    turnHeader += "\nUser: " + truncate(turn.userMessage, 300);
  }

  var turnEvents = [];
  var toolCount = 0;
  var reasoningCount = 0;
  var outputCount = 0;
  var eventIndices = turn && Array.isArray(turn.eventIndices) ? turn.eventIndices : [];
  for (var eventOffset = 0; eventOffset < eventIndices.length; eventOffset++) {
    var event = safeEvents[eventIndices[eventOffset]];
    if (!event) continue;

    var ledgerEntryId = ledgerIndex.byEventIndex[eventIndices[eventOffset]];
    var line = "";

    if (ledgerEntryId) {
      var ledgerEntry = ledgerIndex.entriesById[ledgerEntryId];
      if (!ledgerEntry) continue;
      if (toolCount >= maxTools && !(selectedEntryIds && selectedEntryIds[ledgerEntry.id]) && !ledgerEntry.isError) continue;
      line = "[tool] " + ledgerEntry.toolName;
      if (ledgerEntry.isError) line += " (ERROR)";
      if (ledgerEntry.inputText) line += "\n  Input: " + truncate(ledgerEntry.inputText, inputLimit);
      if (ledgerEntry.outputText) line += "\n  Output: " + truncate(ledgerEntry.outputText, outputLimit);
      toolCount += 1;
    } else if (event.track === "reasoning") {
      if (compact && reasoningCount >= 1) continue;
      line = "[reasoning] " + truncate(event.text, textLimit);
      reasoningCount += 1;
    } else if (event.track === "output") {
      if (compact && outputCount >= 1) continue;
      line = "[output] " + truncate(event.text, textLimit);
      outputCount += 1;
    } else if (event.agent === "user") {
      continue;
    } else {
      line = "[" + (event.track || "other") + "] " + truncate(event.text, textLimit);
    }

    if (line) turnEvents.push(line);
  }

  return turnHeader + "\n" + turnEvents.join("\n") + "\n";
}

function buildRelevantToolCallSection(entries, charBudget, maxCount) {
  if (!Array.isArray(entries) || entries.length === 0 || charBudget <= 0) return "";

  var lines = ["=== MATCHING TOOL CALLS ==="];
  var remainingBudget = charBudget - lines[0].length - 1;
  var countLimit = typeof maxCount === "number" && maxCount > 0 ? maxCount : entries.length;

  for (var i = 0; i < entries.length && i < countLimit; i++) {
    var entry = entries[i];
    var blockLines = ["  Turn " + entry.turnIndex + " | " + entry.toolName + (entry.isError ? " (ERROR)" : "")];
    if (entry.userMessage) blockLines.push("    User: " + truncate(entry.userMessage, 180));
    if (entry.inputText) blockLines.push("    Input: " + truncate(entry.inputText, MAX_FOCUSED_MATCH_CHARS));
    if (entry.outputText) blockLines.push("    Output: " + truncate(entry.outputText, MAX_FOCUSED_MATCH_CHARS));
    var block = blockLines.join("\n");
    if (remainingBudget - block.length - 1 < 0) break;
    lines.push(block);
    remainingBudget -= block.length + 1;
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

function buildSelectedTurnSummarySection(turnSummaries, turnIndices, title, charBudget, maxCount, selectedTurnSet) {
  if (!Array.isArray(turnSummaries) || !Array.isArray(turnIndices) || turnIndices.length === 0 || charBudget <= 0) return "";

  var lines = ["=== " + title + " ==="];
  var remainingBudget = charBudget - lines[0].length - 1;
  var countLimit = typeof maxCount === "number" && maxCount > 0 ? maxCount : turnIndices.length;
  var count = 0;

  for (var i = 0; i < turnIndices.length && count < countLimit; i++) {
    for (var summaryIndex = 0; summaryIndex < turnSummaries.length; summaryIndex++) {
      var summary = turnSummaries[summaryIndex];
      if (summary.turnIndex !== turnIndices[i]) continue;
      var linePrefix = selectedTurnSet && selectedTurnSet[summary.turnIndex] ? "  * Turn " : "  Turn ";
      var line = linePrefix + summary.turnIndex + ": " + truncate(summary.summary, 240);
      if (remainingBudget - line.length - 1 < 0) return lines.length > 1 ? lines.join("\n") : "";
      lines.push(line);
      remainingBudget -= line.length + 1;
      count += 1;
      break;
    }
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

function buildSummaryChunkSection(chunks, charBudget, maxCount) {
  if (!Array.isArray(chunks) || chunks.length === 0 || charBudget <= 0) return "";
  var lines = ["=== MATCHING SUMMARY CHUNKS ==="];
  var remainingBudget = charBudget - lines[0].length - 1;
  var countLimit = typeof maxCount === "number" && maxCount > 0 ? maxCount : chunks.length;

  for (var i = 0; i < chunks.length && i < countLimit; i++) {
    var chunk = chunks[i];
    var header = "  Turns " + chunk.startTurn + "-" + chunk.endTurn;
    if (chunk.toolNames.length > 0) header += " | tools: " + summarizeToolNames(chunk.toolNames);
    var blockLines = [header, "    " + truncate(chunk.summary.replace(/\n/g, " "), 700)];
    if (chunk.focusEntities.length > 0) blockLines.push("    Focus: " + truncate(chunk.focusEntities.join(", "), 220));
    if (chunk.rawRange && chunk.rawRange.lineStart != null && chunk.rawRange.lineEnd != null) {
      blockLines.push("    Raw lines: " + chunk.rawRange.lineStart + "-" + chunk.rawRange.lineEnd);
    }
    var block = blockLines.join("\n");
    if (remainingBudget - block.length - 1 < 0) break;
    lines.push(block);
    remainingBudget -= block.length + 1;
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

function buildRawSliceSection(entries, charBudget, maxCount, rawText) {
  if (!Array.isArray(entries) || entries.length === 0 || charBudget <= 0) return "";
  var lines = ["=== MATCHING RAW JSONL SLICES ==="];
  var remainingBudget = charBudget - lines[0].length - 1;
  var countLimit = typeof maxCount === "number" && maxCount > 0 ? maxCount : entries.length;
  var added = 0;

  for (var i = 0; i < entries.length && added < countLimit; i++) {
    var entry = entries[i];
    if (!entry || !entry.rawSlice) continue;
    var header = "  Turn " + entry.turnIndex + " | " + entry.toolName;
    if (entry.rawSlice.lineStart != null && entry.rawSlice.lineEnd != null) {
      header += " | lines " + entry.rawSlice.lineStart + "-" + entry.rawSlice.lineEnd;
    }
    var blockLines = [header];
    if (entry.inputText) blockLines.push("    Input: " + truncate(entry.inputText, 260));
    var rawSliceText = entry.rawSlice.text
      ? entry.rawSlice.text
      : (rawText ? sliceRawJsonlRange(rawText, entry.rawSlice) : "");
    if (rawSliceText) {
      blockLines.push("    Raw: " + truncate(rawSliceText.replace(/\s+/g, " "), MAX_RAW_MATCH_PREVIEW_CHARS));
    } else if (entry.outputText) {
      blockLines.push("    Output: " + truncate(entry.outputText, MAX_RAW_MATCH_PREVIEW_CHARS));
    }
    var block = blockLines.join("\n");
    if (remainingBudget - block.length - 1 < 0) break;
    lines.push(block);
    remainingBudget -= block.length + 1;
    added += 1;
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

function buildRawMatchSection(matches, charBudget, maxCount) {
  if (!Array.isArray(matches) || matches.length === 0 || charBudget <= 0) return "";
  var lines = ["=== RAW JSONL MATCHES ==="];
  var remainingBudget = charBudget - lines[0].length - 1;
  var countLimit = typeof maxCount === "number" && maxCount > 0 ? maxCount : matches.length;

  for (var i = 0; i < matches.length && i < countLimit; i++) {
    var match = matches[i];
    var header = "  Lines " + match.lineStart + "-" + match.lineEnd;
    var body = truncate(String(match.text || "").replace(/\s+/g, " "), MAX_RAW_MATCH_PREVIEW_CHARS);
    var block = header + "\n    " + body;
    if (remainingBudget - block.length - 1 < 0) break;
    lines.push(block);
    remainingBudget -= block.length + 1;
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

function buildChunkQAContext(events, turns, metadata, qaArtifacts, route) {
  if (!route || !route.profile || !Array.isArray(route.relevantChunks) || route.relevantChunks.length === 0) return "";
  var turnRecords = Array.isArray(qaArtifacts.turnRecords) ? qaArtifacts.turnRecords : buildTurnRecords(events, turns);
  var parts = buildContextPreamble(turnRecords, metadata, qaArtifacts, {
    includeToolUsage: true,
    includeFiles: route.profile.wantsPaths || route.profile.broadSummary,
    includeErrors: route.profile.wantsErrors || route.profile.broadSummary,
    toolLimit: MAX_FALLBACK_TOOL_RANKING,
    fileLimit: MAX_FALLBACK_FILE_ENTRIES,
    errorLimit: MAX_FALLBACK_ERRORS,
  });
  var remainingBudget = MAX_FOCUSED_CONTEXT_CHARS - parts.join("\n").length;

  function pushBlock(block) {
    if (!block) return false;
    if (remainingBudget - block.length - 2 < 0) return false;
    parts.push(block);
    remainingBudget -= block.length + 2;
    return true;
  }

  pushBlock(buildQuestionFocusBlock(route.profile, {
    routeLabel: "summary chunks",
    note: "Using bounded precomputed summary chunks instead of the full session timeline.",
  }));
  pushBlock(buildSummaryChunkSection(route.relevantChunks, Math.min(remainingBudget, MAX_SUMMARY_CHUNK_CONTEXT_CHARS), MAX_SUMMARY_CHUNK_RESULTS));
  pushBlock(buildSelectedTurnSummarySection(
    qaArtifacts.turnSummaries,
    route.relevantChunks.reduce(function (allTurns, chunk) {
      return allTurns.concat(chunk.turnIndices || []);
    }, []),
    "MATCHING TURNS",
    Math.min(remainingBudget, 2600),
    MAX_FOCUSED_NEIGHBOR_SUMMARIES
  ));
  return parts.join("\n");
}

function buildRawSliceQAContext(events, turns, metadata, qaArtifacts, route) {
  if (!route || !route.profile || !Array.isArray(route.relevantEntries) || route.relevantEntries.length === 0) return "";
  var turnRecords = Array.isArray(qaArtifacts.turnRecords) ? qaArtifacts.turnRecords : buildTurnRecords(events, turns);
  var rawText = qaArtifacts && qaArtifacts.rawLookup && typeof qaArtifacts.rawLookup.rawText === "string"
    ? qaArtifacts.rawLookup.rawText
    : "";
  var parts = buildContextPreamble(turnRecords, metadata, qaArtifacts, {
    includeToolUsage: true,
    includeFiles: true,
    includeErrors: route.profile.wantsErrors,
    toolLimit: MAX_FALLBACK_TOOL_RANKING,
    fileLimit: MAX_FALLBACK_FILE_ENTRIES,
    errorLimit: MAX_FALLBACK_ERRORS,
  });
  var remainingBudget = MAX_FOCUSED_CONTEXT_CHARS - parts.join("\n").length;

  function pushBlock(block) {
    if (!block) return false;
    if (remainingBudget - block.length - 2 < 0) return false;
    parts.push(block);
    remainingBudget -= block.length + 2;
    return true;
  }

  pushBlock(buildQuestionFocusBlock(route.profile, {
    routeLabel: "targeted raw slices",
    note: "Using exact raw JSONL slices for the best matching tool calls.",
  }));
  pushBlock(buildRelevantToolCallSection(route.relevantEntries, Math.min(remainingBudget, 3200), MAX_RAW_SLICE_RESULTS));
  pushBlock(buildRawSliceSection(
    route.relevantEntries,
    Math.min(remainingBudget, MAX_RAW_SLICE_CONTEXT_CHARS),
    MAX_RAW_SLICE_RESULTS,
    rawText
  ));
  return parts.join("\n");
}

function buildRawScanQAContext(events, turns, metadata, qaArtifacts, route) {
  if (!route || !route.profile || !Array.isArray(route.rawMatches) || route.rawMatches.length === 0) return "";
  var turnRecords = Array.isArray(qaArtifacts.turnRecords) ? qaArtifacts.turnRecords : buildTurnRecords(events, turns);
  var parts = buildContextPreamble(turnRecords, metadata, qaArtifacts, {
    includeToolUsage: true,
    includeFiles: true,
    includeErrors: true,
    toolLimit: MAX_FALLBACK_TOOL_RANKING,
    fileLimit: MAX_FALLBACK_FILE_ENTRIES,
    errorLimit: MAX_FALLBACK_ERRORS,
  });
  var remainingBudget = MAX_FOCUSED_CONTEXT_CHARS - parts.join("\n").length;

  function pushBlock(block) {
    if (!block) return false;
    if (remainingBudget - block.length - 2 < 0) return false;
    parts.push(block);
    remainingBudget -= block.length + 2;
    return true;
  }

  pushBlock(buildQuestionFocusBlock(route.profile, {
    routeLabel: "full raw JSONL scan",
    note: "AGENTVIZ scanned the raw JSONL directly because structured matches were weak or exact evidence was requested.",
  }));
  pushBlock(buildRawMatchSection(route.rawMatches, Math.min(remainingBudget, MAX_RAW_MATCH_CONTEXT_CHARS), MAX_RAW_MATCH_RESULTS));
  if (Array.isArray(route.relevantChunks) && route.relevantChunks.length > 0) {
    pushBlock(buildSummaryChunkSection(route.relevantChunks, Math.min(remainingBudget, 2600), 2));
  }
  return parts.join("\n");
}

function buildFocusedQAContext(events, turns, metadata, qaArtifacts, questionProfile) {
  if (!questionProfile || !questionProfile.normalizedQuestion) return "";

  var safeEvents = Array.isArray(events) ? events : [];
  var turnRecords = Array.isArray(qaArtifacts.turnRecords) ? qaArtifacts.turnRecords : buildTurnRecords(events, turns);
  var relevantEntries = selectRelevantToolCallEntries(qaArtifacts, questionProfile, MAX_FOCUSED_TOOL_CALLS);
  var turnGroups = collectFocusedTurnGroups(turnRecords, qaArtifacts.turnSummaries, relevantEntries, questionProfile);
  var includeFallback = questionProfile.broadSummary || questionProfile.confidence !== "high" || relevantEntries.length === 0;
  var parts = buildContextPreamble(turnRecords, metadata, qaArtifacts, {
    includeToolUsage: includeFallback && (questionProfile.broadSummary || questionProfile.wantsTools || questionProfile.wantsCommands || questionProfile.wantsQueries || relevantEntries.length === 0),
    includeFiles: includeFallback && (questionProfile.broadSummary || questionProfile.wantsPaths || relevantEntries.length === 0),
    includeErrors: includeFallback && (questionProfile.broadSummary || questionProfile.wantsErrors || relevantEntries.length === 0),
    toolLimit: MAX_FALLBACK_TOOL_RANKING,
    fileLimit: MAX_FALLBACK_FILE_ENTRIES,
    errorLimit: MAX_FALLBACK_ERRORS,
  });
  var remainingBudget = MAX_FOCUSED_CONTEXT_CHARS - parts.join("\n").length;

  function pushBlock(block) {
    if (!block) return false;
    if (remainingBudget - block.length - 2 < 0) return false;
    parts.push(block);
    remainingBudget -= block.length + 2;
    return true;
  }

  pushBlock(buildQuestionFocusBlock(questionProfile, {
    note: includeFallback ? "Fallback: broader summary coverage included." : null,
  }));
  pushBlock(buildRelevantToolCallSection(relevantEntries, Math.min(remainingBudget, 5000), MAX_FOCUSED_TOOL_CALLS));

  if (turnGroups.primary.length > 0 && remainingBudget > 0) {
    var turnBlocks = ["=== RELEVANT TURNS ==="];
    var selectedEntryIds = {};
    for (var entryIndex = 0; entryIndex < relevantEntries.length; entryIndex++) {
      selectedEntryIds[relevantEntries[entryIndex].id] = true;
    }
    for (var turnIndex = 0; turnIndex < turnGroups.primary.length && turnIndex < MAX_FOCUSED_TURNS; turnIndex++) {
      var turnRecord = findTurnRecordByIndex(turnRecords, turnGroups.primary[turnIndex]);
      if (!turnRecord) continue;
      var turnBlock = buildTurnBlock(turnRecord, safeEvents, qaArtifacts.ledgerIndex, turnGroups.primary[turnIndex], {
        compact: true,
        selectedEntryIds: selectedEntryIds,
        maxTools: MAX_FOCUSED_TOOLS_PER_TURN,
        inputLimit: MAX_FOCUSED_INPUT_CHARS,
        outputLimit: MAX_FOCUSED_OUTPUT_CHARS,
        textLimit: MAX_FOCUSED_TEXT_CHARS,
      });
      if (turnBlocks.join("\n").length + turnBlock.length > Math.min(remainingBudget, 9000)) break;
      turnBlocks.push(turnBlock);
    }
    pushBlock(turnBlocks.join("\n"));
  }

  var selectedTurnSet = {};
  for (var primaryTurnIndex = 0; primaryTurnIndex < turnGroups.primary.length; primaryTurnIndex++) {
    selectedTurnSet[turnGroups.primary[primaryTurnIndex]] = true;
  }
  pushBlock(buildSelectedTurnSummarySection(
    qaArtifacts.turnSummaries,
    turnGroups.nearby,
    "NEARBY TURN SUMMARIES",
    Math.min(remainingBudget, 2600),
    MAX_FOCUSED_NEIGHBOR_SUMMARIES,
    selectedTurnSet
  ));

  if (includeFallback) {
    pushBlock(buildTurnSummarySection(
      qaArtifacts.turnSummaries,
      Math.min(remainingBudget, questionProfile.broadSummary ? 5000 : 2600),
      questionProfile.broadSummary ? MAX_FALLBACK_TURN_SUMMARIES + 2 : MAX_FALLBACK_TURN_SUMMARIES
    ));
  }

  return parts.join("\n");
}

function buildRemainingTurnSummaries(turnSummaries, startIndex, charBudget) {
  if (!Array.isArray(turnSummaries) || startIndex >= turnSummaries.length || charBudget <= 0) return "";

  var lines = ["=== TRUNCATED TURN SUMMARIES ==="];
  var remainingBudget = charBudget - lines[0].length - 1;
  if (remainingBudget <= 0) return "... (remaining turns truncated for context budget)";

  var summaryIndex = startIndex;
  for (; summaryIndex < turnSummaries.length; summaryIndex++) {
    var summary = turnSummaries[summaryIndex];
    var line = "Turn " + summary.turnIndex + ": " + truncate(summary.summary, 240);
    if (remainingBudget - line.length - 1 < 0) break;
    lines.push(line);
    remainingBudget -= line.length + 1;
  }

  if (summaryIndex < turnSummaries.length) {
    var tail = "... (remaining " + (turnSummaries.length - summaryIndex) + " turns truncated for context budget)";
    if (remainingBudget - tail.length - 1 >= 0) lines.push(tail);
  }

  return lines.join("\n");
}

function buildTurnSummarySection(turnSummaries, charBudget, maxCount) {
  if (!Array.isArray(turnSummaries) || turnSummaries.length === 0 || charBudget <= 0) return "";

  var countLimit = typeof maxCount === "number" && maxCount > 0 ? maxCount : turnSummaries.length;
  var lines = ["=== TURN SUMMARIES ==="];
  var remainingBudget = charBudget - lines[0].length - 1;
  if (remainingBudget <= 0) return "";

  var summaryIndex = 0;
  for (; summaryIndex < turnSummaries.length && summaryIndex < countLimit; summaryIndex++) {
    var summary = turnSummaries[summaryIndex];
    var line = "  Turn " + summary.turnIndex + ": " + truncate(summary.summary, 240);
    if (remainingBudget - line.length - 1 < 0) break;
    lines.push(line);
    remainingBudget -= line.length + 1;
  }

  if (summaryIndex < turnSummaries.length) {
    var remainingTurns = turnSummaries.length - summaryIndex;
    var tail = "  ... and " + remainingTurns + " more turn" + (remainingTurns === 1 ? "" : "s");
    if (remainingBudget - tail.length - 1 >= 0) lines.push(tail);
  }

  return lines.length > 1 ? lines.join("\n") : "";
}

function buildFullQAContext(events, turns, metadata, qaArtifacts) {
  var safeEvents = Array.isArray(events) ? events : [];
  var turnRecords = Array.isArray(qaArtifacts.turnRecords)
    ? qaArtifacts.turnRecords
    : buildTurnRecords(events, turns);
  var parts = buildContextPreamble(turnRecords, metadata, qaArtifacts);
  var turnSummaries = qaArtifacts.turnSummaries;

  var turnSummarySection = buildTurnSummarySection(turnSummaries, 4000, 12);
  if (turnSummarySection) {
    parts.push(turnSummarySection);
    parts.push("");
  }

  parts.push("=== TURNS ===");
  var charBudget = MAX_CONTEXT_CHARS - parts.join("\n").length;

  for (var turnIndex = 0; turnIndex < turnRecords.length; turnIndex++) {
    var turnBlock = buildTurnBlock(turnRecords[turnIndex], safeEvents, qaArtifacts.ledgerIndex, turnIndex);

    if (charBudget - turnBlock.length < 0) {
      var summaryBlock = buildRemainingTurnSummaries(turnSummaries, turnIndex, charBudget);
      if (summaryBlock) parts.push(summaryBlock);
      else parts.push("... (remaining " + (turnRecords.length - turnIndex) + " turns truncated for context budget)");
      break;
    }

    charBudget -= turnBlock.length;
    parts.push(turnBlock);
  }

  return parts.join("\n");
}

/**
 * Build a compact text context from parsed session data.
 */
export function buildQAContext(events, turns, metadata, options) {
  var safeEvents = Array.isArray(events) ? events : [];
  var safeTurns = Array.isArray(turns) ? turns : [];
  var opts = options && typeof options === "object" ? options : {};
  var qaArtifacts = opts.artifacts
    ? opts.artifacts
    : buildSessionQAArtifacts(safeEvents, safeTurns, metadata);
  var questionProfile = opts.route && opts.route.profile
    ? opts.route.profile
    : buildQAQuestionProfile(opts.question, { artifacts: qaArtifacts });
  var route = opts.route && typeof opts.route === "object" ? opts.route : null;

  if (route && route.kind === "chunk") {
    var chunkContext = buildChunkQAContext(safeEvents, safeTurns, metadata, qaArtifacts, route);
    if (chunkContext) return chunkContext;
  }

  if (route && route.kind === "raw-targeted") {
    var rawSliceContext = buildRawSliceQAContext(safeEvents, safeTurns, metadata, qaArtifacts, route);
    if (rawSliceContext) return rawSliceContext;
  }

  if (route && route.kind === "raw-full") {
    var rawScanContext = buildRawScanQAContext(safeEvents, safeTurns, metadata, qaArtifacts, route);
    if (rawScanContext) return rawScanContext;
  }

  var focusedContext = buildFocusedQAContext(safeEvents, safeTurns, metadata, qaArtifacts, questionProfile);
  if (focusedContext) return focusedContext;

  return buildFullQAContext(safeEvents, safeTurns, metadata, qaArtifacts);
}

/**
 * Build the system prompt for a Q&A question.
 */
function buildFullSessionFileAccessMessage(sessionFilePath, questionProfile) {
  var prefersStructuredSummary = !questionProfile || !questionProfile.requiresExactEvidence;
  return "FULL SESSION FILE ACCESS:\n" +
    "The complete session JSONL file is at: " + sessionFilePath + "\n" +
    "The summary below is retrieval-first, may be truncated, and may not contain all turns.\n" +
    (prefersStructuredSummary
      ? "Use the structured session data below first. " +
        "Inspect the raw JSONL file only if the summary still cannot answer the question.\n"
      : "Use the retrieved snippets in the structured session data below first. " +
        "Search the raw JSONL file only if exact tool input/output is still missing or truncated.\n") +
    "Use only file-search or file-read tools for that exact file.\n" +
    "JSONL structure hints:\n" +
    "  - type: 'tool.execution_start' (has data.toolName, data.toolInput)\n" +
    "  - type: 'tool.execution_complete' (has data.result or data.output, data.isError)\n" +
    "  - type: 'assistant.message' (has data.content)\n" +
    "  - type: 'user.message' (has data.content)\n" +
    "Do not say the session is inaccessible or truncated if the answer can be found in this file.";
}

export function buildQAPrompt(question, context, options) {
  var sessionFilePath = options && options.sessionFilePath;
  var questionProfile = buildQAQuestionProfile(question);
  var system = "You are an AI assistant that answers questions about a coding session. " +
    "The user will provide session data and a question in each message. " +
    "Answer ONLY based on the session data provided";

  if (sessionFilePath) {
    system += " and the explicitly provided session JSONL file. " +
      "If a session JSONL file path is provided, you may use only file-search and file-read tools " +
      "to inspect that exact file. Do NOT use web, sql, session_store, or unrelated workspace exploration. ";
  } else {
    system += ". DO NOT use any tools (no bash, no sql, no session_store, no file reads). ";
  }

  system += "Do NOT attempt to access external data sources. " +
    "If the answer is not in the provided session data, say so.\n\n" +
    "When referencing specific moments, cite turn numbers like [Turn 3]. " +
    "Keep answers concise and factual. Use markdown formatting.\n\n" +
    "If the relevant answer is already present in SESSION DATA, answer directly and do NOT " +
    "inspect the raw file or request NEED_DETAIL. Do not request extra detail just to confirm " +
    "an answer that the retrieved evidence already supports.\n\n" +
    "IMPORTANT: If the tool output shown is truncated (ends with '...') and you need " +
    "the full output to answer the question, respond ONLY with one or more lines like:\n" +
    "[NEED_DETAIL: Turn 5, powershell]\n" +
    "[NEED_DETAIL: Turn 12, kusto]\n" +
    "The system will automatically fetch the full data and ask you again. " +
    "Only request details you actually need to answer the question.";

  var user = "";
  if (sessionFilePath) {
    user += buildFullSessionFileAccessMessage(sessionFilePath, questionProfile) + "\n\n";
  }

  return {
    system: system,
    user: user + "SESSION DATA:\n" + context + "\n\nQUESTION: " + question,
  };
}

/**
 * Parse [NEED_DETAIL: Turn X, tool_name] markers from a model response.
 * Returns an array of { turnIndex, toolName } or empty array if none found.
 */
export function parseDetailRequests(text) {
  var results = [];
  var regex = /\[NEED_DETAIL:\s*Turn\s+(\d+)\s*,\s*([^\]]+)\]/g;
  var match;
  while ((match = regex.exec(text)) !== null) {
    results.push({ turnIndex: parseInt(match[1], 10), toolName: match[2].trim() });
  }
  return results;
}

function getDetailArtifacts(events, options) {
  var opts = options && typeof options === "object" ? options : {};

  if (opts.artifacts && typeof opts.artifacts === "object") {
    var artifactLedger = Array.isArray(opts.artifacts.ledger) ? opts.artifacts.ledger : [];
    return {
      ledger: artifactLedger,
      ledgerIndex: opts.artifacts.ledgerIndex || buildToolCallSearchIndex(artifactLedger),
      rawLookup: opts.artifacts.rawLookup || null,
    };
  }

  var ledger = Array.isArray(opts.ledger)
    ? opts.ledger
    : buildToolCallLedger(events, opts.turns, {
      rawLookup: opts.rawLookup,
      rawText: opts.rawText,
      rawIndex: opts.rawIndex,
    });
  var ledgerIndex = opts.ledgerIndex || buildToolCallSearchIndex(ledger);
  var rawLookup = opts.rawLookup || null;

  if (!rawLookup && (opts.rawIndex || typeof opts.rawText === "string")) {
    rawLookup = buildToolCallRawLookup(events, opts.turns, opts.rawText, {
      ledger: ledger,
      ledgerIndex: ledgerIndex,
      rawIndex: opts.rawIndex,
    });
    attachRawSlicesToLedger(ledger, rawLookup);
  }

  return {
    ledger: ledger,
    ledgerIndex: ledgerIndex,
    rawLookup: rawLookup,
  };
}

function findDetailEntries(request, artifacts) {
  if (!request || !artifacts || !artifacts.ledgerIndex) return [];

  var turnMatches = artifacts.ledgerIndex.byTurn[normalizeSearchValue(request.turnIndex)];
  if (!Array.isArray(turnMatches) || turnMatches.length === 0) return [];

  var normalizedToolName = normalizeSearchValue(request.toolName);
  var results = [];
  for (var i = 0; i < turnMatches.length; i++) {
    var entry = artifacts.ledgerIndex.entriesById[turnMatches[i]];
    if (!entry) continue;
    if (normalizedToolName && entry.toolNameNormalized !== normalizedToolName) continue;
    results.push(entry);
  }
  return results;
}

function formatRawSliceLabel(rawSlice) {
  if (!rawSlice) return "";
  if (rawSlice.lineStart === rawSlice.lineEnd) {
    return "Raw JSONL line " + rawSlice.lineStart;
  }
  return "Raw JSONL lines " + rawSlice.lineStart + "-" + rawSlice.lineEnd;
}

/**
 * Build a detail response for requested tool calls.
 * Finds the matching events and returns their full I/O.
 */
export function buildDetailResponse(requests, events, options) {
  var safeRequests = Array.isArray(requests) ? requests : [];
  var safeEvents = Array.isArray(events) ? events : [];
  var detailArtifacts = getDetailArtifacts(safeEvents, options);
  var parts = ["Here are the full details you requested:\n"];

  for (var i = 0; i < safeRequests.length; i++) {
    var req = safeRequests[i];
    var matches = findDetailEntries(req, detailArtifacts);

    if (matches.length === 0) {
      parts.push("--- Turn " + req.turnIndex + ", " + req.toolName + " ---");
      parts.push("(not found in session data)\n");
      continue;
    }

    for (var matchIndex = 0; matchIndex < matches.length; matchIndex++) {
      var entry = matches[matchIndex];
      parts.push("--- Turn " + req.turnIndex + ", " + entry.toolName + " ---");

      var inputStr = entry.inputText || formatToolInput(entry.toolInput);
      if (inputStr) parts.push("Input:\n" + truncate(inputStr, MAX_DETAIL_CHARS));
      if (entry.outputText) parts.push("Output:\n" + truncate(entry.outputText, MAX_DETAIL_CHARS));
      if (entry.toolInput) {
        try {
          var rawInput = JSON.stringify(entry.toolInput, null, 2);
          if (rawInput.length > inputStr.length + 10) {
            parts.push("Full input (JSON):\n" + truncate(rawInput, MAX_DETAIL_CHARS));
          }
        } catch (e) {}
      }

      var rawSlice = getRawSliceForEntry(detailArtifacts.rawLookup, entry);
      var rawSliceText = rawSlice && rawSlice.text
        ? rawSlice.text
        : (rawSlice && detailArtifacts.rawLookup && detailArtifacts.rawLookup.rawText
          ? sliceRawJsonlRange(detailArtifacts.rawLookup.rawText, rawSlice)
          : "");
      if (rawSlice && rawSliceText) {
        parts.push(formatRawSliceLabel(rawSlice) + ":\n" + truncate(rawSliceText, MAX_DETAIL_CHARS));
      }

      parts.push("");
    }
  }

  return parts.join("\n");
}

function truncate(text, max) {
  if (!text) return "";
  var str = String(text);
  if (str.length <= max) return str;
  return str.substring(0, max) + "...";
}
