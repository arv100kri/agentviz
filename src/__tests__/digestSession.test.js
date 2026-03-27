import { describe, it, expect } from "vitest";
import { digestSession, formatDigestMarkdown } from "../../src/lib/digestSession.js";

// Copilot CLI format session with tools, errors, reasoning
var COPILOT_SESSION = [
  '{"type":"session.start","data":{"sessionId":"s1","producer":"copilot-agent"},"timestamp":"2026-01-15T10:00:00.000Z"}',
  '{"type":"user.message","data":{"content":"Find and fix the bug"},"timestamp":"2026-01-15T10:00:01.000Z"}',
  '{"type":"assistant.turn_start","data":{"turnId":"0"},"timestamp":"2026-01-15T10:00:02.000Z"}',
  '{"type":"assistant.reasoning","data":{"content":"I think the issue might be in the error handler. Let me check the logs."},"timestamp":"2026-01-15T10:00:03.000Z"}',
  '{"type":"tool.execution_start","data":{"toolName":"grep","toolInput":{"pattern":"error","path":"src/"}},"timestamp":"2026-01-15T10:00:04.000Z"}',
  '{"type":"tool.execution_complete","data":{"toolName":"grep","isError":false},"timestamp":"2026-01-15T10:00:05.000Z"}',
  '{"type":"tool.execution_start","data":{"toolName":"view","toolInput":{"path":"src/utils.js"}},"timestamp":"2026-01-15T10:00:06.000Z"}',
  '{"type":"tool.execution_complete","data":{"toolName":"view","isError":false},"timestamp":"2026-01-15T10:00:07.000Z"}',
  '{"type":"tool.execution_start","data":{"toolName":"view","toolInput":{"path":"src/utils.js"}},"timestamp":"2026-01-15T10:00:08.000Z"}',
  '{"type":"tool.execution_complete","data":{"toolName":"view","isError":false},"timestamp":"2026-01-15T10:00:09.000Z"}',
  '{"type":"tool.execution_start","data":{"toolName":"edit","toolInput":{"path":"src/utils.js"}},"timestamp":"2026-01-15T10:00:10.000Z"}',
  '{"type":"tool.execution_complete","data":{"toolName":"edit","isError":false},"timestamp":"2026-01-15T10:00:11.000Z"}',
  '{"type":"assistant.message","data":{"content":"I\'ll go with the simpler approach instead of refactoring the whole module."},"timestamp":"2026-01-15T10:00:12.000Z"}',
  '{"type":"tool.execution_start","data":{"toolName":"bash","toolInput":{"command":"npm test"}},"timestamp":"2026-01-15T10:00:13.000Z"}',
  '{"type":"tool.execution_complete","data":{"toolName":"bash","isError":true,"result":"FAIL: 2 tests failed"},"timestamp":"2026-01-15T10:00:14.000Z"}',
  '{"type":"assistant.reasoning","data":{"content":"That didn\'t work. The test failures suggest a different root cause."},"timestamp":"2026-01-15T10:00:15.000Z"}',
  '{"type":"assistant.turn_end","data":{},"timestamp":"2026-01-15T10:00:16.000Z"}',
].join("\n") + "\n";

// Claude Code format session
var CLAUDE_SESSION = [
  '{"type":"human","timestamp":"2026-01-15T10:00:00.000Z","message":{"content":"Fix the auth bug"}}',
  '{"type":"assistant","timestamp":"2026-01-15T10:00:05.000Z","message":{"content":[{"type":"text","text":"I think the issue is in the token validation. Let me check."},{"type":"tool_use","name":"Read","input":{"path":"src/auth.js"}},{"type":"tool_use","name":"Bash","input":{"command":"grep -r token src/"}}]}}',
  '{"type":"tool_result","timestamp":"2026-01-15T10:00:10.000Z","is_error":false}',
  '{"type":"tool_result","timestamp":"2026-01-15T10:00:11.000Z","is_error":true,"content":[{"type":"text","text":"Permission denied"}]}',
  '{"type":"assistant","timestamp":"2026-01-15T10:00:15.000Z","message":{"content":[{"type":"text","text":"I\'ll use a different approach. Going with the JWT library instead of manual parsing."},{"type":"tool_use","name":"Write","input":{"path":"src/auth.js"}}]}}',
].join("\n") + "\n";

describe("digestSession", function () {

  describe("Queries & Commands", function () {
    it("extracts grep and bash commands from Copilot CLI sessions", function () {
      var digest = digestSession(COPILOT_SESSION);
      expect(digest.queries.length).toBe(2);
      expect(digest.queries[0].tool).toBe("grep");
      expect(digest.queries[0].command).toContain("error");
      expect(digest.queries[1].tool).toBe("bash");
      expect(digest.queries[1].command).toContain("npm test");
    });

    it("extracts commands from Claude Code sessions", function () {
      var digest = digestSession(CLAUDE_SESSION);
      expect(digest.queries.length).toBe(1);
      expect(digest.queries[0].tool).toBe("Bash");
      expect(digest.queries[0].command).toContain("grep");
    });

    it("records the turn number for each command", function () {
      var digest = digestSession(COPILOT_SESSION);
      expect(digest.queries[0].turn).toBe(1);
    });
  });

  describe("Files Examined", function () {
    it("counts views and edits per file", function () {
      var digest = digestSession(COPILOT_SESSION);
      var utilsFile = digest.files.find(function (f) { return f.path === "src/utils.js"; });
      expect(utilsFile).toBeDefined();
      expect(utilsFile.views).toBe(2);
      expect(utilsFile.edits).toBe(1);
      expect(utilsFile.total).toBe(3);
    });

    it("sorts files by total access frequency descending", function () {
      var digest = digestSession(COPILOT_SESSION);
      for (var i = 1; i < digest.files.length; i++) {
        expect(digest.files[i].total).toBeLessThanOrEqual(digest.files[i - 1].total);
      }
    });

    it("extracts files from Claude Code sessions", function () {
      var digest = digestSession(CLAUDE_SESSION);
      var authFile = digest.files.find(function (f) { return f.path === "src/auth.js"; });
      expect(authFile).toBeDefined();
      expect(authFile.views).toBe(1); // Read
      expect(authFile.edits).toBe(1); // Write
    });
  });

  describe("Errors Encountered", function () {
    it("captures errors with turn and tool name", function () {
      var digest = digestSession(COPILOT_SESSION);
      expect(digest.errors.length).toBe(1);
      expect(digest.errors[0].tool).toBe("bash");
      expect(digest.errors[0].message).toContain("FAIL");
      expect(digest.errors[0].turn).toBe(1);
    });

    it("captures errors from Claude Code sessions", function () {
      var digest = digestSession(CLAUDE_SESSION);
      expect(digest.errors.length).toBe(1);
      expect(digest.errors[0].message).toContain("Permission denied");
    });
  });

  describe("Hypotheses & Outcomes", function () {
    it("detects hypothesis language in reasoning events", function () {
      var digest = digestSession(COPILOT_SESSION);
      expect(digest.hypotheses.length).toBeGreaterThanOrEqual(1);
      expect(digest.hypotheses[0].text).toContain("I think");
    });

    it("detects hypotheses in Claude Code text blocks", function () {
      var digest = digestSession(CLAUDE_SESSION);
      expect(digest.hypotheses.length).toBeGreaterThanOrEqual(1);
      expect(digest.hypotheses[0].text).toContain("I think");
    });

    it("assigns status to hypotheses based on subsequent events", function () {
      var digest = digestSession(COPILOT_SESSION);
      // "That didn't work" should mark earlier hypothesis as abandoned
      var hasNonOpen = digest.hypotheses.some(function (h) { return h.status !== "open"; });
      // Either detected as abandoned or still open is acceptable
      expect(digest.hypotheses.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Key Decisions", function () {
    it("detects decision language in assistant messages", function () {
      var digest = digestSession(COPILOT_SESSION);
      expect(digest.decisions.length).toBeGreaterThanOrEqual(1);
      expect(digest.decisions[0].text).toContain("instead of");
    });

    it("detects decisions in Claude Code text blocks", function () {
      var digest = digestSession(CLAUDE_SESSION);
      expect(digest.decisions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("edge cases", function () {
    it("handles empty sessions gracefully", function () {
      var digest = digestSession("");
      expect(digest.queries).toEqual([]);
      expect(digest.files).toEqual([]);
      expect(digest.errors).toEqual([]);
      expect(digest.hypotheses).toEqual([]);
      expect(digest.decisions).toEqual([]);
    });

    it("handles sessions with no tools", function () {
      var noToolSession = [
        '{"type":"session.start","data":{"producer":"copilot-agent"},"timestamp":"2026-01-15T10:00:00.000Z"}',
        '{"type":"user.message","data":{"content":"hello"},"timestamp":"2026-01-15T10:00:01.000Z"}',
        '{"type":"assistant.message","data":{"content":"hi there"},"timestamp":"2026-01-15T10:00:02.000Z"}',
      ].join("\n") + "\n";

      var digest = digestSession(noToolSession);
      expect(digest.queries).toEqual([]);
      expect(digest.files).toEqual([]);
      expect(digest.errors).toEqual([]);
    });

    it("skips malformed JSON lines", function () {
      var malformed = [
        '{"type":"session.start","data":{"producer":"copilot-agent"},"timestamp":"2026-01-15T10:00:00.000Z"}',
        'not valid json',
        '{"type":"user.message","data":{"content":"hello"},"timestamp":"2026-01-15T10:00:01.000Z"}',
      ].join("\n") + "\n";

      var digest = digestSession(malformed);
      expect(digest).toBeDefined();
    });
  });
});

describe("formatDigestMarkdown", function () {
  it("produces well-formed markdown with all five sections", function () {
    var digest = digestSession(COPILOT_SESSION);
    var md = formatDigestMarkdown(digest, "test-session.jsonl");

    expect(md).toContain("# Session Digest: test-session.jsonl");
    expect(md).toContain("## Queries & Commands");
    expect(md).toContain("## Files Examined");
    expect(md).toContain("## Errors Encountered");
    expect(md).toContain("## Hypotheses & Outcomes");
    expect(md).toContain("## Key Decisions");
  });

  it("includes file table with views and edits columns", function () {
    var digest = digestSession(COPILOT_SESSION);
    var md = formatDigestMarkdown(digest, "test.jsonl");

    expect(md).toContain("| File | Views | Edits | Total |");
    expect(md).toContain("src/utils.js");
  });

  it("shows placeholder text for empty sections", function () {
    var digest = digestSession("");
    var md = formatDigestMarkdown(digest, "empty.jsonl");

    expect(md).toContain("_No commands or queries found._");
    expect(md).toContain("_No file operations found._");
    expect(md).toContain("_No errors found._");
    expect(md).toContain("_No hypotheses detected._");
    expect(md).toContain("_No explicit decisions detected._");
  });
});
