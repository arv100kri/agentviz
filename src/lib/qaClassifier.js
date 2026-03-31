/**
 * Client-side Q&A classifier for instant answers.
 *
 * Fast path: answers common questions from session data in <5ms
 * without hitting the server pipeline. Falls through to the server
 * for anything it can't answer.
 *
 * classify(question, sessionData) -> { tier: "instant"|"model", answer? }
 */

import { formatDuration } from "./formatTime.js";
import { estimateCost, formatCost } from "./pricing.js";

var PATTERNS = [
  { id: "tools",     re: /\b(tools?\s+used|tool\s+calls?|which\s+tools?|what\s+tools?\s+(were|was|did)|most.?used\s+tool|top\s+tools?|tool\s+count|how\s+many\s+tools?|list\s+(all\s+)?tools|tool\s+(ranking|breakdown|stats?))\b/i },
  { id: "errors",    re: /\b(how\s+many\s+errors?|any\s+errors?|what\s+errors?|errors?\s+(occurred|found|count)|show\s+errors?|list\s+errors?|did\s+(anything|it|the)\s+fail|were\s+there\s+(errors?|failures?))\b/i },
  { id: "model",     re: /\b(what\s+model|which\s+model|model\s+(used|was|name)|what\s+llm|which\s+llm)\b/i },
  { id: "duration",  re: /\b(how\s+long\s+(did|was|does)|session\s+duration|total\s+(time|duration)|how\s+long\s+.*\s+(take|last|run))\b/i },
  { id: "cost",      re: /\b(how\s+much\s+(did\s+(it|this)|does\s+it)\s+cost|total\s+cost|estimated?\s+cost|token\s+(usage|count|stats?)|how\s+many\s+tokens?)\b/i },
  { id: "turnN",     re: /\bturn\s*#?\s*(\d+)\b/i },
  { id: "turns",     re: /\b(how\s+many\s+turns|turn\s+count|number\s+of\s+turns|total\s+turns)\b/i },
  { id: "files",     re: /\b(what\s+files?|which\s+files?|files?\s+(edited|read|created|modified|changed|touched|written|viewed)|list\s+(all\s+)?files?|how\s+many\s+files?)\b/i },
  { id: "commands",  re: /\b(what\s+(commands?|bash|shell)|which\s+commands?|commands?\s+(run|ran|executed)|list\s+(all\s+)?commands?|bash\s+(commands?|history)|shell\s+commands?)\b/i },
  { id: "firstTurn", re: /\b(first\s+turn|first\s+thing\s+(done|asked|said)|what\s+(started|began|happened\s+first)|opening\s+turn|initial\s+turn|turn\s+0)\b/i },
  { id: "lastTurn",  re: /\b(last\s+turn|final\s+turn|most\s+recent\s+turn|what\s+(ended|finished|happened\s+last)|closing\s+turn)\b/i },
  { id: "format",    re: /\b(what\s+format|which\s+format|session\s+format|what\s+type\s+of\s+session|is\s+this\s+(claude|copilot))\b/i },
  { id: "userMsgs",  re: /\b(what\s+did\s+the\s+user\s+(ask|say|type|write|request)|user\s+(messages?|prompts?|questions?)|list\s+(all\s+)?(user\s+)?(messages?|prompts?))\b/i },
  { id: "events",    re: /\b(how\s+many\s+events?|event\s+count|total\s+events?|number\s+of\s+events?)\b/i },
  { id: "toolDetail",re: /\b(how\s+many\s+times?\s+(was|did|were)\s+(\w+)\s+(used|called|invoked)|(\w+)\s+tool\s+(count|usage|calls?)|how\s+was\s+(\w+)\s+used)\b/i },
  { id: "summary",   re: /\b(summarize?\s+(this|the)\s+session|session\s+(summary|overview|recap))\b/i },
];

function matchPattern(q) {
  var turnNMatch = PATTERNS.find(function (p) { return p.id === "turnN"; });
  if (turnNMatch && turnNMatch.re.test(q)) return "turnN";
  for (var i = 0; i < PATTERNS.length; i++) {
    if (PATTERNS[i].id === "turnN") continue;
    if (PATTERNS[i].re.test(q)) return PATTERNS[i].id;
  }
  return null;
}

function instant(answer) { return { tier: "instant", answer: answer }; }
function truncate(text, maxLen) { if (!text) return ""; return text.length <= maxLen ? text : text.slice(0, maxLen) + "..."; }

export function classifyInstant(question, data) {
  if (!question || !data || !data.metadata) return null;
  var q = question.trim();
  var matched = matchPattern(q);
  if (!matched) return null;

  var meta = data.metadata;
  var events = data.events || [];
  var turns = data.turns || [];

  if (matched === "tools") {
    var counts = {};
    for (var i = 0; i < events.length; i++) {
      if (events[i].track === "tool_call" && events[i].toolName) counts[events[i].toolName] = (counts[events[i].toolName] || 0) + 1;
    }
    var sorted = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 10);
    if (sorted.length === 0) return instant("No tool calls found in this session.");
    var total = meta.totalToolCalls || 0;
    var lines = ["This session made **" + total + " tool call" + (total !== 1 ? "s" : "") + "** across " + sorted.length + " tool" + (sorted.length !== 1 ? "s" : "") + ":\n"];
    sorted.forEach(function (t) { lines.push("- **" + t + "**: " + counts[t]); });
    return instant(lines.join("\n"));
  }

  if (matched === "errors") {
    var errCount = meta.errorCount || 0;
    if (errCount === 0) return instant("No errors found in this session.");
    var samples = [];
    for (var ei = 0; ei < events.length && samples.length < 5; ei++) {
      if (events[ei].isError) samples.push({ text: events[ei].text, turn: events[ei].turnIndex });
    }
    var eLines = ["**" + errCount + " error" + (errCount !== 1 ? "s" : "") + "** found:\n"];
    samples.forEach(function (s) { eLines.push("- " + truncate(s.text, 120) + (s.turn != null ? " [Turn " + s.turn + "]" : "")); });
    if (errCount > samples.length) eLines.push("\n(" + (errCount - samples.length) + " more not shown)");
    return instant(eLines.join("\n"));
  }

  if (matched === "model") {
    if (!meta.primaryModel) return instant("No model information available.");
    var mLines = ["Primary model: **" + meta.primaryModel + "**"];
    if (meta.models && Object.keys(meta.models).length > 1) {
      mLines.push("\nAll models used:");
      for (var mn in meta.models) mLines.push("- " + mn + ": " + meta.models[mn] + " call" + (meta.models[mn] !== 1 ? "s" : ""));
    }
    return instant(mLines.join("\n"));
  }

  if (matched === "duration") {
    if (!meta.duration) return instant("Duration not available.");
    return instant("Session duration: **" + formatDuration(meta.duration) + "**");
  }

  if (matched === "cost") {
    var usage = meta.tokenUsage;
    if (!usage || (!usage.inputTokens && !usage.outputTokens)) return instant("No token usage data available.");
    var cost = estimateCost(usage, meta.primaryModel);
    var cLines = ["Estimated cost: **" + formatCost(cost) + "**\n"];
    if (usage.inputTokens) cLines.push("- Input tokens: " + usage.inputTokens.toLocaleString());
    if (usage.outputTokens) cLines.push("- Output tokens: " + usage.outputTokens.toLocaleString());
    if (usage.cacheRead) cLines.push("- Cache read: " + usage.cacheRead.toLocaleString());
    return instant(cLines.join("\n"));
  }

  if (matched === "turns") return instant("This session has **" + (meta.totalTurns || 0) + " turn" + ((meta.totalTurns || 0) !== 1 ? "s" : "") + "**.");
  if (matched === "events") return instant("This session has **" + (meta.totalEvents || events.length) + " event" + ((meta.totalEvents || events.length) !== 1 ? "s" : "") + "**.");
  if (matched === "format") return instant("Session format: **" + (meta.format || "unknown") + "**");

  if (matched === "turnN") {
    var turnMatch = q.match(/\bturn\s*#?\s*(\d+)\b/i);
    if (turnMatch) {
      var idx = parseInt(turnMatch[1], 10);
      if (idx < 0 || idx >= turns.length) return instant("Turn " + idx + " not found. This session has " + turns.length + " turns (0-indexed).");
      var turn = turns[idx];
      var tEvents = events.filter(function (e) { return e.turnIndex === idx; });
      var tTools = tEvents.filter(function (e) { return e.track === "tool_call"; });
      var tErrors = tEvents.filter(function (e) { return e.isError; });
      var tLines = ["**Turn " + idx + "**\n"];
      if (turn.userMessage) tLines.push('User: "' + truncate(turn.userMessage, 200) + '"');
      tLines.push("- Events: " + tEvents.length + ", Tool calls: " + tTools.length);
      if (tErrors.length) tLines.push("- Errors: " + tErrors.length);
      return instant(tLines.join("\n"));
    }
  }

  if (matched === "firstTurn") {
    if (turns.length === 0) return instant("No turns in this session.");
    var ft = turns[0];
    return instant("**Turn 0**: " + (ft.userMessage ? '"' + truncate(ft.userMessage, 200) + '"' : "(continuation)") + "\n- " + (ft.toolCount || 0) + " tool calls");
  }

  if (matched === "lastTurn") {
    if (turns.length === 0) return instant("No turns in this session.");
    var lt = turns[turns.length - 1];
    return instant("**Turn " + (turns.length - 1) + "**: " + (lt.userMessage ? '"' + truncate(lt.userMessage, 200) + '"' : "(continuation)") + "\n- " + (lt.toolCount || 0) + " tool calls");
  }

  if (matched === "userMsgs") {
    var msgs = [];
    for (var ui = 0; ui < turns.length; ui++) {
      if (turns[ui].userMessage) msgs.push({ turn: ui, msg: turns[ui].userMessage });
    }
    if (msgs.length === 0) return instant("No user messages found.");
    var uLines = ["**" + msgs.length + " user message" + (msgs.length !== 1 ? "s" : "") + "**:\n"];
    msgs.slice(0, 15).forEach(function (m) { uLines.push("- [Turn " + m.turn + '] "' + truncate(m.msg, 120) + '"'); });
    if (msgs.length > 15) uLines.push("\n(" + (msgs.length - 15) + " more not shown)");
    return instant(uLines.join("\n"));
  }

  if (matched === "commands") {
    var cmds = [];
    for (var ci = 0; ci < events.length; ci++) {
      var ev = events[ci];
      if (ev.track !== "tool_call") continue;
      var name = (ev.toolName || "").toLowerCase();
      if (name !== "bash" && name !== "shell" && name !== "powershell" && name !== "terminal" && name !== "execute_command") continue;
      var input = ev.toolInput || "";
      var inputStr = typeof input === "string" ? input : JSON.stringify(input);
      var cmdMatch = inputStr.match(/(?:command|cmd|script)["\s:=]+["']?([^\n"']{1,200})/i);
      if (cmdMatch) cmds.push({ cmd: cmdMatch[1].trim(), turn: ev.turnIndex });
      else if (typeof input === "string" && input.length < 200) cmds.push({ cmd: input.trim(), turn: ev.turnIndex });
    }
    if (cmds.length === 0) return instant("No shell commands found.");
    var cmdLines = ["**" + cmds.length + " command" + (cmds.length !== 1 ? "s" : "") + "** executed:\n"];
    cmds.slice(0, 20).forEach(function (c) { cmdLines.push("- `" + truncate(c.cmd, 120) + "`" + (c.turn != null ? " [Turn " + c.turn + "]" : "")); });
    if (cmds.length > 20) cmdLines.push("\n(" + (cmds.length - 20) + " more not shown)");
    return instant(cmdLines.join("\n"));
  }

  if (matched === "files") {
    var fileMap = {};
    for (var fi = 0; fi < events.length; fi++) {
      var fev = events[fi];
      if (fev.track !== "tool_call" || !fev.toolName) continue;
      var finp = fev.toolInput ? (typeof fev.toolInput === "string" ? fev.toolInput : JSON.stringify(fev.toolInput)) : "";
      var fpMatch = finp.match(/(?:file_path|path|file|filename)["\s:=]+["']?([^\s"',}\]]+)/i);
      if (fpMatch) {
        var fp = fpMatch[1];
        if (!fileMap[fp]) fileMap[fp] = [];
        if (fileMap[fp].indexOf(fev.toolName) === -1) fileMap[fp].push(fev.toolName);
      }
    }
    var files = Object.keys(fileMap);
    if (files.length === 0) return instant("No file operations detected.");
    var fLines = ["**" + files.length + " file" + (files.length !== 1 ? "s" : "") + "** touched:\n"];
    files.slice(0, 30).forEach(function (f) { fLines.push("- `" + f + "` (" + fileMap[f].join(", ") + ")"); });
    if (files.length > 30) fLines.push("\n(" + (files.length - 30) + " more not shown)");
    return instant(fLines.join("\n"));
  }

  if (matched === "toolDetail") {
    var tdMatch = q.match(/\b(?:how\s+many\s+times?\s+(?:was|did|were)\s+)(\w+)/i);
    if (!tdMatch) tdMatch = q.match(/\b(\w+)\s+tool\s+(?:count|usage|calls?)/i);
    if (!tdMatch) tdMatch = q.match(/\bhow\s+was\s+(\w+)\s+used/i);
    if (!tdMatch) return null;
    var toolName = tdMatch[1].toLowerCase();
    var tdCount = 0;
    var tdMatched = null;
    for (var tdi = 0; tdi < events.length; tdi++) {
      if (events[tdi].track === "tool_call" && events[tdi].toolName && events[tdi].toolName.toLowerCase() === toolName) {
        tdCount++;
        if (!tdMatched) tdMatched = events[tdi].toolName;
      }
    }
    if (tdCount === 0) return instant("Tool **" + toolName + "** was not used in this session.");
    return instant("**" + tdMatched + "** was called **" + tdCount + "** time" + (tdCount !== 1 ? "s" : "") + ".");
  }

  if (matched === "summary") {
    var sLines = [
      "**Session summary**\n",
      "- Format: " + (meta.format || "unknown"),
      "- Duration: " + formatDuration(meta.duration),
      "- Turns: " + (meta.totalTurns || 0),
      "- Tool calls: " + (meta.totalToolCalls || 0),
      "- Errors: " + (meta.errorCount || 0),
      "- Model: " + (meta.primaryModel || "unknown"),
    ];
    if (meta.tokenUsage && (meta.tokenUsage.inputTokens || meta.tokenUsage.outputTokens)) {
      sLines.push("- Est. cost: " + formatCost(estimateCost(meta.tokenUsage, meta.primaryModel)));
    }
    return instant(sLines.join("\n"));
  }

  return null;
}
