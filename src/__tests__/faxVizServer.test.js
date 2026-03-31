import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createFaxVizServer } from "../../fax-viz-server.js";

// Create a temporary fax directory with test bundles
var tmpDir;
var bundleDir;

beforeAll(function () {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fax-viz-test-"));

  // Bundle with events
  bundleDir = path.join(tmpDir, "fax-context-test-bundle-20260326-180423");
  fs.mkdirSync(bundleDir, { recursive: true });

  fs.writeFileSync(path.join(bundleDir, "manifest.json"), JSON.stringify({
    schemaVersion: "fax-context-bundle/v1",
    createdUtc: "2026-03-26T18:04:24Z",
    bundleLabel: "test-bundle",
    threadId: "thread-001",
    importance: "high",
    sourceRoot: "/tmp/repo",
    sender: {
      alias: "Test User",
      email: "test@example.com",
      program: "copilot-cli",
      sessionId: "session-001",
    },
    artifacts: ["manifest.json", "handoff.md", "analysis.md"],
    sharedArtifacts: [],
    git: { branch: "main", head: "abc123", statusEntries: 0 },
    progress: {
      stepsCompleted: [
        "Step one done",
        { step: "step-two", result: "completed", summary: "Object form step" },
      ],
      stepsRemaining: [
        { step: "step-three", priority: "high", summary: "Remaining work" },
      ],
    },
    doNotRetry: [
      "Simple string approach",
      { approach: "Object approach", reason: "It failed" },
    ],
    fileReservations: [],
  }));

  fs.writeFileSync(path.join(bundleDir, "handoff.md"), "# Handoff\n\nTest handoff content.");
  fs.writeFileSync(path.join(bundleDir, "analysis.md"), "# Analysis\n\nTest analysis.");
  fs.writeFileSync(path.join(bundleDir, "events.jsonl"), '{"type":"assistant","message":{"content":"hello"}}\n');
  fs.writeFileSync(path.join(bundleDir, "bootstrap-prompt.txt"), "You are continuing work on a fax bundle. Pick up where the sender left off.");

  // Bundle without events
  var noEventsDir = path.join(tmpDir, "fax-context-no-events-20260325-120000");
  fs.mkdirSync(noEventsDir, { recursive: true });
  fs.writeFileSync(path.join(noEventsDir, "manifest.json"), JSON.stringify({
    schemaVersion: "fax-context-bundle/v1",
    createdUtc: "2026-03-25T12:00:00Z",
    threadId: "thread-002",
    importance: "normal",
    sourceRoot: "/tmp/other",
    sender: { alias: "Other User", email: "other@example.com", program: "copilot-cli", sessionId: "session-002" },
    artifacts: ["manifest.json", "handoff.md"],
    sharedArtifacts: [],
  }));
  fs.writeFileSync(path.join(noEventsDir, "handoff.md"), "# Handoff\n\nNo events bundle.");

  // Bundle without fax-context- prefix (should still be discovered)
  var customNameDir = path.join(tmpDir, "my-custom-bundle");
  fs.mkdirSync(customNameDir, { recursive: true });
  fs.writeFileSync(path.join(customNameDir, "manifest.json"), JSON.stringify({
    schemaVersion: "fax-context-bundle/v1",
    createdUtc: "2026-03-24T10:00:00Z",
    bundleLabel: "Custom Bundle",
    threadId: "thread-003",
    importance: "urgent",
    sender: { alias: "Custom User", email: "custom@example.com", program: "copilot-cli", sessionId: "session-003" },
    artifacts: ["manifest.json"],
    sharedArtifacts: [],
  }));

  // Directory without manifest.json (should be ignored)
  fs.mkdirSync(path.join(tmpDir, "random-folder"), { recursive: true });
});

afterAll(function () {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("fax-viz-server", function () {
  describe("GET /api/faxes", function () {
    it("discovers fax bundles and returns sorted list", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/faxes");
      expect(response.status).toBe(200);
      var body = JSON.parse(response.body);
      expect(body.faxes).toHaveLength(3);
      // Sorted by date desc (newest first)
      expect(body.faxes[0].id).toBe("fax-context-test-bundle-20260326-180423");
      expect(body.faxes[1].id).toBe("fax-context-no-events-20260325-120000");
      expect(body.faxes[2].id).toBe("my-custom-bundle");
    });

    it("parses manifest fields correctly", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/faxes");
      var fax = JSON.parse(response.body).faxes[0];
      expect(fax.label).toBe("test-bundle");
      expect(fax.sender.alias).toBe("Test User");
      expect(fax.importance).toBe("high");
      expect(fax.threadId).toBe("thread-001");
      expect(fax.hasEvents).toBe(true);
      expect(fax.git.branch).toBe("main");
      expect(fax.progress.stepsCompleted).toHaveLength(2);
      expect(fax.progress.stepsRemaining).toHaveLength(1);
    });

    it("detects bundles without events.jsonl", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/faxes");
      var fax = JSON.parse(response.body).faxes[1];
      expect(fax.hasEvents).toBe(false);
      expect(fax.importance).toBe("normal");
    });

    it("ignores directories without manifest.json", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/faxes");
      var ids = JSON.parse(response.body).faxes.map(function (f) { return f.id; });
      expect(ids).not.toContain("random-folder");
    });

    it("discovers bundles without fax-context- prefix", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/faxes");
      var faxes = JSON.parse(response.body).faxes;
      var custom = faxes.find(function (f) { return f.id === "my-custom-bundle"; });
      expect(custom).toBeDefined();
      expect(custom.label).toBe("Custom Bundle");
      expect(custom.importance).toBe("urgent");
    });
  });

  describe("GET /api/fax/:id/events", function () {
    it("serves events.jsonl content", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/fax/fax-context-test-bundle-20260326-180423/events");
      expect(response.status).toBe(200);
      expect(response.body).toContain('"hello"');
    });

    it("returns 404 for bundles without events", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/fax/fax-context-no-events-20260325-120000/events");
      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/fax/:id/file/:name", function () {
    it("serves markdown files from bundle", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/fax/fax-context-test-bundle-20260326-180423/file/handoff.md");
      expect(response.status).toBe(200);
      expect(response.body).toContain("Test handoff content");
    });

    it("returns 404 for missing files", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/fax/fax-context-test-bundle-20260326-180423/file/nonexistent.md");
      expect(response.status).toBe(404);
    });
  });

  describe("GET /api/fax/:id/manifest", function () {
    it("returns manifest and markdown files", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/fax/fax-context-test-bundle-20260326-180423/manifest");
      expect(response.status).toBe(200);
      var body = JSON.parse(response.body);
      expect(body.manifest.bundleLabel).toBe("test-bundle");
      expect(body.markdownFiles).toBeInstanceOf(Array);
      expect(body.markdownFiles.length).toBeGreaterThanOrEqual(2);
      var handoff = body.markdownFiles.find(function (f) { return f.name === "handoff.md"; });
      expect(handoff.content).toContain("Test handoff content");
    });

    it("returns 404 for nonexistent bundle", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/fax/nonexistent-bundle-99999/manifest");
      expect(response.status).toBe(404);
      var body = JSON.parse(response.body);
      expect(body.error).toContain("not found");
    });

    it("blocks path traversal", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/fax/" + encodeURIComponent("../../etc") + "/manifest");
      expect(response.status).toBe(403);
    });

    it("returns 405 for POST requests", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "POST", "/api/fax/fax-context-test-bundle-20260326-180423/manifest");
      expect(response.status).toBe(405);
    });
  });

  describe("read status", function () {
    it("GET /api/fax-read-status returns empty initially", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/fax-read-status");
      expect(response.status).toBe(200);
    });

    it("POST /api/fax-read-status persists read state", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var postResponse = await makeRequest(server, "POST", "/api/fax-read-status", {
        folderName: "fax-context-test-bundle-20260326-180423",
        readAt: "2026-03-29T00:00:00Z",
      });
      expect(postResponse.status).toBe(200);
      expect(JSON.parse(postResponse.body).success).toBe(true);
    });
  });

  describe("directory traversal prevention", function () {
    it("blocks path traversal in /api/fax/:id/events", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/fax/" + encodeURIComponent("../../etc") + "/events");
      expect(response.status).toBe(403);
    });

    it("blocks path traversal in /api/fax/:id/file/:name", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/fax/fax-context-test-bundle-20260326-180423/file/" + encodeURIComponent("../../manifest.json"));
      expect(response.status).toBe(403);
    });
  });

  describe("POST /api/fax/:id/pickup", function () {
    it("returns bootstrap prompt and writes reply intent", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "POST", "/api/fax/fax-context-test-bundle-20260326-180423/pickup");
      expect(response.status).toBe(200);
      var body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.bootstrap).toContain("Pick up where the sender left off");

      // Verify reply intent was written to fax dir root
      var intentPath = path.join(tmpDir, ".fax-reply-intent.json");
      expect(fs.existsSync(intentPath)).toBe(true);
      var intent = JSON.parse(fs.readFileSync(intentPath, "utf8"));
      expect(intent.threadId).toBe("thread-001");
      expect(intent.parentFax).toBe("fax-context-test-bundle-20260326-180423");
      expect(intent.parentSender).toBe("Test User");
      expect(intent.pickedUpAt).toBeTruthy();

      // Clean up intent file
      fs.unlinkSync(intentPath);
    });

    it("returns 403 for path traversal attempts", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "POST", "/api/fax/" + encodeURIComponent("../../etc") + "/pickup");
      expect(response.status).toBe(403);
    });

    it("handles nonexistent bundle gracefully", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "POST", "/api/fax/nonexistent-bundle-99999/pickup");
      // Server returns 200 with empty bootstrap (no bootstrap-prompt.txt)
      // and writes a minimal reply intent
      expect(response.status).toBe(200);
      var body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.bootstrap).toBe("");

      // Clean up intent file
      var intentPath = path.join(tmpDir, ".fax-reply-intent.json");
      if (fs.existsSync(intentPath)) fs.unlinkSync(intentPath);
    });

    it("returns 405 for GET requests", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/fax/fax-context-test-bundle-20260326-180423/pickup");
      expect(response.status).toBe(405);
    });

    it("returns empty bootstrap when bootstrap-prompt.txt is missing", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      // Use the no-events bundle which has no bootstrap-prompt.txt
      var response = await makeRequest(server, "POST", "/api/fax/fax-context-no-events-20260325-120000/pickup");
      expect(response.status).toBe(200);
      var body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.bootstrap).toBe("");

      // Clean up intent file
      var intentPath = path.join(tmpDir, ".fax-reply-intent.json");
      if (fs.existsSync(intentPath)) fs.unlinkSync(intentPath);
    });
  });

  describe("GET /api/copilot-sessions", function () {
    var copilotTmpDir;
    var originalHome;
    var originalUserProfile;

    beforeAll(function () {
      // Save original env
      originalHome = process.env.HOME;
      originalUserProfile = process.env.USERPROFILE;

      // Create mock copilot session-state directory
      copilotTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fax-viz-copilot-test-"));
      var sessionStateDir = path.join(copilotTmpDir, ".copilot", "session-state");

      // Session 1: valid, large enough
      var session1Dir = path.join(sessionStateDir, "aaaaaaaa-1111-2222-3333-444444444444");
      fs.mkdirSync(session1Dir, { recursive: true });
      // Create events.jsonl > 5KB
      var largeContent = "";
      for (var j = 0; j < 200; j++) {
        largeContent += '{"type":"assistant","message":{"content":"line ' + j + ' padding data to make the file large enough"}}\n';
      }
      fs.writeFileSync(path.join(session1Dir, "events.jsonl"), largeContent);
      fs.writeFileSync(path.join(session1Dir, "workspace.yaml"), [
        "summary: Implemented auth flow",
        "repository: myorg/myrepo",
        "branch: feature/auth",
        "cwd: /home/user/projects/myrepo",
      ].join("\n"));

      // Session 2: too small (< 5KB), should be filtered
      var session2Dir = path.join(sessionStateDir, "bbbbbbbb-1111-2222-3333-444444444444");
      fs.mkdirSync(session2Dir, { recursive: true });
      fs.writeFileSync(path.join(session2Dir, "events.jsonl"), '{"small":true}\n');
      fs.writeFileSync(path.join(session2Dir, "workspace.yaml"), "summary: Tiny session\n");

      // Session 3: AGENTVIZ subprocess session, should be filtered
      var session3Dir = path.join(sessionStateDir, "cccccccc-1111-2222-3333-444444444444");
      fs.mkdirSync(session3Dir, { recursive: true });
      var subContent = "";
      for (var k = 0; k < 200; k++) {
        subContent += '{"type":"assistant","message":{"content":"analyzing session ' + k + '"}}\n';
      }
      fs.writeFileSync(path.join(session3Dir, "events.jsonl"), subContent);
      fs.writeFileSync(path.join(session3Dir, "workspace.yaml"), "summary: Analyze this coding session\n");

      // Point HOME/USERPROFILE to our temp dir
      process.env.HOME = copilotTmpDir;
      process.env.USERPROFILE = copilotTmpDir;
    });

    afterAll(function () {
      // Restore env
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (originalUserProfile !== undefined) process.env.USERPROFILE = originalUserProfile;
      else delete process.env.USERPROFILE;

      fs.rmSync(copilotTmpDir, { recursive: true, force: true });
    });

    it("discovers valid copilot sessions and filters small ones", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/copilot-sessions");
      expect(response.status).toBe(200);
      var body = JSON.parse(response.body);
      // Only session 1 should appear (session 2 is too small, session 3 is AGENTVIZ subprocess)
      expect(body.sessions).toHaveLength(1);
      expect(body.sessions[0].id).toBe("aaaaaaaa-1111-2222-3333-444444444444");
      expect(body.sessions[0].tool).toBe("copilot-cli");
      expect(body.sessions[0].summary).toBe("Implemented auth flow");
      expect(body.sessions[0].branch).toBe("feature/auth");
      expect(body.sessions[0].project).toBe("myrepo");
      expect(body.sessions[0].mtime).toBeTruthy();
    });
  });

  describe("POST /api/launch-session", function () {
    it("constructs copilot-cli new session command", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "POST", "/api/launch-session", {
        tool: "copilot-cli",
        mode: "new",
        prompt: "Fix the auth bug",
      });
      expect(response.status).toBe(200);
      var body = JSON.parse(response.body);
      expect(body.status).toBe("launched");
      expect(body.tool).toBe("copilot-cli");
    });

    it("constructs copilot-cli resume session command", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "POST", "/api/launch-session", {
        tool: "copilot-cli",
        mode: "resume",
        sessionId: "sess-123",
        prompt: "Continue work",
      });
      expect(response.status).toBe(200);
      var body = JSON.parse(response.body);
      expect(body.status).toBe("launched");
      expect(body.tool).toBe("copilot-cli");
    });

    it("constructs claude-code new session command", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "POST", "/api/launch-session", {
        tool: "claude-code",
        mode: "new",
        prompt: "Add logging",
      });
      expect(response.status).toBe(200);
      var body = JSON.parse(response.body);
      expect(body.status).toBe("launched");
      expect(body.tool).toBe("claude-code");
    });

    it("constructs claude-code resume session command", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "POST", "/api/launch-session", {
        tool: "claude-code",
        mode: "resume",
        sessionId: "sess-456",
        prompt: "Continue logging work",
      });
      expect(response.status).toBe(200);
      var body = JSON.parse(response.body);
      expect(body.status).toBe("launched");
      expect(body.tool).toBe("claude-code");
    });

    it("rejects missing tool/mode", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "POST", "/api/launch-session", {
        prompt: "Do something",
      });
      expect(response.status).toBe(400);
    });

    it("rejects unsupported tool/mode combination", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "POST", "/api/launch-session", {
        tool: "unknown-tool",
        mode: "new",
        prompt: "Do something",
      });
      expect(response.status).toBe(400);
    });

    it("rejects when only tool is provided without mode", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "POST", "/api/launch-session", {
        tool: "copilot-cli",
        prompt: "Do something",
      });
      expect(response.status).toBe(400);
      var body = JSON.parse(response.body);
      expect(body.error).toContain("required");
    });

    it("rejects invalid mode value", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "POST", "/api/launch-session", {
        tool: "copilot-cli",
        mode: "restart",
        prompt: "Do something",
      });
      expect(response.status).toBe(400);
      var body = JSON.parse(response.body);
      expect(body.error).toContain("Unsupported");
    });

    it("returns 405 for GET requests", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/launch-session");
      expect(response.status).toBe(405);
    });
  });
});

// Helper: make an HTTP request to the server without binding to a port
function makeRequest(server, method, pathname, body) {
  return new Promise(function (resolve) {
    var http = require("node:http");
    var bodyStr = body ? JSON.stringify(body) : "";
    var req = new http.IncomingMessage();
    req.method = method;
    req.url = pathname;
    req.headers = { "content-type": "application/json" };

    var res = new MockResponse();

    // For POST requests, emit the body data
    server.emit("request", req, res);

    if (method === "POST" && bodyStr) {
      req.emit("data", bodyStr);
      req.emit("end");
    }

    // Wait for response to finish
    setTimeout(function () {
      resolve({ status: res._statusCode, body: res._body, headers: res._headers });
    }, 100);
  });
}

// Minimal mock response object
function MockResponse() {
  this._statusCode = 200;
  this._body = "";
  this._headers = {};
  this.headersSent = false;
  this.writableEnded = false;
}
MockResponse.prototype.setHeader = function (name, value) { this._headers[name.toLowerCase()] = value; };
MockResponse.prototype.writeHead = function (code, headers) {
  this._statusCode = code;
  this.headersSent = true;
  if (headers) {
    var self = this;
    Object.keys(headers).forEach(function (k) { self._headers[k.toLowerCase()] = headers[k]; });
  }
};
MockResponse.prototype.write = function (chunk) { this._body += chunk; };
MockResponse.prototype.end = function (data) {
  if (data) this._body += data;
  this.writableEnded = true;
};
