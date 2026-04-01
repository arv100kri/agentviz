/**
 * FAX-VIZ server.
 * Standalone HTTP server for browsing fax context bundles.
 *
 *   GET  /api/faxes              -- list all fax bundles in --fax-dir
 *   GET  /api/fax/:id/events     -- serve events.jsonl for a bundle
 *   GET  /api/fax/:id/file/:name -- serve any file from a bundle
 *   GET  /api/fax-read-status    -- get read/unread state
 *   POST /api/fax-read-status    -- mark a fax as read
 *   POST /api/qa                 -- Q&A with fax context injection
 */

import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import url from "url";
import { spawn, execSync } from "child_process";
import { handleSessionQA } from "./src/lib/sessionQAPipeline.js";
import {
  ensureSessionQAPrecomputed,
  createSessionQACacheStore,
  resolveSessionQAArtifacts,
} from "./src/lib/sessionQAServer.js";
import {
  readBody,
  handleQAHistoryEndpoint,
  handleQACacheEndpoint,
  createModelAnswerCache,
  setupSSE,
} from "./src/lib/sessionQAEndpoints.js";
import { buildReplyIntent, writeReplyIntent } from "./src/fax-viz/lib/faxReplyIntent.js";
import { createThreadStore } from "./src/fax-viz/lib/threadStore.js";

var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

var READ_STATUS_FILE = path.join(os.homedir(), ".agentviz", "fax-read-status.json");

function readReadStatus() {
  try {
    return JSON.parse(fs.readFileSync(READ_STATUS_FILE, "utf8"));
  } catch (e) {
    return {};
  }
}

function writeReadStatus(data) {
  var dir = path.dirname(READ_STATUS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(READ_STATUS_FILE, JSON.stringify(data, null, 2), "utf8");
}

function parseManifest(bundlePath) {
  try {
    var raw = fs.readFileSync(path.join(bundlePath, "manifest.json"), "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// Resolve server version once at startup
var serverVersion = (function () {
  var ver = { version: "0.0.0", commit: "unknown", branch: "unknown", startedAt: new Date().toISOString() };
  // Read package.json version
  try {
    var pkgPath = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "package.json");
    var pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    ver.version = pkg.version || ver.version;
  } catch (_) {}
  // Try git (works when running from repo checkout)
  try {
    ver.commit = execSync("git rev-parse --short HEAD", { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
    ver.branch = execSync("git rev-parse --abbrev-ref HEAD", { stdio: ["pipe", "pipe", "pipe"] }).toString().trim();
  } catch (_) {
    // npx install: try reading commit from the resolved URL in package-lock or _resolved
    try {
      var modDir = path.dirname(url.fileURLToPath(import.meta.url));
      var lockPath = path.resolve(modDir, "../../package-lock.json");
      if (fs.existsSync(lockPath)) {
        var lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        var resolved = lock.packages && lock.packages["node_modules/agentviz"] && lock.packages["node_modules/agentviz"].resolved;
        if (resolved && /#([0-9a-f]+)$/.test(resolved)) {
          ver.commit = RegExp.$1.slice(0, 8);
        }
      }
    } catch (_) {}
  }
  return ver;
})();

function discoverFaxBundles(faxDir) {
  var results = [];
  var entries;
  try {
    entries = fs.readdirSync(faxDir, { withFileTypes: true });
  } catch (e) {
    return results;
  }

  for (var i = 0; i < entries.length; i++) {
    if (!entries[i].isDirectory()) continue;
    var folderName = entries[i].name;

    var bundlePath = path.join(faxDir, folderName);
    var manifest = parseManifest(bundlePath);
    if (!manifest) continue;

    var hasEvents = false;
    try {
      fs.accessSync(path.join(bundlePath, "events.jsonl"));
      hasEvents = true;
    } catch (e) {}

    // Build display label from bundleLabel or folder name
    var label = manifest.bundleLabel || folderName.replace(/^fax-context-/, "").replace(/-\d{8}-\d{6}$/, "") || folderName;

    var sharedArtifacts = Array.isArray(manifest.sharedArtifacts) ? manifest.sharedArtifacts : [];
    var artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];

    results.push({
      id: folderName,
      folderName: folderName,
      label: label,
      sender: manifest.sender || { alias: "Unknown", email: "", program: "", sessionId: "" },
      importance: manifest.importance || "normal",
      threadId: manifest.threadId || "",
      createdUtc: manifest.createdUtc || "",
      hasEvents: hasEvents,
      artifactCount: artifacts.length,
      sharedArtifactCount: sharedArtifacts.length,
      git: manifest.git || null,
      progress: manifest.progress || null,
      bundlePath: bundlePath,
      sourceRoot: manifest.sourceRoot || null,
      mode: "broadcast",
    });
  }

  // Sort by date descending by default
  results.sort(function (a, b) {
    return (b.createdUtc || "").localeCompare(a.createdUtc || "");
  });

  return results;
}

function serveStatic(res, filePath) {
  try {
    var ext = path.extname(filePath).toLowerCase();
    var mime = MIME[ext] || "application/octet-stream";
    var content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end("Not found");
  }
}

function readBundleMarkdownFiles(bundlePath) {
  var markdownFiles = ["handoff.md", "analysis.md", "decisions.md", "collab.md"];
  var textFiles = ["bootstrap-prompt.txt"];
  var result = [];

  var allFiles = markdownFiles.concat(textFiles);
  for (var i = 0; i < allFiles.length; i++) {
    try {
      var content = fs.readFileSync(path.join(bundlePath, allFiles[i]), "utf8");
      result.push({ name: allFiles[i], content: content });
    } catch (e) {}
  }

  return result;
}

export function createFaxVizServer({ faxDir, distDir, threadsFile }) {
  // In-memory session Q&A cache (mirrors the main server's cache pattern)
  var sessionQACache = createSessionQACacheStore();
  var modelAnswerCache = createModelAnswerCache(50);

  // Thread store (optional — enabled when --threads-file is provided)
  var threadStore = threadsFile ? createThreadStore(threadsFile) : null;

  // Bundle location map: bundleId -> absolute path (built from faxDir + threads.json)
  function resolveBundlePath(bundleId) {
    // First check faxDir
    if (faxDir) {
      var localPath = path.join(faxDir, bundleId);
      if (localPath.startsWith(faxDir)) {
        try { fs.accessSync(path.join(localPath, "manifest.json")); return localPath; } catch (_) {}
      }
    }
    // Then check thread store locations
    if (threadStore) {
      var locationMap = threadStore.buildLocationMap();
      var threadPath = locationMap[bundleId];
      if (threadPath) {
        var resolved = path.resolve(threadPath);
        try {
          fs.accessSync(path.join(resolved, "manifest.json"));
          return resolved;
        } catch (_) {}
      }
    }
    return null;
  }

  function handleRequest(req, res) {
    var parsed = url.parse(req.url, true);
    var pathname = parsed.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Session Q&A cache: shared handler
    if (pathname === "/api/session-qa-cache") {
      // Clear model answer cache on DELETE so cached model answers don't persist
      if (req.method === "DELETE" && modelAnswerCache && modelAnswerCache.clear) {
        modelAnswerCache.clear();
      }
      handleQACacheEndpoint(req, res, parsed, { sessionQACache: sessionQACache });
      return;
    }

    // Session Q&A history: shared handler
    if (pathname === "/api/session-qa-history") {
      handleQAHistoryEndpoint(req, res, parsed);
      return;
    }

    // GET /api/version
    if (pathname === "/api/version") {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify(serverVersion));
      return;
    }

    // GET /api/faxes
    if (pathname === "/api/faxes") {
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      var faxes = discoverFaxBundles(faxDir);
      var seenIds = {};
      for (var fi = 0; fi < faxes.length; fi++) seenIds[faxes[fi].id] = true;

      // Augment with thread metadata and include external bundles
      if (threadStore) {
        // Add external bundles from threads.json not already in faxDir
        var external = threadStore.getExternalBundles(faxDir);
        for (var ei = 0; ei < external.length; ei++) {
          if (seenIds[external[ei].bundleId]) continue;
          var extPath = external[ei].location;
          // Security: verify the path exists and has a manifest
          try {
            var extManifest = parseManifest(extPath);
            if (!extManifest) continue;
            var hasEvents = false;
            try { fs.accessSync(path.join(extPath, "events.jsonl")); hasEvents = true; } catch (_) {}
            var extLabel = extManifest.bundleLabel || external[ei].bundleId.replace(/^fax-context-/, "").replace(/-\d{8}-\d{6}$/, "") || external[ei].bundleId;
            faxes.push({
              id: external[ei].bundleId,
              folderName: external[ei].bundleId,
              label: extLabel,
              sender: extManifest.sender || { alias: "Unknown", email: "", program: "", sessionId: "" },
              importance: extManifest.importance || "normal",
              threadId: external[ei].threadId || extManifest.threadId || "",
              createdUtc: extManifest.createdUtc || "",
              hasEvents: hasEvents,
              artifactCount: Array.isArray(extManifest.artifacts) ? extManifest.artifacts.length : 0,
              sharedArtifactCount: Array.isArray(extManifest.sharedArtifacts) ? extManifest.sharedArtifacts.length : 0,
              git: extManifest.git || null,
              progress: extManifest.progress || null,
              bundlePath: extPath,
              sourceRoot: extManifest.sourceRoot || null,
            });
            seenIds[external[ei].bundleId] = true;
          } catch (_) {}
        }
        // Augment all faxes with thread metadata
        for (var ai = 0; ai < faxes.length; ai++) {
          threadStore.augmentFax(faxes[ai]);
        }
        // Re-sort after adding external bundles
        faxes.sort(function (a, b) {
          return (b.createdUtc || "").localeCompare(a.createdUtc || "");
        });
      }
      res.writeHead(200);
      res.end(JSON.stringify({ faxes: faxes }));
      return;
    }

    // GET /api/fax-read-status
    // POST /api/fax-read-status
    if (pathname === "/api/fax-read-status") {
      res.setHeader("Content-Type", "application/json");

      if (req.method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify(readReadStatus()));
        return;
      }

      if (req.method === "POST") {
        readBody(req, res).then(function (body) {
          try {
            var payload = JSON.parse(body);
            var status = readReadStatus();
            status[payload.folderName] = payload.readAt || new Date().toISOString();
            writeReadStatus(status);
            res.writeHead(200);
            res.end(JSON.stringify({ success: true }));
          } catch (e) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: e.message }));
          }
        }).catch(function (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        });
        return;
      }

      res.writeHead(405);
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // GET /api/fax/:id/events
    var eventsMatch = pathname.match(/^\/api\/fax\/([^/]+)\/events$/);
    if (eventsMatch) {
      res.setHeader("Content-Type", "application/x-ndjson");
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      var faxId = decodeURIComponent(eventsMatch[1]);
      var bundleDir = resolveBundlePath(faxId);
      if (!bundleDir) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Bundle not found" }));
        return;
      }
      var eventsPath = path.join(bundleDir, "events.jsonl");
      try {
        var content = fs.readFileSync(eventsPath, "utf8");
        res.writeHead(200);
        res.end(content);
      } catch (e) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "events.jsonl not found" }));
      }
      return;
    }

    // GET /api/fax/:id/file/:name
    var fileMatch = pathname.match(/^\/api\/fax\/([^/]+)\/file\/(.+)$/);
    if (fileMatch) {
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      var faxId = decodeURIComponent(fileMatch[1]);
      var fileName = decodeURIComponent(fileMatch[2]);
      var bundleDir = resolveBundlePath(faxId);
      if (!bundleDir) {
        res.writeHead(404);
        res.end("Bundle not found");
        return;
      }
      var filePath = path.join(bundleDir, fileName);
      // Prevent directory traversal within the bundle
      if (!filePath.startsWith(bundleDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      serveStatic(res, filePath);
      return;
    }

    // GET /api/fax/:id/manifest
    var manifestMatch = pathname.match(/^\/api\/fax\/([^/]+)\/manifest$/);
    if (manifestMatch) {
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      var faxId = decodeURIComponent(manifestMatch[1]);
      var bundlePath = resolveBundlePath(faxId);
      if (!bundlePath) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Bundle not found" }));
        return;
      }
      var manifest = parseManifest(bundlePath);
      if (!manifest) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Manifest not found" }));
        return;
      }
      var markdownFiles = readBundleMarkdownFiles(bundlePath);
      res.writeHead(200);
      res.end(JSON.stringify({ manifest: manifest, markdownFiles: markdownFiles }));
      return;
    }

    // POST /api/qa (with fax context injection)
    if (pathname === "/api/qa") {
      if (req.method !== "POST") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      readBody(req, res).then(async function (body) {
        var payload;
        try {
          payload = JSON.parse(body);
        } catch (e) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }

        var question = payload.question;
        var sessionKey = payload.sessionKey || null;
        var requestedModel = payload.model || null;
        var qaSessionId = payload.qaSessionId || null;
        var qaRequestStartedAt = Date.now();

        if (!question) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing 'question' field" }));
          return;
        }

        // Resolve session from cache or inline payload (shared logic with server.js)
        var resolvedSession = resolveSessionQAArtifacts(sessionQACache, payload);

        if (!resolvedSession) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing session data" }));
          return;
        }

        // Extract faxId from sessionKey (format: "fax:<faxId>")
        var faxId = null;
        var manifestData = null;
        if (sessionKey && sessionKey.startsWith("fax:")) {
          faxId = sessionKey.substring(4);
        }

        // Inject manifest BEFORE precomputation so the fact store can persist it
        if (faxId) {
          var bundlePath = path.join(faxDir, faxId);
          if (bundlePath.startsWith(faxDir)) {
            try {
              var manifestPath = path.join(bundlePath, "manifest.json");
              manifestData = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
            } catch (_) {}
            if (manifestData) {
              resolvedSession.faxMetadata = manifestData;
              // Invalidate stale fact store so it gets rebuilt with manifest data
              if (resolvedSession.factStore && !resolvedSession.factStore.hasFaxMetadata) {
                resolvedSession.factStore = null;
              }
            }
          }
        }

        // Ensure precomputed artifacts and program cache exist
        try {
          ensureSessionQAPrecomputed(resolvedSession);
        } catch (preErr) {}
        if (!resolvedSession.programCache) {
          resolvedSession.programCache = {};
        }

        // Build contextExtender that prepends fax metadata + markdown context
        var contextExtender = null;
        if (faxId) {
          var bundlePath2 = path.join(faxDir, faxId);
          if (bundlePath2.startsWith(faxDir)) {
            var mdFiles = readBundleMarkdownFiles(bundlePath2);

            if (mdFiles.length > 0 || manifestData) {
              contextExtender = function (sessionContext) {
                var faxContext = "\n\n--- FAX BUNDLE CONTEXT ---\n\n";
                faxContext += "NOTE: This is a fax bundle (a context handoff between agents). ";
                faxContext += "The fax documents below are the PRIMARY source of truth. ";
                faxContext += "If the session data shows 0 turns or no events, answer from the fax documents instead.\n\n";
                if (manifestData) {
                  faxContext += "## Fax Metadata\n\n";
                  if (manifestData.sender) {
                    var s = manifestData.sender;
                    var senderStr = typeof s === "string" ? s : (s.alias || s.email || s.name || JSON.stringify(s));
                    faxContext += "- **Sender**: " + senderStr + "\n";
                    if (s.email && s.alias) faxContext += "- **Sender email**: " + s.email + "\n";
                    if (s.program) faxContext += "- **Sender tool**: " + s.program + "\n";
                  }
                  if (manifestData.importance) faxContext += "- **Importance**: " + manifestData.importance + "\n";
                  if (manifestData.thread) faxContext += "- **Thread**: " + manifestData.thread + "\n";
                  if (manifestData.summary) faxContext += "- **Summary**: " + manifestData.summary + "\n";
                  if (manifestData.timestamp) faxContext += "- **Timestamp**: " + manifestData.timestamp + "\n";
                  if (manifestData.repo) faxContext += "- **Repo**: " + manifestData.repo + "\n";
                  if (manifestData.branch) faxContext += "- **Branch**: " + manifestData.branch + "\n";
                  if (manifestData.program && !manifestData.sender) faxContext += "- **Program**: " + manifestData.program + "\n";
                  if (manifestData.progress) {
                    if (manifestData.progress.stepsCompleted && manifestData.progress.stepsCompleted.length > 0) {
                      faxContext += "- **Steps completed**: " + manifestData.progress.stepsCompleted.join(", ") + "\n";
                    }
                    if (manifestData.progress.stepsRemaining && manifestData.progress.stepsRemaining.length > 0) {
                      faxContext += "- **Steps remaining**: " + manifestData.progress.stepsRemaining.join(", ") + "\n";
                    }
                  }
                  if (manifestData.doNotRetry && manifestData.doNotRetry.length > 0) {
                    faxContext += "- **Do not retry**: " + manifestData.doNotRetry.join(", ") + "\n";
                  }
                  faxContext += "\n";
                }
                for (var i = 0; i < mdFiles.length; i++) {
                  faxContext += "## " + mdFiles[i].name + "\n\n" + mdFiles[i].content + "\n\n";
                }
                faxContext += "--- END FAX BUNDLE CONTEXT ---\n\n";
                return faxContext + sessionContext;
              };
            }
          }
        }

        // SSE streaming response with instrumentation
        var rawSseSend = setupSSE(res);
        var qaLog = { question: question, sessionKey: sessionKey, startedAt: qaRequestStartedAt };
        var sseSend = function (data) {
          // Capture key pipeline events for debugging
          if (data && data.phase) qaLog.lastPhase = data.phase;
          if (data && data.detail && typeof data.detail === "string") {
            if (data.detail.indexOf("paraphrase") !== -1) qaLog.paraphraseCacheHit = data.detail.indexOf("Found") !== -1;
            if (data.detail.indexOf("cached") !== -1 && data.detail.indexOf("Reusing") !== -1) qaLog.programCacheHit = true;
          }
          if (data && data.done) {
            qaLog.elapsedMs = Date.now() - qaRequestStartedAt;
            qaLog.answerLength = data.answer ? data.answer.length : 0;
            console.log("[Q&A LOG]", JSON.stringify(qaLog));
          }
          rawSseSend(data);
        };

        try {
          await handleSessionQA({
            question: question,
            resolvedSession: resolvedSession,
            requestedModel: requestedModel,
            qaSessionId: qaSessionId,
            contextExtender: contextExtender,
            sseSend: sseSend,
            homeDir: os.homedir(),
            modelAnswerCache: modelAnswerCache,
            requestKind: payload.requestKind || null,
            speculativeOptimizations: payload.speculativeOptimizations !== false,
            qaRequestStartedAt: qaRequestStartedAt,
            onAbort: function (abortFn) {
              res.on("close", abortFn);
            },
          });
        } catch (pipelineError) {
          sseSend({ error: pipelineError.message || "Q&A failed" });
        }

        if (!res.writableEnded) res.end();
      }).catch(function (e) {
        if (!res.headersSent) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    // GET /api/copilot-sessions
    if (pathname === "/api/copilot-sessions") {
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      var homeDir = process.env.HOME || process.env.USERPROFILE || "";
      var copilotRoot = path.join(homeDir, ".copilot", "session-state");
      var sessions = [];

      try {
        var sessionDirs = fs.readdirSync(copilotRoot, { withFileTypes: true });
        for (var si = 0; si < sessionDirs.length; si++) {
          if (!sessionDirs[si].isDirectory()) continue;
          var sessionDirName = sessionDirs[si].name;
          var sessionDir = path.join(copilotRoot, sessionDirName);
          var eventsFile = path.join(sessionDir, "events.jsonl");

          try {
            var evStat = fs.statSync(eventsFile);
            // Filter out sessions smaller than 5KB
            if (evStat.size < 5120) continue;

            var summary = null;
            var repo = null;
            var branch = null;
            var cwd = null;

            try {
              var yamlText = fs.readFileSync(path.join(sessionDir, "workspace.yaml"), "utf8");
              var inlineMatch = yamlText.match(/^summary:\s+(?!\|-\s*$)(.+)$/m);
              var blockMatch = yamlText.match(/^summary:\s*\|-\s*\n([ \t]+)(.+)$/m);
              var repoMatch = yamlText.match(/^repository:\s*(.+)$/m);
              var branchMatch = yamlText.match(/^branch:\s*(.+)$/m);
              var cwdMatch = yamlText.match(/^cwd:\s*(.+)$/m);

              if (inlineMatch && inlineMatch[1].trim()) {
                summary = inlineMatch[1].trim();
              } else if (blockMatch && blockMatch[2].trim()) {
                summary = blockMatch[2].trim();
              }
              if (repoMatch) repo = repoMatch[1].trim();
              if (branchMatch) branch = branchMatch[1].trim();
              if (cwdMatch) cwd = cwdMatch[1].trim();

              // Filter out AGENTVIZ subprocess sessions
              if (summary && (
                summary.startsWith("Analyze this") ||
                (summary.includes("Session stats") && summary.includes("read_config")) ||
                summary.includes("SESSION DATA:") ||
                summary.includes("SESSION OVERVIEW") ||
                summary.includes("You are an AI assistant that answers questions about a coding session") ||
                summary.includes("[AGENTVIZ-QA]")
              )) {
                continue;
              }
            } catch (yamlErr) {}

            // Derive project label from repo or cwd
            var project = null;
            if (repo) {
              var repoParts = repo.split("/").filter(Boolean);
              project = repoParts[repoParts.length - 1] || repo;
            } else if (cwd) {
              var cwdParts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
              project = cwdParts[cwdParts.length - 1] || cwd;
            }

            sessions.push({
              id: sessionDirName,
              tool: "copilot-cli",
              summary: summary || null,
              project: project,
              branch: branch,
              cwd: cwd,
              mtime: evStat.mtime.toISOString(),
            });
          } catch (evErr) {}
        }
      } catch (rootErr) {}

      sessions.sort(function (a, b) {
        return new Date(b.mtime) - new Date(a.mtime);
      });

      res.writeHead(200);
      res.end(JSON.stringify({ sessions: sessions }));
      return;
    }

    // POST /api/fax/:id/pickup
    var pickupMatch = pathname.match(/^\/api\/fax\/([^/]+)\/pickup$/);
    if (pickupMatch) {
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      var pickupFaxId = decodeURIComponent(pickupMatch[1]);
      var pickupBundlePath = resolveBundlePath(pickupFaxId);

      if (!pickupBundlePath) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Bundle not found" }));
        return;
      }

      try {
        var bootstrap = "";
        try {
          bootstrap = fs.readFileSync(path.join(pickupBundlePath, "bootstrap-prompt.txt"), "utf8");
        } catch (_) {}

        var pickupManifest = parseManifest(pickupBundlePath);

        // Update thread store if available, otherwise fall back to legacy intent file
        if (threadStore) {
          threadStore.update(function (data) {
            var threads = data.threads || {};
            var threadIds = Object.keys(threads);
            for (var i = 0; i < threadIds.length; i++) {
              var thread = threads[threadIds[i]];
              var entries = Array.isArray(thread.entries) ? thread.entries : [];
              for (var j = 0; j < entries.length; j++) {
                if (entries[j].bundleId === pickupFaxId) {
                  thread.pickedUp = true;
                  thread.pickedUpAt = new Date().toISOString();
                  return;
                }
              }
            }
          });
        } else {
          // Legacy fallback: write .fax-reply-intent.json
          var intent = buildReplyIntent(pickupManifest, pickupFaxId);
          writeReplyIntent(faxDir, intent);
        }

        // Mark as read
        var readStatus = readReadStatus();
        readStatus[pickupFaxId] = new Date().toISOString();
        writeReadStatus(readStatus);

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, bootstrap: bootstrap }));
      } catch (pickupErr) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: pickupErr.message || "Pickup failed" }));
      }
      return;
    }


    // POST /api/browse-folder -- opens a native folder picker dialog
    if (pathname === "/api/browse-folder") {
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      readBody(req, res).then(function (body) {
        try {
          var payload = JSON.parse(body || "{}");
          var startDir = payload.startDir || os.homedir();
          var isWindows = process.platform === "win32";
          var script;

          if (isWindows) {
            // Use PowerShell to show a folder browser dialog
            script = 'powershell -NoProfile -Command "' +
              "Add-Type -AssemblyName System.Windows.Forms; " +
              "$d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
              "$d.SelectedPath = '" + startDir.replace(/'/g, "''") + "'; " +
              "$d.Description = 'Select working directory'; " +
              "if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { '' }" +
              '"';
          } else {
            // On macOS/Linux, use osascript or zenity
            if (process.platform === "darwin") {
              script = 'osascript -e \'choose folder with prompt "Select working directory" default location "' + startDir + '"\' 2>/dev/null | sed "s/alias Macintosh HD//" | tr ":" "/"';
            } else {
              script = 'zenity --file-selection --directory --title="Select working directory" 2>/dev/null || echo ""';
            }
          }

          execSync("echo test", { stdio: "ignore" }); // warm up
          var result = execSync(script, { encoding: "utf8", timeout: 60000 }).trim();

          if (result) {
            res.writeHead(200);
            res.end(JSON.stringify({ folder: result }));
          } else {
            res.writeHead(200);
            res.end(JSON.stringify({ folder: null, cancelled: true }));
          }
        } catch (browseErr) {
          res.writeHead(200);
          res.end(JSON.stringify({ folder: null, cancelled: true }));
        }
      }).catch(function () {
        res.writeHead(200);
        res.end(JSON.stringify({ folder: null, cancelled: true }));
      });
      return;
    }

    // POST /api/launch-session
    if (pathname === "/api/launch-session") {
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      readBody(req, res).then(function (body) {
        try {
          var payload = JSON.parse(body);
          var tool = payload.tool;
          var mode = payload.mode;
          var sessionId = payload.sessionId || null;
          var prompt = payload.prompt || "";
          var launchCwd = payload.cwd || null;

          if (!tool || !mode) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "tool and mode are required" }));
            return;
          }

          if (launchCwd && !fs.existsSync(launchCwd)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Working directory does not exist: " + launchCwd }));
            return;
          }

          var cmd;
          var cmdArgs;

          if (tool === "copilot-cli" && mode === "new") {
            cmd = "copilot";
            cmdArgs = ["-i", prompt];
          } else if (tool === "copilot-cli" && mode === "resume") {
            cmd = "copilot";
            cmdArgs = ["--resume=" + sessionId, "-i", prompt];
          } else if (tool === "claude-code" && mode === "new") {
            cmd = "claude";
            cmdArgs = [prompt];
          } else if (tool === "claude-code" && mode === "resume") {
            cmd = "claude";
            cmdArgs = ["--resume", sessionId, prompt];
          } else {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Unsupported tool/mode combination: " + tool + "/" + mode }));
            return;
          }

          // Write the prompt to a temp file to avoid shell quoting issues
          // with long multi-line bootstrap prompts
          var tmpDir = path.join(os.tmpdir(), "fax-viz-launch");
          fs.mkdirSync(tmpDir, { recursive: true });
          var promptFile = path.join(tmpDir, "prompt-" + Date.now() + ".txt");
          fs.writeFileSync(promptFile, prompt, "utf8");

          // On Windows, Copilot CLI needs an interactive terminal.
          // Use 'start' to open a new console window that stays alive.
          // Read the prompt from the temp file via shell redirection.
          var isWindows = process.platform === "win32";
          var child;

          if (isWindows) {
            var shellScript;
            if (tool === "copilot-cli" && mode === "new") {
              shellScript = 'copilot -i "' + promptFile.replace(/\\/g, "\\\\") + '"';
            } else if (tool === "copilot-cli" && mode === "resume") {
              shellScript = 'copilot --resume=' + sessionId + ' -i "' + promptFile.replace(/\\/g, "\\\\") + '"';
            } else if (tool === "claude-code" && mode === "new") {
              shellScript = 'claude --input-file "' + promptFile.replace(/\\/g, "\\\\") + '"';
            } else {
              shellScript = 'claude --resume ' + sessionId + ' --input-file "' + promptFile.replace(/\\/g, "\\\\") + '"';
            }
            // Prefer Windows Terminal (wt.exe) for a modern look.
            // Fall back to cmd.exe if wt is not available.
            var wtPath = "wt.exe";
            var wtAvailable = false;
            try {
              execSync("where wt.exe", { stdio: "ignore" });
              wtAvailable = true;
            } catch (e) {}

            if (wtAvailable) {
              var wtArgs = ["new-tab"];
              if (launchCwd) { wtArgs.push("--startingDirectory", launchCwd); }
              wtArgs.push("cmd", "/k", shellScript);
              child = spawn("wt.exe", wtArgs, {
                detached: true,
                stdio: "ignore",
                shell: false,
              });
            } else {
              var cmdOpts = {
                detached: true,
                stdio: "ignore",
                shell: false,
              };
              if (launchCwd) cmdOpts.cwd = launchCwd;
              child = spawn("cmd", ["/c", "start", "cmd", "/k", shellScript], cmdOpts);
            }
          } else {
            var unixOpts = {
              detached: true,
              stdio: "ignore",
              shell: true,
            };
            if (launchCwd) unixOpts.cwd = launchCwd;
            child = spawn(cmd, cmdArgs, unixOpts);
          }
          child.unref();

          res.writeHead(200);
          res.end(JSON.stringify({ status: "launched", tool: tool }));
        } catch (launchErr) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: launchErr.message || "Launch failed" }));
        }
      }).catch(function (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      });
      return;
    }

    // Static file serving (SPA)
    if (distDir) {
      var staticPath = pathname === "/" || pathname === "/index.html"
        ? path.join(distDir, "fax-viz-index.html")
        : path.join(distDir, pathname);

      if (!staticPath.startsWith(distDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      try {
        var stat = fs.statSync(staticPath);
        if (stat.isFile()) {
          serveStatic(res, staticPath);
        } else {
          serveStatic(res, path.join(distDir, "fax-viz-index.html"));
        }
      } catch (e) {
        serveStatic(res, path.join(distDir, "fax-viz-index.html"));
      }
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  }

  var server = http.createServer(function (req, res) {
    try {
      handleRequest(req, res);
    } catch (err) {
      process.stderr.write("[fax-viz] unhandled request error: " + req.url + "\n" + (err.stack || err.message) + "\n");
      try {
        if (!res.headersSent) { res.writeHead(500); res.end("Internal server error"); }
      } catch (e2) {}
    }
  });

  server.on("error", function (err) {
    process.stderr.write("[fax-viz] server error: " + err.message + "\n" + (err.stack || "") + "\n");
  });

  return server;
}
