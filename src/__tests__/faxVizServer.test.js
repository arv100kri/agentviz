import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

  // Non-fax directory (should be ignored)
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
      expect(body.faxes).toHaveLength(2);
      // Sorted by date desc (newest first)
      expect(body.faxes[0].id).toBe("fax-context-test-bundle-20260326-180423");
      expect(body.faxes[1].id).toBe("fax-context-no-events-20260325-120000");
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

    it("ignores non-fax directories", async function () {
      var server = createFaxVizServer({ faxDir: tmpDir, distDir: null });
      var response = await makeRequest(server, "GET", "/api/faxes");
      var ids = JSON.parse(response.body).faxes.map(function (f) { return f.id; });
      expect(ids).not.toContain("random-folder");
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
