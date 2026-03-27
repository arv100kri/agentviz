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
  '{"type":"assistant.turn_end","data":{},"timestamp":"2026-01-15T10:00:07.000Z"}',
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

describe("CLI --digest", function () {
  var tmpDir;

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentviz-digest-"));
  });

  afterEach(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- Argument validation --

  it("exits with error when --digest is used without a session file", async function () {
    var result = await runCli(["--digest"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--digest requires a session file path");
  });

  it("exits with error when the session file does not exist", async function () {
    var result = await runCli(["--digest", path.join(tmpDir, "nonexistent.jsonl")]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("path not found");
  });

  // -- Successful digest --

  it("generates a markdown file from a JSONL session", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var outFile = path.join(tmpDir, "out.md");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli(["--digest", inputFile, "-o", outFile]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Digest:");
    expect(fs.existsSync(outFile)).toBe(true);

    var md = fs.readFileSync(outFile, "utf8");
    expect(md).toContain("# Session Digest:");
    expect(md).toContain("## Queries & Commands");
    expect(md).toContain("## Files Examined");
    expect(md).toContain("## Errors Encountered");
  });

  it("includes extracted data in the digest", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var outFile = path.join(tmpDir, "out.md");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    await runCli(["--digest", inputFile, "-o", outFile]);
    var md = fs.readFileSync(outFile, "utf8");

    // Should contain the grep command
    expect(md).toContain("grep");
    expect(md).toContain("error");
    // Should contain the viewed file
    expect(md).toContain("src/utils.js");
  });

  // -- Output path handling --

  it("defaults output filename to <session>-digest.md when -o is omitted", async function () {
    var inputFile = path.join(tmpDir, "my-session.jsonl");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await new Promise(function (resolve) {
      execFile("node", [CLI_PATH, "--digest", inputFile], {
        cwd: tmpDir,
        timeout: 15000,
      }, function (err, stdout, stderr) {
        resolve({
          code: err && err.code != null ? err.code : 0,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      });
    });

    expect(result.code).toBe(0);
    var defaultOut = path.join(tmpDir, "my-session-digest.md");
    expect(fs.existsSync(defaultOut)).toBe(true);
  });

  it("respects -o to write to a custom output path", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var customOut = path.join(tmpDir, "custom-dir", "report.md");
    fs.mkdirSync(path.join(tmpDir, "custom-dir"));
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli(["--digest", inputFile, "-o", customOut]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(customOut)).toBe(true);
  });

  it("respects --output as an alias for -o", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var customOut = path.join(tmpDir, "aliased.md");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli(["--digest", inputFile, "--output", customOut]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(customOut)).toBe(true);
  });

  // -- Directory input --

  it("accepts a directory and picks the latest .jsonl file", async function () {
    var older = path.join(tmpDir, "older.jsonl");
    var newer = path.join(tmpDir, "newer.jsonl");
    fs.writeFileSync(older, COPILOT_JSONL);
    fs.writeFileSync(newer, COPILOT_JSONL);
    var futureTime = Date.now() + 2000;
    fs.utimesSync(newer, new Date(futureTime), new Date(futureTime));

    var outFile = path.join(tmpDir, "out.md");
    var result = await runCli(["--digest", tmpDir, "-o", outFile]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(outFile)).toBe(true);
  });

  // -- Argument order --

  it("accepts --digest and session file in any order", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var outFile = path.join(tmpDir, "out.md");
    fs.writeFileSync(inputFile, COPILOT_JSONL);

    var result = await runCli([inputFile, "--digest", "-o", outFile]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(outFile)).toBe(true);
  });
});
