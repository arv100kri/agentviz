import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

var CLI_PATH = path.resolve("bin/agentviz.js");

var COPILOT_JSONL = [
  '{"type":"session.start","data":{"sessionId":"s1","producer":"copilot-agent"},"timestamp":"2026-01-15T10:00:00.000Z"}',
  '{"type":"user.message","data":{"content":"Fix the bug"},"timestamp":"2026-01-15T10:00:01.000Z"}',
  '{"type":"assistant.turn_start","data":{"turnId":"0"},"timestamp":"2026-01-15T10:00:02.000Z"}',
  '{"type":"tool.execution_start","data":{"toolName":"grep","toolInput":{"pattern":"error"}},"timestamp":"2026-01-15T10:00:03.000Z"}',
  '{"type":"tool.execution_complete","data":{"toolName":"grep","isError":false},"timestamp":"2026-01-15T10:00:04.000Z"}',
  '{"type":"tool.execution_start","data":{"toolName":"view","toolInput":{"path":"src/utils.js"}},"timestamp":"2026-01-15T10:00:05.000Z"}',
  '{"type":"tool.execution_complete","data":{"toolName":"view","isError":false},"timestamp":"2026-01-15T10:00:06.000Z"}',
  '{"type":"assistant.turn_end","data":{"model":"claude-sonnet-4","tokenUsage":{"inputTokens":5000,"outputTokens":2000}},"timestamp":"2026-01-15T10:00:10.000Z"}',
].join("\n") + "\n";

function runCli(args, opts) {
  return new Promise(function (resolve) {
    execFile("node", [CLI_PATH].concat(args), Object.assign({ timeout: 15000 }, opts), function (err, stdout, stderr) {
      resolve({
        code: err && err.code != null ? err.code : 0,
        stdout: stdout || "",
        stderr: stderr || "",
      });
    });
  });
}

describe("CLI combined flags", function () {
  var tmpDir;

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentviz-combined-"));
  });

  afterEach(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--digest + --stats produces both markdown file and JSON stdout", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var digestOut = path.join(tmpDir, "digest.md");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli(["--digest", "--stats", inputFile, "-o", digestOut]);
    expect(result.code).toBe(0);

    // Stats JSON on stdout
    var lines = result.stdout.split("\n");
    var jsonStart = lines.findIndex(function (l) { return l.trim().startsWith("{"); });
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    var jsonStr = lines.slice(jsonStart).join("\n").split("Digest:")[0];
    var stats = JSON.parse(jsonStr);
    expect(stats.totalTurns).toBe(1);

    // Digest file written
    expect(fs.existsSync(digestOut)).toBe(true);
    var md = fs.readFileSync(digestOut, "utf8");
    expect(md).toContain("## Queries & Commands");
  });

  it("--export + --stats produces both HTML file and JSON stdout", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var htmlOut = path.join(tmpDir, "out.html");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli(["--export", "--stats", inputFile, "-o", htmlOut]);
    expect(result.code).toBe(0);

    // Stats JSON on stdout
    expect(result.stdout).toContain('"totalTurns"');
    // HTML file written
    expect(fs.existsSync(htmlOut)).toBe(true);
    var html = fs.readFileSync(htmlOut, "utf8");
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("--export + --digest + --stats produces all three outputs", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var htmlOut = path.join(tmpDir, "out.html");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    // -o applies to export; digest uses default filename
    var result = await runCli(["--export", "--digest", "--stats", inputFile, "-o", htmlOut], { cwd: tmpDir });
    expect(result.code).toBe(0);

    // Stats JSON on stdout
    expect(result.stdout).toContain('"totalTurns"');

    // HTML export written
    expect(fs.existsSync(htmlOut)).toBe(true);

    // Digest written with default name
    expect(result.stdout).toContain("Digest:");
  });

  it("errors when no session file is provided with combined flags", async function () {
    var result = await runCli(["--stats", "--digest"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("requires a session file path");
  });

  it("--stats alone still works (backward compat)", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli(["--stats", inputFile]);
    expect(result.code).toBe(0);
    var stats = JSON.parse(result.stdout);
    expect(stats.totalTurns).toBe(1);
  });

  it("--digest alone still works (backward compat)", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var outFile = path.join(tmpDir, "out.md");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli(["--digest", inputFile, "-o", outFile]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(outFile)).toBe(true);
  });
});
