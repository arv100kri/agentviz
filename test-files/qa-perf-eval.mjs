/**
 * Phase 9 Q&A Performance Evaluation Harness (v2)
 * Usage: node test-files/qa-perf-eval.mjs [round_number]
 */

import fs from "fs";
import path from "path";
import { classify, buildModelContext, fingerprintQuestion } from "../src/lib/qaClassifier.js";

var SESSION_DIR = path.join(process.env.HOME || process.env.USERPROFILE || "", ".copilot", "session-state");
var GOLDEN_PATH = "C:/Users/arjagann/.copilot/session-state/8a86a63f-3963-430e-91a4-fbc9864c41c9/files/qa-golden-dataset.json";
var DEEP_PATH = "C:/Users/arjagann/.copilot/session-state/8a86a63f-3963-430e-91a4-fbc9864c41c9/files/qa-deep-questions.jsonl";
var SERVER_URL = "http://localhost:4242";
var TIMEOUT_MS = 60000;

var round = parseInt(process.argv[2] || "1", 10);
console.log("=".repeat(60));
console.log("  PHASE 9 - ITERATION " + round + " / 5");
console.log("=".repeat(60));

var golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
var deepLines = fs.readFileSync(DEEP_PATH, "utf8").trim().split("\n");
var deepQuestions = deepLines.map(function (l) { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);

function step(num, label) { console.log("\n--- ITERATION " + round + " | STEP " + num + ": " + label + " ---\n"); }

function discoverSessions(limit) {
  var results = [];
  try {
    var dirs = fs.readdirSync(SESSION_DIR);
    for (var i = 0; i < dirs.length && results.length < limit * 3; i++) {
      var evFile = path.join(SESSION_DIR, dirs[i], "events.jsonl");
      if (fs.existsSync(evFile)) {
        var stat = fs.statSync(evFile);
        results.push({ id: dirs[i], path: evFile, size: stat.size });
      }
    }
  } catch (_) {}
  results.sort(function (a, b) { return a.size - b.size; });
  var step2 = Math.max(1, Math.floor(results.length / limit));
  var selected = [];
  for (var j = 0; j < results.length && selected.length < limit; j += step2) selected.push(results[j]);
  return selected;
}

function parseSessionFile(filePath) {
  try {
    var content = fs.readFileSync(filePath, "utf8");
    if (!content.trim()) return null;
    var lines = content.split("\n").filter(function (l) { return l.trim(); });
    var events = [], turnMap = {};
    for (var i = 0; i < lines.length; i++) {
      try {
        var obj = JSON.parse(lines[i]);
        var ev = { t: obj.timestamp || obj.t || i, agent: obj.role || obj.agent || "assistant", track: obj.type === "tool_call" || obj.toolName ? "tool_call" : (obj.type || "output"), text: obj.text || obj.content || "", toolName: obj.toolName || obj.tool_name || null, toolInput: obj.toolInput || obj.input || null, isError: Boolean(obj.isError || obj.error), turnIndex: obj.turnIndex != null ? obj.turnIndex : 0, duration: obj.duration || 0, intensity: obj.intensity || 0.5 };
        events.push(ev);
        if (!turnMap[ev.turnIndex]) turnMap[ev.turnIndex] = { index: ev.turnIndex, startTime: ev.t, endTime: ev.t, eventIndices: [], userMessage: null, toolCount: 0, hasError: false };
        var turn = turnMap[ev.turnIndex]; turn.eventIndices.push(i); if (ev.t > turn.endTime) turn.endTime = ev.t; if (ev.agent === "user" && ev.text && !turn.userMessage) turn.userMessage = ev.text; if (ev.track === "tool_call") turn.toolCount++; if (ev.isError) turn.hasError = true;
      } catch (_) {}
    }
    if (events.length === 0) return null;
    var turns = Object.values(turnMap).sort(function (a, b) { return a.index - b.index; });
    var metadata = { totalEvents: events.length, totalTurns: turns.length, totalToolCalls: events.filter(function (e) { return e.track === "tool_call"; }).length, errorCount: events.filter(function (e) { return e.isError; }).length, duration: events.length > 1 ? events[events.length - 1].t - events[0].t : 0, models: {}, primaryModel: "unknown", format: "copilot-cli" };
    return { events: events, turns: turns, metadata: metadata, autonomyMetrics: null };
  } catch (e) { return null; }
}

function askServer(question, context) {
  return new Promise(function (resolve) {
    var startedAt = Date.now();
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); resolve({ answer: "", elapsedMs: Date.now() - startedAt, timedOut: true, tier: "model" }); }, TIMEOUT_MS);
    fetch(SERVER_URL + "/api/qa/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: question, context: context }), signal: controller.signal })
      .then(function (res) { if (!res.ok) { clearTimeout(timer); resolve({ answer: "", elapsedMs: Date.now() - startedAt, error: "HTTP " + res.status, tier: "model" }); return; } var reader = res.body.getReader(); var decoder = new TextDecoder(); var buffer = ""; var answer = "";
        function pump() { return reader.read().then(function (result) { if (result.done) { clearTimeout(timer); resolve({ answer: answer, elapsedMs: Date.now() - startedAt, tier: "model" }); return; } buffer += decoder.decode(result.value, { stream: true }); var lines = buffer.split("\n"); buffer = lines.pop() || ""; for (var i = 0; i < lines.length; i++) { if (lines[i].startsWith("data: ")) { try { var data = JSON.parse(lines[i].slice(6)); if (data.token) answer += data.token; else if (data.done) { clearTimeout(timer); resolve({ answer: answer, elapsedMs: Date.now() - startedAt, tier: "model" }); return; } else if (data.error) { clearTimeout(timer); resolve({ answer: "", elapsedMs: Date.now() - startedAt, error: data.error, tier: "model" }); return; } } catch (_) {} } } return pump(); }); } return pump(); })
      .catch(function (err) { clearTimeout(timer); resolve({ answer: "", elapsedMs: Date.now() - startedAt, timedOut: err.name === "AbortError", error: err.name !== "AbortError" ? err.message : undefined, tier: "model" }); });
  });
}

function percentile(sorted, p) { var idx = Math.ceil(p / 100 * sorted.length) - 1; return sorted[Math.max(0, idx)]; }

async function run() {
  step(1, "DISCOVERING SESSIONS");
  var sessions = discoverSessions(20);
  console.log("Found " + sessions.length + " sessions");

  step(2, "PARSING SESSIONS");
  var parsedSessions = [];
  for (var s = 0; s < sessions.length; s++) {
    var parsed = parseSessionFile(sessions[s].path);
    if (parsed && parsed.events.length > 0) {
      parsedSessions.push({ id: sessions[s].id, size: sessions[s].size, data: parsed });
      process.stdout.write("  [" + (s + 1) + "/" + sessions.length + "] " + sessions[s].id.slice(0, 12) + "... " + parsed.events.length + " events\n");
    }
  }
  console.log("Parsed " + parsedSessions.length + " sessions");

  step(3, "SELECTING 200 QUESTIONS");
  var questions = [];
  var generalQ = golden.questions.filter(function (q) { return q.scope === "general"; }).sort(function () { return Math.random() - 0.5; });
  var sessionQ = golden.questions.filter(function (q) { return q.scope !== "general"; }).sort(function () { return Math.random() - 0.5; });
  deepQuestions.sort(function () { return Math.random() - 0.5; });
  for (var i = 0; i < Math.min(40, generalQ.length); i++) questions.push({ text: generalQ[i].question, difficulty: generalQ[i].difficulty, source: "golden" });
  for (var j = 0; j < Math.min(100, sessionQ.length); j++) questions.push({ text: sessionQ[j].question, difficulty: sessionQ[j].difficulty, source: "golden" });
  for (var k = 0; k < Math.min(60, deepQuestions.length); k++) questions.push({ text: deepQuestions[k].question, difficulty: deepQuestions[k].difficulty || "hard", source: "deep" });
  questions = questions.slice(0, 200);
  console.log("Selected " + questions.length + " questions");

  step(4, "RUNNING QUESTIONS");
  var results = [], instantCount = 0, modelCount = 0, cachedCount = 0, timeoutCount = 0;
  for (var q = 0; q < questions.length; q++) {
    var question = questions[q];
    var sessionData = parsedSessions[q % parsedSessions.length].data;
    var startedAt = Date.now();
    var result = classify(question.text, sessionData);
    if (result.tier === "instant") { results.push({ question: question.text, tier: "instant", elapsedMs: Date.now() - startedAt, difficulty: question.difficulty }); instantCount++; }
    else {
      var fp = fingerprintQuestion(question.text);
      var alreadySeen = fp && results.some(function (r) { return r.fingerprint === fp && r.tier !== "instant" && r.answer; });
      if (alreadySeen) { results.push({ question: question.text, tier: "cached", elapsedMs: 1, difficulty: question.difficulty, fingerprint: fp }); cachedCount++; }
      else {
        var context = buildModelContext(question.text, sessionData);
        var serverResult = await askServer(question.text, context);
        if (serverResult.timedOut) timeoutCount++;
        results.push({ question: question.text, tier: serverResult.timedOut ? "timeout" : "model", elapsedMs: serverResult.elapsedMs, difficulty: question.difficulty, fingerprint: fp, answer: serverResult.answer ? serverResult.answer.slice(0, 100) : "" });
        modelCount++;
      }
    }
    if ((q + 1) % 20 === 0 || q === questions.length - 1) process.stdout.write("  [" + (q + 1) + "/" + questions.length + "] instant: " + instantCount + " model: " + modelCount + " cached: " + cachedCount + " timeout: " + timeoutCount + "\n");
  }

  step(5, "COMPUTING STATISTICS");
  var allLatencies = results.map(function (r) { return r.elapsedMs; }).sort(function (a, b) { return a - b; });
  console.log("Questions: " + results.length);
  console.log("Instant:   " + instantCount + " (" + Math.round(instantCount / results.length * 100) + "%)");
  console.log("Cached:    " + cachedCount);
  console.log("Model:     " + modelCount);
  console.log("Timeouts:  " + timeoutCount);
  console.log("\np50: " + percentile(allLatencies, 50) + "ms");
  console.log("p90: " + percentile(allLatencies, 90) + "ms");
  console.log("p99: " + percentile(allLatencies, 99) + "ms");

  var buckets = [{ label: "<100ms", max: 100, count: 0 }, { label: "100ms-1s", max: 1000, count: 0 }, { label: "1-5s", max: 5000, count: 0 }, { label: "5-15s", max: 15000, count: 0 }, { label: "15-30s", max: 30000, count: 0 }, { label: "30-60s", max: 60000, count: 0 }, { label: ">60s", max: Infinity, count: 0 }];
  for (var h = 0; h < allLatencies.length; h++) { for (var b = 0; b < buckets.length; b++) { if (allLatencies[h] < buckets[b].max) { buckets[b].count++; break; } } }
  console.log("\nHistogram:");
  var maxC = Math.max.apply(null, buckets.map(function (b) { return b.count; }));
  for (var hh = 0; hh < buckets.length; hh++) console.log("  " + buckets[hh].label.padEnd(12) + " " + String(buckets[hh].count).padStart(4) + " " + "#".repeat(Math.round(buckets[hh].count / Math.max(maxC, 1) * 30)));

  step(6, "SAVING RESULTS");
  var outPath = "C:/Users/arjagann/.copilot/session-state/8a86a63f-3963-430e-91a4-fbc9864c41c9/files/phase-9v2-round-" + round + ".json";
  fs.writeFileSync(outPath, JSON.stringify({ round: round, timestamp: new Date().toISOString(), questions: results.length, instant: instantCount, cached: cachedCount, model: modelCount, timeouts: timeoutCount, p50: percentile(allLatencies, 50), p90: percentile(allLatencies, 90), p99: percentile(allLatencies, 99) }, null, 2));
  console.log("Saved to " + outPath);
}

run().catch(function (e) { console.error("Fatal:", e); process.exit(1); });
