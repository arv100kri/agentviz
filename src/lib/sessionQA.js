/**
 * Session Q&A - build context and prompts for asking questions about a session.
 *
 * Hybrid retrieval strategy:
 *   Pass 1: Send aggregate stats + per-turn tool index with truncated I/O (~500 chars).
 *   Pass 2: If the model needs full output for specific tool calls, it responds with
 *           [NEED_DETAIL: Turn X, tool_name] markers. The client detects these, resolves
 *           the full event data, and sends a follow-up automatically.
 */

var MAX_CONTEXT_CHARS = 64000;
var MAX_INPUT_CHARS = 500;
var MAX_OUTPUT_CHARS = 500;
var MAX_DETAIL_CHARS = 4000;

/**
 * Serialize a toolInput object into a readable one-liner.
 */
function formatToolInput(toolInput) {
  if (!toolInput) return "";
  if (typeof toolInput === "string") return toolInput;
  // Common shapes: { command }, { pattern, path }, { path }, { query }
  var cmd = toolInput.command || toolInput.query || toolInput.pattern || toolInput.content || toolInput.script;
  var path = toolInput.path || toolInput.file || toolInput.file_path || toolInput.filename;
  var parts = [];
  if (cmd) parts.push(cmd);
  if (path && !cmd) parts.push(path);
  else if (path) parts.push("(" + path + ")");
  if (parts.length > 0) return parts.join(" ");
  // Fallback: compact JSON
  try { return JSON.stringify(toolInput); } catch (e) { return ""; }
}

/**
 * Build a compact text context from parsed session data.
 */
export function buildQAContext(events, turns, metadata) {
  var parts = [];
  var safeEvents = events || [];

  // Session overview
  parts.push("=== SESSION OVERVIEW ===");
  if (metadata) {
    parts.push("Format: " + (metadata.format || "unknown"));
    parts.push("Duration: " + Math.round(metadata.duration || 0) + "s");
    parts.push("Turns: " + (metadata.totalTurns || 0));
    parts.push("Tool calls: " + (metadata.totalToolCalls || 0));
    parts.push("Errors: " + (metadata.errorCount || 0));
    if (metadata.primaryModel) parts.push("Model: " + metadata.primaryModel);
    if (metadata.tokenUsage) {
      parts.push("Tokens: " + (metadata.tokenUsage.inputTokens || 0) + " in / " +
        (metadata.tokenUsage.outputTokens || 0) + " out");
    }
  }
  parts.push("");

  // Tool frequency table
  var toolCounts = {};
  var fileCounts = {};
  var errorList = [];
  for (var ei = 0; ei < safeEvents.length; ei++) {
    var ev = safeEvents[ei];
    if (ev.track === "tool_call" && ev.toolName) {
      toolCounts[ev.toolName] = (toolCounts[ev.toolName] || 0) + 1;
      if (ev.toolInput) {
        var filePath = ev.toolInput.path || ev.toolInput.file || ev.toolInput.file_path || ev.toolInput.filename;
        if (filePath) {
          if (!fileCounts[filePath]) fileCounts[filePath] = { views: 0, edits: 0 };
          var editTools = ["edit", "Edit", "Write", "write", "create", "Create", "insert"];
          if (editTools.indexOf(ev.toolName) !== -1) {
            fileCounts[filePath].edits++;
          } else {
            fileCounts[filePath].views++;
          }
        }
      }
    }
    if (ev.isError) {
      errorList.push({
        turn: ev.turnIndex != null ? ev.turnIndex : "?",
        tool: ev.toolName || "unknown",
        text: truncate(ev.text, 200),
      });
    }
  }

  // Tool ranking
  var toolRanking = Object.entries(toolCounts)
    .sort(function (a, b) { return b[1] - a[1]; });
  if (toolRanking.length > 0) {
    parts.push("=== TOOL USAGE (sorted by frequency) ===");
    for (var ti = 0; ti < toolRanking.length; ti++) {
      parts.push("  " + toolRanking[ti][0] + ": " + toolRanking[ti][1] + " calls");
    }
    parts.push("");
  }

  // Files accessed
  var fileEntries = Object.entries(fileCounts)
    .sort(function (a, b) { return (b[1].views + b[1].edits) - (a[1].views + a[1].edits); });
  if (fileEntries.length > 0) {
    parts.push("=== FILES ACCESSED (sorted by frequency) ===");
    for (var fi = 0; fi < Math.min(fileEntries.length, 30); fi++) {
      var f = fileEntries[fi];
      parts.push("  " + f[0] + " (views: " + f[1].views + ", edits: " + f[1].edits + ")");
    }
    if (fileEntries.length > 30) {
      parts.push("  ... and " + (fileEntries.length - 30) + " more files");
    }
    parts.push("");
  }

  // Error details
  if (errorList.length > 0) {
    parts.push("=== ERRORS (" + errorList.length + " total) ===");
    for (var eri = 0; eri < Math.min(errorList.length, 20); eri++) {
      var err = errorList[eri];
      parts.push("  Turn " + err.turn + " [" + err.tool + "]: " + err.text);
    }
    if (errorList.length > 20) {
      parts.push("  ... and " + (errorList.length - 20) + " more errors");
    }
    parts.push("");
  }

  // Per-turn detail with tool I/O
  parts.push("=== TURNS ===");
  var charBudget = MAX_CONTEXT_CHARS - parts.join("\n").length;
  var safeTurns = turns || [];

  for (var ti = 0; ti < safeTurns.length; ti++) {
    var turn = safeTurns[ti];
    var turnHeader = "--- Turn " + turn.index + " ---";
    if (turn.userMessage) {
      turnHeader += "\nUser: " + truncate(turn.userMessage, 300);
    }

    var turnEvents = [];
    var eventIndices = turn.eventIndices || [];
    for (var ei = 0; ei < eventIndices.length; ei++) {
      var event = events[eventIndices[ei]];
      if (!event) continue;

      var line = "";
      if (event.track === "tool_call" && event.toolName) {
        line = "[tool] " + event.toolName;
        if (event.isError) line += " (ERROR)";
        // Include tool input
        var inputStr = formatToolInput(event.toolInput);
        if (inputStr) line += "\n  Input: " + truncate(inputStr, MAX_INPUT_CHARS);
        // Include tool output (from event text)
        if (event.text) line += "\n  Output: " + truncate(event.text, MAX_OUTPUT_CHARS);
      } else if (event.track === "reasoning") {
        line = "[reasoning] " + truncate(event.text, MAX_OUTPUT_CHARS);
      } else if (event.track === "output") {
        line = "[output] " + truncate(event.text, MAX_OUTPUT_CHARS);
      } else if (event.agent === "user") {
        continue;
      } else {
        line = "[" + (event.track || "other") + "] " + truncate(event.text, MAX_OUTPUT_CHARS);
      }

      if (line) turnEvents.push(line);
    }

    var turnBlock = turnHeader + "\n" + turnEvents.join("\n") + "\n";

    if (charBudget - turnBlock.length < 0) {
      parts.push("... (remaining " + (safeTurns.length - ti) + " turns truncated for context budget)");
      break;
    }

    charBudget -= turnBlock.length;
    parts.push(turnBlock);
  }

  return parts.join("\n");
}

/**
 * Build the system prompt for a Q&A question.
 */
function buildFullSessionFileAccessMessage(sessionFilePath) {
  return "FULL SESSION FILE ACCESS:\n" +
    "The complete session JSONL file is at: " + sessionFilePath + "\n" +
    "The summary below may be truncated and may not contain all turns.\n" +
    "For questions about specific tool calls, queries, commands, outputs, or errors, " +
    "search the raw JSONL file before answering.\n" +
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
    "IMPORTANT: If the tool output shown is truncated (ends with '...') and you need " +
    "the full output to answer the question, respond ONLY with one or more lines like:\n" +
    "[NEED_DETAIL: Turn 5, powershell]\n" +
    "[NEED_DETAIL: Turn 12, kusto]\n" +
    "The system will automatically fetch the full data and ask you again. " +
    "Only request details you actually need to answer the question.";

  var user = "";
  if (sessionFilePath) {
    user += buildFullSessionFileAccessMessage(sessionFilePath) + "\n\n";
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

/**
 * Build a detail response for requested tool calls.
 * Finds the matching events and returns their full I/O.
 */
export function buildDetailResponse(requests, events) {
  var safeEvents = events || [];
  var parts = ["Here are the full details you requested:\n"];

  for (var i = 0; i < requests.length; i++) {
    var req = requests[i];
    // Find matching events
    var found = false;
    for (var ei = 0; ei < safeEvents.length; ei++) {
      var ev = safeEvents[ei];
      if (ev.turnIndex === req.turnIndex && ev.track === "tool_call" &&
          ev.toolName && ev.toolName.toLowerCase() === req.toolName.toLowerCase()) {
        parts.push("--- Turn " + req.turnIndex + ", " + ev.toolName + " ---");
        var inputStr = formatToolInput(ev.toolInput);
        if (inputStr) parts.push("Input:\n" + truncate(inputStr, MAX_DETAIL_CHARS));
        if (ev.text) parts.push("Output:\n" + truncate(ev.text, MAX_DETAIL_CHARS));
        if (ev.toolInput) {
          // Also include the raw toolInput for structured data (queries, commands)
          try {
            var rawInput = JSON.stringify(ev.toolInput, null, 2);
            if (rawInput.length > inputStr.length + 10) {
              parts.push("Full input (JSON):\n" + truncate(rawInput, MAX_DETAIL_CHARS));
            }
          } catch (e) {}
        }
        parts.push("");
        found = true;
      }
    }
    if (!found) {
      parts.push("--- Turn " + req.turnIndex + ", " + req.toolName + " ---");
      parts.push("(not found in session data)\n");
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
