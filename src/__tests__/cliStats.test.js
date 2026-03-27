import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

var CLI_PATH = path.resolve("bin/agentviz.js");

// Copilot CLI format session with tools, errors, token usage
var COPILOT_JSONL = [
  '{"type":"session.start","data":{"sessionId":"s1","producer":"copilot-agent"},"timestamp":"2026-01-15T10:00:00.000Z"}',
  '{"type":"user.message","data":{"content":"Fix the bug in utils.js"},"timestamp":"2026-01-15T10:00:01.000Z"}',
  '{"type":"assistant.turn_start","data":{"turnId":"0"},"timestamp":"2026-01-15T10:00:02.000Z"}',
  '{"type":"tool.execution_start","data":{"toolName":"grep","toolInput":{"pattern":"bug"}},"timestamp":"2026-01-15T10:00:03.000Z"}',
  '{"type":"tool.execution_complete","data":{"toolName":"grep","isError":false},"timestamp":"2026-01-15T10:00:04.000Z"}',
  '{"type":"tool.execution_start","data":{"toolName":"view","toolInput":{"path":"utils.js"}},"timestamp":"2026-01-15T10:00:05.000Z"}',
  '{"type":"tool.execution_complete","data":{"toolName":"view","isError":false},"timestamp":"2026-01-15T10:00:06.000Z"}',
  '{"type":"tool.execution_start","data":{"toolName":"edit","toolInput":{"path":"utils.js"}},"timestamp":"2026-01-15T10:00:07.000Z"}',
  '{"type":"tool.execution_complete","data":{"toolName":"edit","isError":false},"timestamp":"2026-01-15T10:00:08.000Z"}',
  '{"type":"tool.execution_start","data":{"toolName":"grep","toolInput":{"pattern":"error"}},"timestamp":"2026-01-15T10:00:09.000Z"}',
  '{"type":"tool.execution_complete","data":{"toolName":"grep","isError":true},"timestamp":"2026-01-15T10:00:10.000Z"}',
  '{"type":"assistant.turn_end","data":{"model":"claude-sonnet-4","tokenUsage":{"inputTokens":5000,"outputTokens":2000,"cacheRead":1000,"cacheWrite":500}},"timestamp":"2026-01-15T10:00:11.000Z"}',
  '{"type":"user.message","data":{"content":"Also fix the tests"},"timestamp":"2026-01-15T10:00:20.000Z"}',
  '{"type":"assistant.turn_start","data":{"turnId":"1"},"timestamp":"2026-01-15T10:00:21.000Z"}',
  '{"type":"tool.execution_start","data":{"toolName":"grep","toolInput":{"pattern":"test"}},"timestamp":"2026-01-15T10:00:22.000Z"}',
  '{"type":"tool.execution_complete","data":{"toolName":"grep","isError":false},"timestamp":"2026-01-15T10:00:23.000Z"}',
  '{"type":"assistant.turn_end","data":{"model":"claude-sonnet-4","tokenUsage":{"inputTokens":3000,"outputTokens":1500}},"timestamp":"2026-01-15T10:00:30.000Z"}',
].join("\n") + "\n";

// Claude Code format session
var CLAUDE_JSONL = [
  '{"type":"human","timestamp":"2026-01-15T10:00:00.000Z","message":{"content":"Fix the bug"}}',
  '{"type":"assistant","timestamp":"2026-01-15T10:00:05.000Z","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"tool_use","name":"Read","input":{"path":"file.js"}},{"type":"tool_use","name":"Write","input":{"path":"file.js"}}],"usage":{"input_tokens":4000,"output_tokens":1800}}}',
  '{"type":"tool_result","timestamp":"2026-01-15T10:00:10.000Z","is_error":false}',
  '{"type":"tool_result","timestamp":"2026-01-15T10:00:11.000Z","is_error":true}',
  '{"type":"human","timestamp":"2026-01-15T10:00:20.000Z","message":{"content":"Check the output"}}',
  '{"type":"assistant","timestamp":"2026-01-15T10:00:25.000Z","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"Done"}],"usage":{"input_tokens":2000,"output_tokens":500}}}',
].join("\n") + "\n";

function runCli(args) {
  return new Promise(function (resolve) {
    execFile("node", [CLI_PATH].concat(args), { timeout: 15000 }, function (err, stdout, stderr) {
      resolve({
        code: err && err.code != null ? err.code : 0,
        stdout: stdout || "",
        stderr: stderr || "",
      });
    });
  });
}

describe("CLI --stats", function () {
  var tmpDir;

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentviz-stats-"));
  });

  afterEach(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- Argument validation --

  it("exits with error when --stats is used without a session file", async function () {
    var result = await runCli(["--stats"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--stats requires a session file path");
  });

  it("exits with error when the session file does not exist", async function () {
    var result = await runCli(["--stats", path.join(tmpDir, "nonexistent.jsonl")]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("path not found");
  });

  // -- Copilot CLI format --

  it("emits valid JSON to stdout for a Copilot CLI session", async function () {
    var inputFile = path.join(tmpDir, "copilot.jsonl");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli(["--stats", inputFile]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");

    var stats = JSON.parse(result.stdout);
    expect(stats).toBeDefined();
    expect(typeof stats.autonomyEfficiency).toBe("number");
  });

  it("counts turns, tool calls, and errors correctly for Copilot CLI", async function () {
    var inputFile = path.join(tmpDir, "copilot.jsonl");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli(["--stats", inputFile]);
    var stats = JSON.parse(result.stdout);

    expect(stats.totalTurns).toBe(2);
    expect(stats.totalToolCalls).toBe(5);
    expect(stats.errorCount).toBe(1);
  });

  it("contains all expected keys in the output", async function () {
    var inputFile = path.join(tmpDir, "copilot.jsonl");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli(["--stats", inputFile]);
    var stats = JSON.parse(result.stdout);

    var expectedKeys = [
      "autonomyEfficiency", "errorCount", "totalTurns", "totalToolCalls",
      "tokenUsage", "totalCost", "topTools", "interventionCount", "duration"
    ];
    for (var k of expectedKeys) {
      expect(stats).toHaveProperty(k);
    }
  });

  it("sorts topTools by frequency descending", async function () {
    var inputFile = path.join(tmpDir, "copilot.jsonl");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli(["--stats", inputFile]);
    var stats = JSON.parse(result.stdout);

    // grep appears 3 times, view 1, edit 1
    expect(stats.topTools[0][0]).toBe("grep");
    expect(stats.topTools[0][1]).toBe(3);
    for (var i = 1; i < stats.topTools.length; i++) {
      expect(stats.topTools[i][1]).toBeLessThanOrEqual(stats.topTools[i - 1][1]);
    }
  });

  it("sums token usage across all turns", async function () {
    var inputFile = path.join(tmpDir, "copilot.jsonl");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli(["--stats", inputFile]);
    var stats = JSON.parse(result.stdout);

    // Turn 1: 5000 input, 2000 output. Turn 2: 3000 input, 1500 output
    expect(stats.tokenUsage.input).toBe(8000);
    expect(stats.tokenUsage.output).toBe(3500);
  });

  it("calculates duration from first to last timestamp", async function () {
    var inputFile = path.join(tmpDir, "copilot.jsonl");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli(["--stats", inputFile]);
    var stats = JSON.parse(result.stdout);

    // First: 10:00:00, Last: 10:00:30 = 30 seconds
    expect(stats.duration).toBe(30);
  });

  it("counts interventions as user messages minus the initial prompt", async function () {
    var inputFile = path.join(tmpDir, "copilot.jsonl");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli(["--stats", inputFile]);
    var stats = JSON.parse(result.stdout);

    // 2 user.message events, minus 1 for initial prompt = 1 intervention
    expect(stats.interventionCount).toBe(1);
  });

  // -- Claude Code format --

  it("parses Claude Code format sessions correctly", async function () {
    var inputFile = path.join(tmpDir, "claude.jsonl");
    fs.writeFileSync(inputFile, CLAUDE_JSONL);

    var result = await runCli(["--stats", inputFile]);
    expect(result.code).toBe(0);

    var stats = JSON.parse(result.stdout);
    expect(stats.totalTurns).toBe(2); // 2 human messages = 2 turns
    expect(stats.totalToolCalls).toBe(2); // Read + Write
    expect(stats.errorCount).toBe(1); // 1 error tool_result
    expect(stats.tokenUsage.input).toBe(6000); // 4000 + 2000
    expect(stats.tokenUsage.output).toBe(2300); // 1800 + 500
  });

  // -- Directory input --

  it("accepts a directory and picks the latest .jsonl file", async function () {
    var older = path.join(tmpDir, "older.jsonl");
    var newer = path.join(tmpDir, "newer.jsonl");
    fs.writeFileSync(older, COPILOT_JSONL);
    fs.writeFileSync(newer, COPILOT_JSONL);
    var futureTime = Date.now() + 2000;
    fs.utimesSync(newer, new Date(futureTime), new Date(futureTime));

    var result = await runCli(["--stats", tmpDir]);
    expect(result.code).toBe(0);

    var stats = JSON.parse(result.stdout);
    expect(stats.totalTurns).toBe(2);
  });

  // -- Does NOT require dist/ --

  it("does not require dist/ to exist (unlike --export)", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    // --stats should work regardless of dist/ state
    var result = await runCli(["--stats", inputFile]);
    expect(result.code).toBe(0);
  });

  // -- Edge cases --

  it("handles an empty session gracefully", async function () {
    var inputFile = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(inputFile, "");

    var result = await runCli(["--stats", inputFile]);
    expect(result.code).toBe(0);

    var stats = JSON.parse(result.stdout);
    expect(stats.totalTurns).toBe(0);
    expect(stats.totalToolCalls).toBe(0);
    expect(stats.errorCount).toBe(0);
    expect(stats.duration).toBe(0);
    expect(stats.topTools).toEqual([]);
  });

  it("handles malformed JSON lines by skipping them", async function () {
    var malformedJsonl = [
      '{"type":"session.start","data":{"producer":"copilot-agent"},"timestamp":"2026-01-15T10:00:00.000Z"}',
      'this is not json',
      '{"type":"assistant.turn_start","data":{"turnId":"0"},"timestamp":"2026-01-15T10:00:01.000Z"}',
    ].join("\n") + "\n";

    var inputFile = path.join(tmpDir, "malformed.jsonl");
    fs.writeFileSync(inputFile, malformedJsonl);

    var result = await runCli(["--stats", inputFile]);
    expect(result.code).toBe(0);

    var stats = JSON.parse(result.stdout);
    expect(stats.totalTurns).toBe(1);
  });

  // -- Argument order --

  it("accepts --stats and session file in any order", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli([inputFile, "--stats"]);
    expect(result.code).toBe(0);

    var stats = JSON.parse(result.stdout);
    expect(stats.totalTurns).toBe(2);
  });
});
