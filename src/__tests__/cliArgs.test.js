import { describe, expect, it } from "vitest";
import { formatCliHelp, parseCliArgs, resolveCliExecution } from "../lib/cliArgs.js";

describe("cliArgs", function () {
  it("parses plain launch mode with a session path", function () {
    var parsed = parseCliArgs(["trace.jsonl"]);
    expect(parsed.sessionPath).toBe("trace.jsonl");
    expect(parsed.digest).toBe(false);
    expect(parsed.stats).toBe(false);
  });

  it("parses combined analysis flags", function () {
    var parsed = parseCliArgs(["--digest", "trace.jsonl", "-o", "digest.md", "--stats"]);
    expect(parsed.digest).toBe(true);
    expect(parsed.stats).toBe(true);
    expect(parsed.outputPath).toBe("digest.md");
    expect(parsed.sessionPath).toBe("trace.jsonl");
  });

  it("lets help bypass analysis path validation", function () {
    var parsed = parseCliArgs(["--help", "--stats"]);
    expect(parsed.help).toBe(true);
  });

  it("rejects unknown flags", function () {
    expect(function () {
      parseCliArgs(["--wat"]);
    }).toThrow("Unknown option");
  });

  it("rejects --output without --digest", function () {
    expect(function () {
      parseCliArgs(["trace.jsonl", "--output", "digest.md"]);
    }).toThrow("--output requires --digest");
  });

  it("requires a session path for analysis modes", function () {
    expect(function () {
      parseCliArgs(["--stats"]);
    }).toThrow("session path is required");
  });

  it("resolves analysis mode without launching the browser", function () {
    var execution = resolveCliExecution(parseCliArgs(["--stats", "trace.jsonl"]));
    expect(execution.analysisMode).toBe(true);
    expect(execution.launchesApp).toBe(false);
    expect(execution.opensBrowser).toBe(false);
  });

  it("keeps browser launch behavior for plain mode", function () {
    var execution = resolveCliExecution(parseCliArgs(["trace.jsonl"]));
    expect(execution.analysisMode).toBe(false);
    expect(execution.launchesApp).toBe(true);
    expect(execution.opensBrowser).toBe(true);
  });

  it("renders help text with the new flags", function () {
    var help = formatCliHelp();
    expect(help).toContain("--digest");
    expect(help).toContain("--stats");
    expect(help).toContain("session-digest.md");
  });
});
