/**
 * Session Q&A - build context and prompts for asking questions about a session.
 *
 * Builds a compact text summary of the session suitable for LLM context,
 * and constructs prompts that instruct the model to answer grounded in
 * session data with turn references.
 */

var MAX_CONTEXT_CHARS = 24000;
var MAX_TEXT_PER_EVENT = 200;

/**
 * Build a compact text context from parsed session data.
 * Stays within a character budget so the LLM has room for its response.
 */
export function buildQAContext(events, turns, metadata) {
  var parts = [];

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

  // Per-turn summary
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
        if (event.text) line += ": " + truncate(event.text, MAX_TEXT_PER_EVENT);
      } else if (event.track === "reasoning") {
        line = "[reasoning] " + truncate(event.text, MAX_TEXT_PER_EVENT);
      } else if (event.track === "output") {
        line = "[output] " + truncate(event.text, MAX_TEXT_PER_EVENT);
      } else if (event.agent === "user") {
        // Already captured in turnHeader
        continue;
      } else {
        line = "[" + (event.track || "other") + "] " + truncate(event.text, MAX_TEXT_PER_EVENT);
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
export function buildQAPrompt(question, context) {
  return {
    system: "You are an AI assistant that answers questions about a coding session. " +
      "You have access to the session's event log below. Answer ONLY based on what is " +
      "in the session data. If the answer is not in the session, say so.\n\n" +
      "When referencing specific moments, cite turn numbers like [Turn 3]. " +
      "Keep answers concise and factual. Use markdown formatting.\n\n" +
      "SESSION DATA:\n" + context,
    user: question,
  };
}

function truncate(text, max) {
  if (!text) return "";
  var str = String(text);
  if (str.length <= max) return str;
  return str.substring(0, max) + "...";
}
