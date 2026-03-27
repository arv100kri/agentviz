/**
 * Generate a structured session digest from raw JSONL text.
 *
 * Sections:
 *   1. Queries & Commands -- grep patterns, shell commands, search queries
 *   2. Files Examined -- ordered by access frequency (views vs edits)
 *   3. Errors Encountered -- turn number, tool name, error message
 *   4. Hypotheses & Outcomes -- confirmed, abandoned, or open
 *   5. Key Decisions -- decision points with rationale
 */

var COMMAND_TOOLS = [
  "grep", "bash", "powershell", "Bash", "shell", "exec", "run_command",
  "search_code", "search_issues", "search_pull_requests", "search_repositories",
  "kusto", "query", "sql",
];

var FILE_VIEW_TOOLS = ["view", "View", "Read", "read", "get_file_contents", "cat"];
var FILE_EDIT_TOOLS = ["edit", "Edit", "Write", "write", "create", "Create", "insert"];

var HYPOTHESIS_START = [
  "i think", "let me try", "this suggests", "it looks like",
  "my hypothesis", "i suspect", "this might", "possibly",
  "it seems", "let me check", "i believe", "this could",
];
var HYPOTHESIS_CONFIRMED = [
  "confirmed", "that worked", "as expected", "this confirms",
  "yes,", "correct", "that fixed", "successfully",
];
var HYPOTHESIS_ABANDONED = [
  "that didn't work", "abandoning", "instead", "wrong approach",
  "not the issue", "that's not it", "let me try something else",
  "actually,", "nope", "failed",
];

var DECISION_PATTERNS = [
  "i'll ", "i will ", "decided to", "choosing", "the approach is",
  "instead of", "going with", "let's ", "my plan is",
  "the best approach", "i'm going to", "switching to",
];

function truncate(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.substring(0, max) + "...";
}

function extractPath(input) {
  if (!input) return null;
  if (typeof input === "string") return input;
  return input.path || input.file || input.file_path || input.filename || null;
}

function extractCommand(input) {
  if (!input) return null;
  if (typeof input === "string") return input;
  return input.command || input.pattern || input.query || input.script ||
    input.content || input.input || null;
}

function lowerIncludes(text, patterns) {
  if (!text) return false;
  var lower = text.toLowerCase();
  for (var i = 0; i < patterns.length; i++) {
    if (lower.indexOf(patterns[i]) !== -1) return true;
  }
  return false;
}

/**
 * Parse raw JSONL text and extract a structured digest.
 * @param {string} rawText - Raw JSONL file content
 * @returns {{ queries: Array, files: Array, errors: Array, hypotheses: Array, decisions: Array }}
 */
export function digestSession(rawText) {
  var lines = (rawText || "").split("\n").filter(function (l) { return l.trim(); });

  // Detect format
  var isCopilotCli = false;
  for (var i = 0; i < Math.min(lines.length, 5); i++) {
    if (lines[i].indexOf('"copilot-agent"') !== -1 ||
        lines[i].indexOf('"copilot_agent"') !== -1) {
      isCopilotCli = true;
      break;
    }
  }

  var queries = [];
  var fileCounts = {};
  var errors = [];
  var hypotheses = [];
  var decisions = [];

  var currentTurn = 0;
  var pendingToolCalls = {};

  for (var i = 0; i < lines.length; i++) {
    try {
      var record = JSON.parse(lines[i]);
    } catch (e) { continue; }

    if (isCopilotCli) {
      var rtype = record.type || "";
      var data = record.data || {};

      // Track turns
      if (rtype === "assistant.turn_start") currentTurn++;

      // Tool execution
      if (rtype === "tool.execution_start") {
        var toolName = data.toolName || "";
        var toolInput = data.toolInput || data.input || {};

        // Track pending tool calls for result pairing
        if (record.id) {
          pendingToolCalls[record.id] = { toolName: toolName, input: toolInput };
        }

        // Queries & Commands
        if (COMMAND_TOOLS.indexOf(toolName) !== -1) {
          var cmd = extractCommand(toolInput);
          queries.push({
            turn: currentTurn,
            tool: toolName,
            command: truncate(cmd, 200),
          });
        }

        // Files
        var filePath = extractPath(toolInput);
        if (filePath) {
          if (!fileCounts[filePath]) fileCounts[filePath] = { views: 0, edits: 0 };
          if (FILE_EDIT_TOOLS.indexOf(toolName) !== -1) {
            fileCounts[filePath].edits++;
          } else if (FILE_VIEW_TOOLS.indexOf(toolName) !== -1) {
            fileCounts[filePath].views++;
          }
        }
      }

      // Errors
      if (rtype === "tool.execution_complete" && data.isError) {
        var errorTool = data.toolName || "unknown";
        var errorText = truncate(data.result || data.output || data.error || "", 300);
        errors.push({ turn: currentTurn, tool: errorTool, message: errorText });
      }
      if (rtype === "session.error") {
        errors.push({
          turn: currentTurn,
          tool: "session",
          message: truncate(data.message || data.error || JSON.stringify(data), 300),
        });
      }

      // Reasoning and assistant messages for hypotheses/decisions
      if (rtype === "assistant.reasoning" || rtype === "assistant.message") {
        var text = data.content || data.text || "";
        if (typeof text !== "string") text = JSON.stringify(text);

        if (lowerIncludes(text, HYPOTHESIS_START)) {
          var status = "open";
          hypotheses.push({
            turn: currentTurn,
            text: truncate(text, 300),
            status: status,
          });
        }

        if (lowerIncludes(text, DECISION_PATTERNS)) {
          decisions.push({
            turn: currentTurn,
            text: truncate(text, 300),
          });
        }
      }
    } else {
      // Claude Code format
      var ctype = record.type;

      if (ctype === "human" || ctype === "user") currentTurn++;

      if (ctype === "assistant" && record.message && record.message.content) {
        var content = record.message.content;
        if (Array.isArray(content)) {
          for (var ci = 0; ci < content.length; ci++) {
            var block = content[ci];
            if (block.type === "tool_use") {
              var toolName = block.name || "";
              var toolInput = block.input || {};

              if (COMMAND_TOOLS.indexOf(toolName) !== -1) {
                var cmd = extractCommand(toolInput);
                queries.push({ turn: currentTurn, tool: toolName, command: truncate(cmd, 200) });
              }

              var filePath = extractPath(toolInput);
              if (filePath) {
                if (!fileCounts[filePath]) fileCounts[filePath] = { views: 0, edits: 0 };
                if (FILE_EDIT_TOOLS.indexOf(toolName) !== -1) {
                  fileCounts[filePath].edits++;
                } else if (FILE_VIEW_TOOLS.indexOf(toolName) !== -1) {
                  fileCounts[filePath].views++;
                }
              }
            }
            if (block.type === "text" && block.text) {
              var text = block.text;
              if (lowerIncludes(text, HYPOTHESIS_START)) {
                hypotheses.push({ turn: currentTurn, text: truncate(text, 300), status: "open" });
              }
              if (lowerIncludes(text, DECISION_PATTERNS)) {
                decisions.push({ turn: currentTurn, text: truncate(text, 300) });
              }
            }
          }
        }
      }

      if (ctype === "tool_result" || ctype === "tool_output") {
        if (record.is_error || record.isError) {
          var errorContent = record.content || record.output || "";
          if (Array.isArray(errorContent)) {
            errorContent = errorContent.map(function (b) { return b.text || ""; }).join("\n");
          }
          errors.push({
            turn: currentTurn,
            tool: record.tool_name || "unknown",
            message: truncate(typeof errorContent === "string" ? errorContent : JSON.stringify(errorContent), 300),
          });
        }
      }
    }
  }

  // Resolve hypothesis statuses by scanning subsequent text
  for (var hi = 0; hi < hypotheses.length; hi++) {
    var hyp = hypotheses[hi];
    // Look at decisions and later hypotheses to infer status
    for (var di = 0; di < decisions.length; di++) {
      if (decisions[di].turn > hyp.turn) {
        if (lowerIncludes(decisions[di].text, HYPOTHESIS_CONFIRMED)) {
          hyp.status = "confirmed";
          break;
        }
        if (lowerIncludes(decisions[di].text, HYPOTHESIS_ABANDONED)) {
          hyp.status = "abandoned";
          break;
        }
      }
    }
  }

  // Build sorted file list
  var files = Object.entries(fileCounts)
    .map(function (entry) {
      return { path: entry[0], views: entry[1].views, edits: entry[1].edits, total: entry[1].views + entry[1].edits };
    })
    .sort(function (a, b) { return b.total - a.total; });

  return { queries: queries, files: files, errors: errors, hypotheses: hypotheses, decisions: decisions };
}

/**
 * Format a digest object as markdown.
 * @param {object} digest - Output of digestSession()
 * @param {string} sessionName - Filename for the header
 * @returns {string} Markdown text
 */
export function formatDigestMarkdown(digest, sessionName) {
  var md = "# Session Digest: " + (sessionName || "unknown") + "\n\n";

  // Queries & Commands
  md += "## Queries & Commands\n\n";
  if (digest.queries.length === 0) {
    md += "_No commands or queries found._\n\n";
  } else {
    for (var i = 0; i < digest.queries.length; i++) {
      var q = digest.queries[i];
      md += "- **Turn " + q.turn + "** `" + q.tool + "`: `" + (q.command || "(no input)") + "`\n";
    }
    md += "\n";
  }

  // Files Examined
  md += "## Files Examined\n\n";
  if (digest.files.length === 0) {
    md += "_No file operations found._\n\n";
  } else {
    md += "| File | Views | Edits | Total |\n";
    md += "|------|-------|-------|-------|\n";
    for (var i = 0; i < digest.files.length; i++) {
      var f = digest.files[i];
      md += "| `" + f.path + "` | " + f.views + " | " + f.edits + " | " + f.total + " |\n";
    }
    md += "\n";
  }

  // Errors Encountered
  md += "## Errors Encountered\n\n";
  if (digest.errors.length === 0) {
    md += "_No errors found._\n\n";
  } else {
    for (var i = 0; i < digest.errors.length; i++) {
      var e = digest.errors[i];
      md += "- **Turn " + e.turn + "** `" + e.tool + "`: " + (e.message || "(no details)") + "\n";
    }
    md += "\n";
  }

  // Hypotheses & Outcomes
  md += "## Hypotheses & Outcomes\n\n";
  if (digest.hypotheses.length === 0) {
    md += "_No hypotheses detected._\n\n";
  } else {
    for (var i = 0; i < digest.hypotheses.length; i++) {
      var h = digest.hypotheses[i];
      var badge = h.status === "confirmed" ? "\u2705" : h.status === "abandoned" ? "\u274c" : "\u2753";
      md += "- " + badge + " **Turn " + h.turn + "** [" + h.status + "]: " + h.text + "\n";
    }
    md += "\n";
  }

  // Key Decisions
  md += "## Key Decisions\n\n";
  if (digest.decisions.length === 0) {
    md += "_No explicit decisions detected._\n\n";
  } else {
    for (var i = 0; i < digest.decisions.length; i++) {
      var d = digest.decisions[i];
      md += "- **Turn " + d.turn + "**: " + d.text + "\n";
    }
    md += "\n";
  }

  return md;
}
