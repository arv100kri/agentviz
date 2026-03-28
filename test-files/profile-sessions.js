/**
 * Session profiler for golden Q&A dataset generation.
 * Parses selected sessions, extracts characteristics for question generation.
 *
 * Usage: node test-files/profile-sessions.js
 * Output: test-files/session-profiles.json
 */

import fs from "node:fs";
import path from "node:path";
import { parseCopilotCliJSONL } from "../src/lib/copilotCliParser.ts";
import { parseClaudeCodeJSONL } from "../src/lib/parser.ts";

var SESSIONS = [
  { id: "8a86a63f-3963-430e-91a4-fbc9864c41c9", label: "AgentViz Q&A" },
  { id: "224334e2-d474-4925-af37-a30a3c1f5860", label: "Explore Repository And Run App" },
  { id: "ecdc9dab-5ccf-405f-b9e3-631c3cc686b9", label: "Create Automated UX Testing Skill" },
  { id: "4efe7267-186a-4640-9f2b-b7630959bda0", label: "AgentViz CLI mode" },
  { id: "8cfb77ae-8988-4273-82da-eace3b28d7f7", label: "Secure IPS-SC Communication" },
  { id: "9707a0f7-8b30-4faa-866d-003d4ca7348e", label: "Consolidate ClusterGroup Controllers" },
  { id: "13a21ef7-caa8-4af8-ac81-2911c5c2745f", label: "FE to BE communication" },
  { id: "db97d47c-efe8-4c83-a626-dc16e940651d", label: "Assess YARP Integration With OpenSearch" },
  { id: "1554ef53-f5e2-4458-9fc2-0c322e770245", label: "Diagnose EV2 Deployment Failure" },
  { id: "ba9ecfef-bdab-4484-abf1-75cb88ea9a04", label: "Collaborative Agent Technologies Research" },
  { id: "257ec98b-948c-4b88-ab5e-acec5fdfe819", label: "Analyze Unlimited Cluster Provisioning" },
  { id: "801bfda3-9943-4796-b081-8c75ce0d298b", label: "Run Poly Pilot Application" },
  { id: "9020d425-6513-414d-8859-96e36c4e9735", label: "Generate AGENTS.md Hierarchy" },
  { id: "fb17b007-976a-4080-baa2-46e92a4767b9", label: "Ops RCA Critic" },
  { id: "d368cedb-32fd-43f2-a51c-4888197a35fb", label: "Cherry-Pick Commit Range" },
];

var SESSION_DIR = path.join(process.env.USERPROFILE || process.env.HOME || "", ".copilot", "session-state");

function findSessionFile(sessionId) {
  var dir = path.join(SESSION_DIR, sessionId);
  var eventsFile = path.join(dir, "events.jsonl");
  if (fs.existsSync(eventsFile)) return eventsFile;
  return null;
}

function parseSession(text) {
  var firstLine = text.split("\n")[0] || "";
  try {
    var parsed = JSON.parse(firstLine);
    if (parsed && parsed.type && (parsed.type === "session.start" || parsed.type === "session.resume" || parsed.type.startsWith("assistant."))) {
      return parseCopilotCliJSONL(text);
    }
  } catch (e) {}
  return parseClaudeCodeJSONL(text);
}

function truncate(value, maxLen) {
  if (!value || typeof value !== "string") return "";
  return value.length <= maxLen ? value : value.substring(0, maxLen - 3) + "...";
}

function profileSession(sessionId, label) {
  var filePath = findSessionFile(sessionId);
  if (!filePath) return { id: sessionId, label: label, error: "File not found" };

  var stat = fs.statSync(filePath);
  var sizeBytes = stat.size;

  // For huge files, read only first 5MB + last 2MB to extract profile without OOM
  var text;
  var truncated = false;
  if (sizeBytes > 10 * 1024 * 1024) {
    var fd = fs.openSync(filePath, "r");
    var headBuf = Buffer.alloc(5 * 1024 * 1024);
    var tailBuf = Buffer.alloc(2 * 1024 * 1024);
    fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    fs.readSync(fd, tailBuf, 0, tailBuf.length, Math.max(0, sizeBytes - tailBuf.length));
    fs.closeSync(fd);
    // Find last complete line in head
    var headStr = headBuf.toString("utf8");
    var lastNewline = headStr.lastIndexOf("\n");
    if (lastNewline > 0) headStr = headStr.substring(0, lastNewline + 1);
    // Find first complete line in tail
    var tailStr = tailBuf.toString("utf8");
    var firstNewline = tailStr.indexOf("\n");
    if (firstNewline > 0) tailStr = tailStr.substring(firstNewline + 1);
    text = headStr + tailStr;
    truncated = true;
  } else {
    text = fs.readFileSync(filePath, "utf8");
  }

  var parsed = parseSession(text);
  if (!parsed) return { id: sessionId, label: label, error: "Parse failed", sizeBytes: sizeBytes };

  var events = parsed.events || [];
  var turns = parsed.turns || [];
  var metadata = parsed.metadata || {};

  // Extract unique tool names
  var toolNames = {};
  var filePaths = {};
  var commands = {};
  var errorTurns = [];
  var userMessages = [];
  var longestToolCall = null;

  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (ev.toolName) {
      toolNames[ev.toolName] = (toolNames[ev.toolName] || 0) + 1;
    }
    if (ev.toolInput && typeof ev.toolInput === "object") {
      if (ev.toolInput.path) filePaths[ev.toolInput.path] = (filePaths[ev.toolInput.path] || 0) + 1;
      if (ev.toolInput.file) filePaths[ev.toolInput.file] = (filePaths[ev.toolInput.file] || 0) + 1;
      if (ev.toolInput.command) commands[ev.toolInput.command] = true;
    }
    if (ev.isError && ev.turnIndex != null) {
      if (errorTurns.indexOf(ev.turnIndex) === -1) errorTurns.push(ev.turnIndex);
    }
    if (ev.track === "tool_call" && ev.duration > 0) {
      if (!longestToolCall || ev.duration > longestToolCall.duration) {
        longestToolCall = { toolName: ev.toolName, duration: ev.duration, turnIndex: ev.turnIndex, text: truncate(ev.text, 100) };
      }
    }
  }

  for (var t = 0; t < turns.length; t++) {
    if (turns[t].userMessage) {
      userMessages.push({ turnIndex: turns[t].index, message: truncate(turns[t].userMessage, 200) });
    }
  }

  // Identify interesting regions
  var regions = [];
  // First third
  var thirdTurn = Math.floor(turns.length / 3);
  var twoThirdTurn = Math.floor(2 * turns.length / 3);

  // Sample user messages from each third
  var earlyMessages = userMessages.filter(function(m) { return m.turnIndex < thirdTurn; }).slice(0, 3);
  var middleMessages = userMessages.filter(function(m) { return m.turnIndex >= thirdTurn && m.turnIndex < twoThirdTurn; }).slice(0, 3);
  var lateMessages = userMessages.filter(function(m) { return m.turnIndex >= twoThirdTurn; }).slice(0, 3);

  // Top files by access count
  var topFiles = Object.entries(filePaths).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10);

  // Top tools
  var topTools = Object.entries(toolNames).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10);

  // Sample commands
  var sampleCommands = Object.keys(commands).slice(0, 15).map(function(c) { return truncate(c, 120); });

  return {
    id: sessionId,
    label: label,
    fullId: "copilot-cli:" + sessionId + ":events.jsonl",
    sizeBytes: sizeBytes,
    sizeLabel: sizeBytes < 100 * 1024 ? "small" : sizeBytes < 5 * 1024 * 1024 ? "medium" : sizeBytes < 20 * 1024 * 1024 ? "large" : "huge",
    truncatedParse: truncated,
    turnCount: metadata.totalTurns || turns.length,
    eventCount: metadata.totalEvents || events.length,
    toolCallCount: metadata.totalToolCalls || 0,
    errorCount: metadata.errorCount || 0,
    duration: metadata.duration || 0,
    primaryModel: metadata.primaryModel || null,
    format: metadata.format || "copilot-cli",
    topTools: topTools,
    topFiles: topFiles,
    sampleCommands: sampleCommands,
    errorTurns: errorTurns.slice(0, 10),
    longestToolCall: longestToolCall,
    earlyUserMessages: earlyMessages,
    middleUserMessages: middleMessages,
    lateUserMessages: lateMessages,
    totalUserMessages: userMessages.length,
  };
}

// Profile all sessions
console.log("Profiling " + SESSIONS.length + " sessions...");
var profiles = [];

for (var s = 0; s < SESSIONS.length; s++) {
  var session = SESSIONS[s];
  console.log("  [" + (s + 1) + "/" + SESSIONS.length + "] " + session.label + " (" + session.id.substring(0, 8) + ")...");
  try {
    var profile = profileSession(session.id, session.label);
    profiles.push(profile);
    if (profile.error) {
      console.log("    ERROR: " + profile.error);
    } else {
      console.log("    " + profile.turnCount + " turns, " + profile.eventCount + " events, " + profile.errorCount + " errors, " + Math.round(profile.sizeBytes / 1024) + "KB");
    }
  } catch (err) {
    console.log("    EXCEPTION: " + err.message);
    profiles.push({ id: session.id, label: session.label, error: err.message });
  }
}

var outputPath = path.join("test-files", "session-profiles.json");
fs.writeFileSync(outputPath, JSON.stringify(profiles, null, 2));
console.log("\nWrote " + profiles.length + " profiles to " + outputPath);
