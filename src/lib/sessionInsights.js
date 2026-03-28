import { buildAutonomyMetrics, getSessionCost } from "./autonomyMetrics.js";
import { isFileCreateEvent, isFileEditEvent } from "./diffUtils.js";
import { formatDurationLong } from "./formatTime.js";

var VIEW_TOOL_NAMES = [
  "view",
  "read_file",
  "get_file_contents",
  "show_file",
  "open_file",
  "cat",
];

var SEARCH_TOOL_NAMES = [
  "grep",
  "rg",
  "glob",
  "search_code",
  "file_search",
  "find",
];

var PATH_KEYS = [
  "path",
  "paths",
  "file",
  "files",
  "file_path",
  "filepath",
  "filePath",
  "relativePath",
  "relative_path",
  "targetPath",
  "from",
  "to",
  "oldPath",
  "newPath",
  "directory",
  "dir",
];

function truncateText(value, max) {
  if (value == null) return "";
  var text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return text.substring(0, max - 3) + "...";
}

function inlineCode(value) {
  return "`" + truncateText(String(value || "").replace(/`/g, "'"), 140) + "`";
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPathKey(key) {
  return PATH_KEYS.indexOf(key) !== -1;
}

function looksLikePath(value) {
  if (!value || value.length > 260) return false;
  if (/^[a-z]+:\/\//i.test(value)) return false;
  if (/^\w+@\w+/.test(value)) return false;
  if (/^[A-Za-z]:\\/.test(value)) return true;
  if (value.startsWith("./") || value.startsWith(".\\")) return true;
  if (/[\\/]/.test(value)) return true;
  if (/\.[A-Za-z0-9]{1,10}$/.test(value)) return true;
  return false;
}

function getPathTail(pathValue) {
  var parts = String(pathValue || "").split(/[\\/]/);
  return parts.length > 0 ? parts[parts.length - 1] : String(pathValue || "");
}

function resolvePathKey(byPath, pathValue) {
  if (!pathValue) return pathValue;
  if (byPath[pathValue]) return pathValue;

  var tail = getPathTail(pathValue);
  if (!tail) return pathValue;

  var matches = Object.keys(byPath).filter(function (candidate) {
    return getPathTail(candidate) === tail;
  });

  return matches.length === 1 ? matches[0] : pathValue;
}

function collectPathCandidates(value, bucket, keyName, depth) {
  if (!value || depth > 4) return;

  if (typeof value === "string") {
    var trimmed = value.trim();
    if (isPathKey(keyName) && looksLikePath(trimmed)) {
      bucket[trimmed] = true;
    }
    return;
  }

  if (Array.isArray(value)) {
    for (var index = 0; index < value.length; index += 1) {
      collectPathCandidates(value[index], bucket, keyName, depth + 1);
    }
    return;
  }

  if (!isObject(value)) return;

  var keys = Object.keys(value);
  for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    var key = keys[keyIndex];
    collectPathCandidates(value[key], bucket, key, depth + 1);
  }
}

function getInputObject(value) {
  return isObject(value) ? value : null;
}

function getToolName(event) {
  return event && event.toolName ? String(event.toolName) : "tool";
}

function normalizeResultText(event) {
  if (!event) return "";
  if (typeof event.toolResultText === "string" && event.toolResultText.trim()) {
    return truncateText(event.toolResultText, 220);
  }

  var lines = String(event.text || "").split("\n");
  if (lines.length > 1) {
    return truncateText(lines.slice(1).join(" "), 220);
  }

  return "";
}

function stripResultPrefix(text) {
  return String(text || "").replace(/^Result:\s*/i, "").trim();
}

function isViewTool(toolName) {
  var name = String(toolName || "").toLowerCase();
  return VIEW_TOOL_NAMES.indexOf(name) !== -1;
}

function isSearchTool(toolName) {
  var name = String(toolName || "").toLowerCase();
  return SEARCH_TOOL_NAMES.indexOf(name) !== -1;
}

function buildCommandDescriptor(event) {
  var input = getInputObject(event && event.toolInput);
  if (!input) return null;

  if (typeof input.command === "string" && input.command.trim()) {
    return {
      kind: "Shell command",
      input: input.command.trim(),
    };
  }

  if (typeof input.pattern === "string" && input.pattern.trim()) {
    return {
      kind: "Search pattern",
      input: input.path ? input.pattern.trim() + " in " + input.path : input.pattern.trim(),
    };
  }

  if (typeof input.query === "string" && input.query.trim()) {
    return {
      kind: "Query",
      input: input.query.trim(),
    };
  }

  if (typeof input.sql === "string" && input.sql.trim()) {
    return {
      kind: "Query",
      input: input.sql.trim(),
    };
  }

  if (typeof input.prompt === "string" && input.prompt.trim()) {
    return {
      kind: "Prompt",
      input: input.prompt.trim(),
    };
  }

  return null;
}

function uniqueToolNames(events, eventIndices) {
  var names = [];
  var seen = {};

  for (var index = 0; index < eventIndices.length; index += 1) {
    var event = events[eventIndices[index]];
    if (!event || event.track !== "tool_call" || !event.toolName) continue;
    var name = String(event.toolName);
    if (seen[name]) continue;
    seen[name] = true;
    names.push(name);
  }

  return names;
}

function buildHighlights(events, eventIndices, track, maxItems) {
  var items = [];

  for (var index = 0; index < eventIndices.length; index += 1) {
    var event = events[eventIndices[index]];
    if (!event || event.track !== track || event.agent !== "assistant") continue;
    var text = truncateText(event.text, 180);
    if (!text) continue;
    items.push(text);
    if (items.length >= maxItems) break;
  }

  return items;
}

function buildErrorHighlights(events, eventIndices, maxItems) {
  var items = [];

  for (var index = 0; index < eventIndices.length; index += 1) {
    var event = events[eventIndices[index]];
    if (!event) continue;

    if (event.track === "tool_call" && (event.isError || event.toolResultIsError)) {
      items.push("[" + getToolName(event) + "] " + truncateText(normalizeResultText(event) || event.text, 180));
    } else if (event.isError) {
      items.push(truncateText(stripResultPrefix(event.text), 180));
    }

    if (items.length >= maxItems) break;
  }

  return items;
}

function buildTopTools(events) {
  var counts = {};

  for (var index = 0; index < (events || []).length; index += 1) {
    var event = events[index];
    if (!event || event.track !== "tool_call" || !event.toolName) continue;
    counts[event.toolName] = (counts[event.toolName] || 0) + 1;
  }

  return Object.entries(counts)
    .sort(function (left, right) {
      return right[1] - left[1] || String(left[0]).localeCompare(String(right[0]));
    })
    .map(function (entry) {
      return { name: entry[0], count: entry[1] };
    });
}

export function buildCommandsAndQueries(events) {
  var items = [];

  for (var index = 0; index < (events || []).length; index += 1) {
    var event = events[index];
    if (!event || event.track !== "tool_call") continue;

    var descriptor = buildCommandDescriptor(event);
    if (!descriptor) continue;

    items.push({
      turn: typeof event.turnIndex === "number" ? event.turnIndex + 1 : null,
      toolName: getToolName(event),
      kind: descriptor.kind,
      input: descriptor.input,
      resultSummary: normalizeResultText(event),
      isError: Boolean(event.isError || event.toolResultIsError),
    });
  }

  return items;
}

export function buildFileAccessSummary(events, metadata) {
  var byPath = {};

  function recordPath(pathValue, kind, turn, toolName) {
    if (!pathValue) return;
    var normalizedPath = resolvePathKey(byPath, pathValue);
    if (!byPath[normalizedPath]) {
      byPath[normalizedPath] = {
        path: normalizedPath,
        accesses: 0,
        views: 0,
        searches: 0,
        edits: 0,
        creates: 0,
        summaryTouches: 0,
        lastTool: null,
        turns: {},
      };
    }

    var entry = byPath[normalizedPath];
    entry.accesses += 1;
    entry[kind] += 1;
    entry.lastTool = toolName || entry.lastTool;
    if (turn != null) entry.turns[turn] = true;
  }

  for (var index = 0; index < (events || []).length; index += 1) {
    var event = events[index];
    if (!event || event.track !== "tool_call") continue;

    var input = getInputObject(event.toolInput);
    if (!input) continue;

    var pathBucket = {};
    collectPathCandidates(input, pathBucket, null, 0);
    var paths = Object.keys(pathBucket);
    if (paths.length === 0) continue;

    var kind = "views";
    if (isFileCreateEvent(event)) kind = "creates";
    else if (isFileEditEvent(event)) kind = "edits";
    else if (isSearchTool(event.toolName)) kind = "searches";
    else if (!isViewTool(event.toolName)) kind = "views";

    for (var pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
      recordPath(paths[pathIndex], kind, typeof event.turnIndex === "number" ? event.turnIndex + 1 : null, getToolName(event));
    }
  }

  var modifiedFiles = metadata && metadata.codeChanges && Array.isArray(metadata.codeChanges.filesModified)
    ? metadata.codeChanges.filesModified
    : [];

  for (var modifiedIndex = 0; modifiedIndex < modifiedFiles.length; modifiedIndex += 1) {
    var modifiedPath = resolvePathKey(byPath, modifiedFiles[modifiedIndex]);
    if (!byPath[modifiedPath]) {
      byPath[modifiedPath] = {
        path: modifiedPath,
        accesses: 0,
        views: 0,
        searches: 0,
        edits: 0,
        creates: 0,
        summaryTouches: 0,
        lastTool: null,
        turns: {},
      };
    }
    byPath[modifiedPath].accesses += 1;
    byPath[modifiedPath].summaryTouches += 1;
  }

  return Object.values(byPath)
    .map(function (entry) {
      return Object.assign({}, entry, {
        turns: Object.keys(entry.turns).map(function (turn) { return Number(turn); }).sort(function (left, right) { return left - right; }),
      });
    })
    .sort(function (left, right) {
      return right.accesses - left.accesses
        || right.edits - left.edits
        || right.views - left.views
        || left.path.localeCompare(right.path);
    });
}

export function buildErrorSummary(events) {
  var items = [];
  var seen = {};

  function pushItem(turn, toolName, message) {
    var key = [turn || "", toolName || "", message || ""].join("|");
    if (seen[key]) return;
    seen[key] = true;
    items.push({
      turn,
      toolName: toolName || null,
      message,
    });
  }

  for (var index = 0; index < (events || []).length; index += 1) {
    var event = events[index];
    if (!event) continue;

    if (event.track === "tool_call" && (event.isError || event.toolResultIsError)) {
      pushItem(
        typeof event.turnIndex === "number" ? event.turnIndex + 1 : null,
        getToolName(event),
        truncateText(normalizeResultText(event) || event.text, 220),
      );
      continue;
    }

    if (!event.isError) continue;

    var raw = isObject(event.raw) ? event.raw : null;
    if ((raw && raw.type === "tool_result") || event.toolCallId) continue;

    pushItem(
      typeof event.turnIndex === "number" ? event.turnIndex + 1 : null,
      event.toolName ? getToolName(event) : null,
      truncateText(stripResultPrefix(event.text), 220),
    );
  }

  return items;
}

export function buildTurnDigests(events, turns) {
  return (turns || []).map(function (turn) {
    var eventIndices = Array.isArray(turn.eventIndices) ? turn.eventIndices : [];
    return {
      turn: turn.index + 1,
      userMessage: truncateText(turn.userMessage || "", 220),
      tools: uniqueToolNames(events || [], eventIndices),
      reasoningHighlights: buildHighlights(events || [], eventIndices, "reasoning", 3),
      outputHighlights: buildHighlights(events || [], eventIndices, "output", 3),
      errorHighlights: buildErrorHighlights(events || [], eventIndices, 3),
    };
  });
}

export function buildCliStats(result) {
  var safeResult = result || { events: [], turns: [], metadata: {} };
  var metadata = safeResult.metadata || {};
  var autonomy = buildAutonomyMetrics(safeResult.events || [], safeResult.turns || [], metadata);
  var files = buildFileAccessSummary(safeResult.events || [], metadata);
  var tokenUsage = metadata.tokenUsage || {};

  return {
    format: metadata.format || null,
    primaryModel: metadata.primaryModel || null,
    autonomyEfficiency: autonomy.autonomyEfficiency,
    errorCount: metadata.errorCount || 0,
    totalTurns: metadata.totalTurns || (safeResult.turns || []).length,
    totalToolCalls: metadata.totalToolCalls || 0,
    tokenUsage: {
      input: tokenUsage.inputTokens || 0,
      output: tokenUsage.outputTokens || 0,
      cacheRead: tokenUsage.cacheRead || 0,
      cacheWrite: tokenUsage.cacheWrite || 0,
    },
    totalCost: getSessionCost(metadata),
    premiumRequests: metadata.premiumRequests || null,
    topTools: buildTopTools(safeResult.events || []).slice(0, 10).map(function (item) {
      return [item.name, item.count];
    }),
    interventionCount: autonomy.interventionCount,
    productiveRuntime: autonomy.productiveRuntime,
    humanResponseTime: autonomy.babysittingTime,
    idleTime: autonomy.idleTime,
    duration: metadata.duration || 0,
    filesTouched: files.length,
  };
}

export function buildDigestEvidence(result, fileName) {
  var stats = buildCliStats(result);
  var metadata = result && result.metadata ? result.metadata : {};

  return {
    fileName: fileName || "session.jsonl",
    format: stats.format,
    primaryModel: stats.primaryModel,
    repository: metadata.repository || null,
    branch: metadata.branch || null,
    duration: stats.duration,
    totalTurns: stats.totalTurns,
    totalToolCalls: stats.totalToolCalls,
    errorCount: stats.errorCount,
    autonomyEfficiency: stats.autonomyEfficiency,
    interventionCount: stats.interventionCount,
    productiveRuntime: stats.productiveRuntime,
    humanResponseTime: stats.humanResponseTime,
    idleTime: stats.idleTime,
    totalCost: stats.totalCost,
    premiumRequests: stats.premiumRequests,
    tokenUsage: stats.tokenUsage,
    topTools: buildTopTools(result && result.events ? result.events : []).slice(0, 10),
    warnings: metadata.warnings || [],
    codeChanges: metadata.codeChanges || null,
    commands: buildCommandsAndQueries(result && result.events ? result.events : []),
    files: buildFileAccessSummary(result && result.events ? result.events : [], metadata),
    errors: buildErrorSummary(result && result.events ? result.events : []),
    turns: buildTurnDigests(result && result.events ? result.events : [], result && result.turns ? result.turns : []),
  };
}

function renderCommandsSection(items) {
  if (!items || items.length === 0) return ["No queries or commands were captured."];

  var lines = [];
  for (var index = 0; index < items.length; index += 1) {
    var item = items[index];
    var turnText = item.turn != null ? "Turn " + item.turn : "Turn ?";
    lines.push((index + 1) + ". [" + turnText + "] " + item.kind + " via " + inlineCode(item.toolName) + ": " + inlineCode(item.input));
    if (item.resultSummary) {
      lines.push("   - Result: " + item.resultSummary);
    }
    if (item.isError) {
      lines.push("   - Status: error");
    }
    lines.push("");
  }

  return lines;
}

function renderFilesSection(items) {
  if (!items || items.length === 0) return ["No file access data was captured."];

  var lines = [];
  for (var index = 0; index < items.length; index += 1) {
    var item = items[index];
    var parts = [
      item.accesses + " access" + (item.accesses !== 1 ? "es" : ""),
      "views " + item.views,
      "searches " + item.searches,
      "edits " + item.edits,
      "creates " + item.creates,
    ];
    if (item.summaryTouches > 0) {
      parts.push("summary touches " + item.summaryTouches);
    }
    lines.push("- " + inlineCode(item.path) + " - " + parts.join(", "));
  }

  return lines;
}

function renderErrorsSection(items) {
  if (!items || items.length === 0) return ["No errors were captured."];

  var lines = [];
  for (var index = 0; index < items.length; index += 1) {
    var item = items[index];
    var prefix = item.turn != null ? "Turn " + item.turn : "Turn ?";
    if (item.toolName) {
      prefix += " via " + inlineCode(item.toolName);
    }
    lines.push((index + 1) + ". " + prefix + " - " + item.message);
  }

  return lines;
}

function renderHypotheses(items) {
  if (!items || items.length === 0) return ["No synthesized hypotheses were provided."];

  var lines = [];
  for (var index = 0; index < items.length; index += 1) {
    var item = items[index];
    lines.push((index + 1) + ". **Hypothesis:** " + item.hypothesis);
    lines.push("   - Outcome: " + item.outcome);
    lines.push("   - Evidence: " + item.evidence);
    lines.push("");
  }
  return lines;
}

function renderDecisions(items) {
  if (!items || items.length === 0) return ["No synthesized decisions were provided."];

  var lines = [];
  for (var index = 0; index < items.length; index += 1) {
    var item = items[index];
    lines.push((index + 1) + ". **Decision:** " + item.decision);
    lines.push("   - Rationale: " + item.rationale);
    lines.push("   - Evidence: " + item.evidence);
    lines.push("");
  }
  return lines;
}

function renderQuestions(items) {
  if (!items || items.length === 0) return ["No synthesized review questions were provided."];

  var lines = [];
  for (var index = 0; index < items.length; index += 1) {
    var item = items[index];
    lines.push((index + 1) + ". **Question:** " + item.question);
    lines.push("   - Answer: " + item.answer);
    lines.push("   - Evidence: " + item.evidence);
    lines.push("");
  }
  return lines;
}

export function renderSessionDigestMarkdown(evidence, aiSections, options) {
  var digest = aiSections || {};
  var sourceFile = options && options.sourceFile ? options.sourceFile : evidence.fileName;
  var model = options && options.model ? options.model : null;
  var lines = [
    "# Session Digest",
    "",
    "Generated by AGENTVIZ CLI.",
    "",
    "## Session Overview",
    "- Source: " + inlineCode(sourceFile),
    "- Format: " + inlineCode(evidence.format || "unknown"),
    "- Primary model: " + inlineCode(evidence.primaryModel || "unknown"),
    "- Duration: " + formatDurationLong(evidence.duration || 0),
    "- Turns: " + String(evidence.totalTurns || 0),
    "- Tool calls: " + String(evidence.totalToolCalls || 0),
    "- Errors: " + String(evidence.errorCount || 0),
    "- Autonomy efficiency: " + Math.round((evidence.autonomyEfficiency || 0) * 100) + "%",
  ];

  if (evidence.repository) lines.push("- Repository: " + inlineCode(evidence.repository));
  if (evidence.branch) lines.push("- Branch: " + inlineCode(evidence.branch));
  if (model) lines.push("- Digest synthesis: " + inlineCode(model));
  if (typeof evidence.totalCost === "number") lines.push("- Estimated cost: $" + evidence.totalCost.toFixed(2));
  if (evidence.premiumRequests != null) lines.push("- Premium requests: " + String(evidence.premiumRequests));
  if (evidence.warnings && evidence.warnings.length > 0) lines.push("- Parser warnings: " + evidence.warnings.join("; "));

  lines.push("");

  if (digest.summary) {
    lines.push("## Executive Summary", "", truncateText(digest.summary, 1200), "");
  }

  lines.push("## Queries & Commands", "");
  lines.push.apply(lines, renderCommandsSection(evidence.commands));
  lines.push("");

  lines.push("## Files Examined", "");
  lines.push.apply(lines, renderFilesSection(evidence.files));
  lines.push("");

  lines.push("## Errors Encountered", "");
  lines.push.apply(lines, renderErrorsSection(evidence.errors));
  lines.push("");

  lines.push("## Hypotheses & Outcomes", "");
  lines.push.apply(lines, renderHypotheses(digest.hypotheses));
  lines.push("");

  lines.push("## Key Decisions", "");
  lines.push.apply(lines, renderDecisions(digest.decisions));
  lines.push("");

  lines.push("## Top Questions & Answers", "");
  lines.push.apply(lines, renderQuestions(digest.questions));

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
