import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

var CLI_PATH = path.resolve("bin/agentviz.js");

var SAMPLE_JSONL =
  '{"type":"session.start","data":{"sessionId":"test-001"},"timestamp":"2026-01-15T10:00:00.000Z"}\n' +
  '{"type":"user.message","data":{"content":"hello"},"timestamp":"2026-01-15T10:00:01.000Z"}\n';

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

describe("CLI --export", function () {
  var tmpDir;

  beforeEach(function () {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentviz-test-"));
  });

  afterEach(function () {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // -- Argument validation --

  it("exits with error when --export is used without a session file", async function () {
    var result = await runCli(["--export"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--export requires a session file path");
  });

  it("exits with error when the session file does not exist", async function () {
    var result = await runCli(["--export", path.join(tmpDir, "nonexistent.jsonl")]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("path not found");
  });

  it("exits with error when a directory has no .jsonl files", async function () {
    var emptyDir = path.join(tmpDir, "empty");
    fs.mkdirSync(emptyDir);
    var result = await runCli(["--export", emptyDir]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("no .jsonl files found");
  });

  // -- Successful export --

  it("exports a self-contained HTML file from a .jsonl input", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var outFile = path.join(tmpDir, "session-agentviz.html");
    fs.writeFileSync(inputFile, SAMPLE_JSONL);

    var result = await runCli(["--export", inputFile, "-o", outFile]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Exported:");
    expect(result.stdout).toContain("MB");
    expect(fs.existsSync(outFile)).toBe(true);

    var html = fs.readFileSync(outFile, "utf8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<div id="root"></div>');
  });

  it("embeds session data inside a fetch-intercepting script", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var outFile = path.join(tmpDir, "out.html");
    fs.writeFileSync(inputFile, SAMPLE_JSONL);

    await runCli(["--export", inputFile, "-o", outFile]);
    var html = fs.readFileSync(outFile, "utf8");

    // The fetch mock must intercept /api/meta and /api/file
    expect(html).toContain("/api/meta");
    expect(html).toContain("/api/file");
    // Session data should be embedded (escaped)
    expect(html).toContain("session.start");
    expect(html).toContain("user.message");
  });

  it("sets the title to 'AGENTVIZ - <filename>'", async function () {
    var inputFile = path.join(tmpDir, "my-session.jsonl");
    var outFile = path.join(tmpDir, "out.html");
    fs.writeFileSync(inputFile, SAMPLE_JSONL);

    await runCli(["--export", inputFile, "-o", outFile]);
    var html = fs.readFileSync(outFile, "utf8");

    expect(html).toContain("<title>AGENTVIZ - my-session.jsonl</title>");
  });

  it("includes inline styles and the production JS bundle", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var outFile = path.join(tmpDir, "out.html");
    fs.writeFileSync(inputFile, SAMPLE_JSONL);

    await runCli(["--export", inputFile, "-o", outFile]);
    var html = fs.readFileSync(outFile, "utf8");

    expect(html).toContain("<style>");
    expect(html).toContain("--av-bg-hover");
    expect(html).toContain("JetBrains Mono");
    // Bundle is embedded as a module script
    expect(html).toContain('<script type="module">');
  });

  // -- Output path handling --

  it("respects -o to write to a custom output path", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var customOut = path.join(tmpDir, "custom-dir", "report.html");
    fs.mkdirSync(path.join(tmpDir, "custom-dir"));
    fs.writeFileSync(inputFile, SAMPLE_JSONL);

    var result = await runCli(["--export", inputFile, "-o", customOut]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(customOut)).toBe(true);
    expect(result.stdout).toContain("report.html");
  });

  it("respects --output as an alias for -o", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var customOut = path.join(tmpDir, "aliased.html");
    fs.writeFileSync(inputFile, SAMPLE_JSONL);

    var result = await runCli(["--export", inputFile, "--output", customOut]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(customOut)).toBe(true);
  });

  it("defaults output filename to <session>-agentviz.html when -o is omitted", async function () {
    var inputFile = path.join(tmpDir, "my-session.jsonl");
    fs.writeFileSync(inputFile, SAMPLE_JSONL);

    // Run from tmpDir so the default output lands there
    var result = await new Promise(function (resolve) {
      execFile("node", [CLI_PATH, "--export", inputFile], {
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
    var defaultOut = path.join(tmpDir, "my-session-agentviz.html");
    expect(fs.existsSync(defaultOut)).toBe(true);
  });

  // -- Directory input --

  it("finds the latest .jsonl in a directory", async function () {
    var older = path.join(tmpDir, "older.jsonl");
    var newer = path.join(tmpDir, "newer.jsonl");
    fs.writeFileSync(older, SAMPLE_JSONL);
    // Give a slight mtime gap
    var futureTime = Date.now() + 2000;
    fs.writeFileSync(newer, SAMPLE_JSONL);
    fs.utimesSync(newer, new Date(futureTime), new Date(futureTime));

    var outFile = path.join(tmpDir, "dir-out.html");
    var result = await runCli(["--export", tmpDir, "-o", outFile]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(outFile)).toBe(true);

    var html = fs.readFileSync(outFile, "utf8");
    // Title should reflect the newer file
    expect(html).toContain("<title>AGENTVIZ - newer.jsonl</title>");
  });

  // -- XSS safety --

  it("escapes HTML-unsafe characters in embedded session data", async function () {
    var maliciousJsonl =
      '{"type":"user.message","data":{"content":"<script>alert(1)</script>&foo"}}\n';
    var inputFile = path.join(tmpDir, "xss.jsonl");
    var outFile = path.join(tmpDir, "xss-out.html");
    fs.writeFileSync(inputFile, maliciousJsonl);

    await runCli(["--export", inputFile, "-o", outFile]);
    var html = fs.readFileSync(outFile, "utf8");

    // The raw <script> must NOT appear unescaped inside the data payload.
    // jsonSafe replaces < with \u003c and > with \u003e
    expect(html).not.toMatch(/<script>alert\(1\)<\/script>/);
    expect(html).toContain("\\u003cscript\\u003e");
  });

  it("escapes the filename in the HTML title attribute", async function () {
    // Filenames with special chars should be escaped in the <title>
    var safeName = 'session"test.jsonl';
    // Windows doesn't allow " in filenames, so test with &
    var inputFile = path.join(tmpDir, "session&test.jsonl");
    var outFile = path.join(tmpDir, "out.html");
    fs.writeFileSync(inputFile, SAMPLE_JSONL);

    await runCli(["--export", inputFile, "-o", outFile]);
    var html = fs.readFileSync(outFile, "utf8");

    // The & in the filename should be escaped as &amp; in the title
    expect(html).toContain("AGENTVIZ - session&amp;test.jsonl");
  });

  // -- Argument order flexibility --

  it("accepts --export and session file in any order", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var outFile = path.join(tmpDir, "out.html");
    fs.writeFileSync(inputFile, SAMPLE_JSONL);

    // session file BEFORE --export
    var result = await runCli([inputFile, "--export", "-o", outFile]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(outFile)).toBe(true);
  });

  it("accepts -o before the session file", async function () {
    var inputFile = path.join(tmpDir, "session.jsonl");
    var outFile = path.join(tmpDir, "out.html");
    fs.writeFileSync(inputFile, SAMPLE_JSONL);

    var result = await runCli(["--export", "-o", outFile, inputFile]);
    expect(result.code).toBe(0);
    expect(fs.existsSync(outFile)).toBe(true);
  });
});
