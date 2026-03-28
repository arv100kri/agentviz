/**
 * Programmatic Q&A evaluation harness for AGENTVIZ.
 * Runs golden dataset questions through the Q&A pipeline and measures
 * routing accuracy and latency.
 *
 * Usage: node --experimental-strip-types test-files/evaluate-qa-dataset.js
 * Input: test-files/qa-golden-dataset.json
 * Output: test-files/qa-evaluation-results.json
 */

import fs from "node:fs";
import path from "node:path";
import { parseCopilotCliJSONL } from "../src/lib/copilotCliParser.ts";
import {
  buildSessionQAArtifacts,
  compileSessionQAQueryProgram,
  routeSessionQAQuestion,
  buildQAContext,
} from "../src/lib/sessionQA.js";

var SESSION_DIR = path.join(process.env.USERPROFILE || process.env.HOME || "", ".copilot", "session-state");

var dataset = JSON.parse(fs.readFileSync(path.join("test-files", "qa-golden-dataset.json"), "utf8"));

function findSessionFile(fullId) {
  // fullId is like "copilot-cli:UUID:events.jsonl"
  var parts = fullId.split(":");
  if (parts.length < 2) return null;
  var uuid = parts[1];
  var filePath = path.join(SESSION_DIR, uuid, "events.jsonl");
  return fs.existsSync(filePath) ? filePath : null;
}

function truncate(value, maxLen) {
  if (!value || typeof value !== "string") return "";
  return value.length <= maxLen ? value : value.substring(0, maxLen - 3) + "...";
}

// Cache parsed sessions
var sessionCache = {};

function getSession(fullId) {
  if (sessionCache[fullId]) return sessionCache[fullId];

  var filePath = findSessionFile(fullId);
  if (!filePath) return null;

  var stat = fs.statSync(filePath);
  var sizeBytes = stat.size;

  // For huge files, limit parse to first 8MB
  var text;
  if (sizeBytes > 8 * 1024 * 1024) {
    var fd = fs.openSync(filePath, "r");
    var buf = Buffer.alloc(8 * 1024 * 1024);
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    var str = buf.toString("utf8");
    var lastNewline = str.lastIndexOf("\n");
    text = lastNewline > 0 ? str.substring(0, lastNewline + 1) : str;
  } else {
    text = fs.readFileSync(filePath, "utf8");
  }

  var parsed = parseCopilotCliJSONL(text);
  if (!parsed) return null;

  var artifacts = buildSessionQAArtifacts(parsed.events, parsed.turns, parsed.metadata);

  sessionCache[fullId] = {
    events: parsed.events,
    turns: parsed.turns,
    metadata: parsed.metadata,
    artifacts: artifacts,
  };

  return sessionCache[fullId];
}

// Run evaluation
console.log("Evaluating " + dataset.questions.length + " questions...\n");

var results = [];
var routingCorrect = 0;
var routingTotal = 0;
var latencyBuckets = { instant: [], fast: [], model: [] };
var familyAccuracy = {};
var errors = [];

for (var i = 0; i < dataset.questions.length; i++) {
  var q = dataset.questions[i];
  var session = getSession(q.sessionId);

  if (!session) {
    errors.push({ id: q.id, question: q.question, error: "Session not found: " + q.sessionId });
    continue;
  }

  var startMs = Date.now();

  // Compile query program
  var program = compileSessionQAQueryProgram(q.question, session.artifacts);

  // Route the question
  var route = routeSessionQAQuestion(q.question, session.artifacts);

  // Build context (for model questions)
  var contextLength = 0;
  if (route) {
    var context = buildQAContext(session.events, session.turns, session.metadata, {
      question: q.question,
      artifacts: session.artifacts,
      route: route,
    });
    contextLength = context ? context.length : 0;
  }

  var elapsedMs = Date.now() - startMs;

  // Check routing accuracy
  var actualFamily = program.family;
  var expectedFamily = q.expectedFamily;
  var routingMatch = actualFamily === expectedFamily;

  // Determine actual latency tier
  var isDeterministic = program.deterministic && !program.needsModel;
  var actualLatency = isDeterministic ? "instant" : (elapsedMs < 100 ? "fast" : "model");

  routingTotal++;
  if (routingMatch) routingCorrect++;

  if (!familyAccuracy[expectedFamily]) familyAccuracy[expectedFamily] = { correct: 0, total: 0, misrouted: [] };
  familyAccuracy[expectedFamily].total++;
  if (routingMatch) {
    familyAccuracy[expectedFamily].correct++;
  } else {
    familyAccuracy[expectedFamily].misrouted.push({
      id: q.id,
      question: truncate(q.question, 60),
      expected: expectedFamily,
      actual: actualFamily,
    });
  }

  latencyBuckets[q.expectedLatency].push(elapsedMs);

  results.push({
    id: q.id,
    question: truncate(q.question, 80),
    difficulty: q.difficulty,
    expectedFamily: expectedFamily,
    actualFamily: actualFamily,
    routingMatch: routingMatch,
    deterministic: isDeterministic,
    expectedLatency: q.expectedLatency,
    actualLatencyMs: elapsedMs,
    contextChars: contextLength,
    routeKind: route ? route.kind : null,
  });

  if ((i + 1) % 50 === 0) {
    console.log("  Evaluated " + (i + 1) + "/" + dataset.questions.length + " questions...");
  }
}

// Compute summary stats
function percentile(arr, p) {
  if (arr.length === 0) return 0;
  var sorted = arr.slice().sort(function (a, b) { return a - b; });
  var idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

var allLatencies = results.map(function (r) { return r.actualLatencyMs; });

var summary = {
  totalQuestions: dataset.questions.length,
  evaluated: results.length,
  errors: errors.length,
  routingAccuracy: routingTotal > 0 ? Math.round(routingCorrect / routingTotal * 100) + "%" : "N/A",
  routingCorrect: routingCorrect,
  routingTotal: routingTotal,
  latency: {
    p50: percentile(allLatencies, 50) + "ms",
    p90: percentile(allLatencies, 90) + "ms",
    p99: percentile(allLatencies, 99) + "ms",
    max: Math.max.apply(null, allLatencies) + "ms",
  },
  deterministicCount: results.filter(function (r) { return r.deterministic; }).length,
  modelRequiredCount: results.filter(function (r) { return !r.deterministic; }).length,
  familyAccuracy: {},
};

Object.keys(familyAccuracy).forEach(function (family) {
  var fa = familyAccuracy[family];
  summary.familyAccuracy[family] = {
    accuracy: fa.total > 0 ? Math.round(fa.correct / fa.total * 100) + "%" : "N/A",
    correct: fa.correct,
    total: fa.total,
    misrouted: fa.misrouted.slice(0, 5),
  };
});

var output = {
  evaluatedAt: new Date().toISOString(),
  summary: summary,
  results: results,
  errors: errors,
};

var outputPath = path.join("test-files", "qa-evaluation-results.json");
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

// Print summary
console.log("\n========== EVALUATION SUMMARY ==========");
console.log("Questions evaluated: " + results.length + "/" + dataset.questions.length);
console.log("Routing accuracy: " + summary.routingAccuracy + " (" + routingCorrect + "/" + routingTotal + ")");
console.log("Deterministic: " + summary.deterministicCount + " | Model-required: " + summary.modelRequiredCount);
console.log("Latency: p50=" + summary.latency.p50 + " p90=" + summary.latency.p90 + " p99=" + summary.latency.p99 + " max=" + summary.latency.max);
console.log("");
console.log("Family accuracy:");
Object.keys(summary.familyAccuracy).forEach(function (family) {
  var fa = summary.familyAccuracy[family];
  console.log("  " + family.padEnd(25) + fa.accuracy.padEnd(6) + " (" + fa.correct + "/" + fa.total + ")" +
    (fa.misrouted.length > 0 ? " MISROUTED: " + fa.misrouted.map(function (m) { return m.actual; }).join(", ") : ""));
});
if (errors.length > 0) {
  console.log("\nErrors:");
  errors.forEach(function (e) { console.log("  " + e.id + ": " + e.error); });
}
console.log("\nWrote results to " + outputPath);
