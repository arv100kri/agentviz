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
import { spawn } from "child_process";
import { handleSessionQA } from "./src/lib/sessionQAPipeline.js";
import {
  ensureSessionQAPrecomputed,
  createSessionQACacheStore,
  saveSessionQACacheEntry,
  getSessionQACacheEntry,
  removeSessionQACacheEntry,
  getSessionQAHistoryFilePath,
  getSessionQAHistoryEntry,
  saveSessionQAHistoryEntry,
  removeSessionQAHistoryEntry,
} from "./server.js";
import { buildReplyIntent, writeReplyIntent } from "./src/fax-viz/lib/faxReplyIntent.js";

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
    if (!folderName.startsWith("fax-context-")) continue;

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

function readBody(req) {
  return new Promise(function (resolve, reject) {
    var body = "";
    var MAX_BYTES = 10 * 1024 * 1024;
    req.on("data", function (chunk) {
      body += chunk;
      if (body.length > MAX_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", function () { resolve(body); });
    req.on("error", reject);
  });
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

export function createFaxVizServer({ faxDir, distDir }) {
  // In-memory session Q&A cache (mirrors the main server's cache pattern)
  var sessionQACache = createSessionQACacheStore();

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

    // Session Q&A cache: stores session data so Q&A can use lean payloads
    if (pathname === "/api/session-qa-cache") {
      res.setHeader("Content-Type", "application/json");

      if (req.method === "GET") {
        var cacheKey = parsed.query.sessionKey || "";
        res.writeHead(200);
        res.end(JSON.stringify({ session: getSessionQACacheEntry(sessionQACache, cacheKey) }));
        return;
      }

      if (req.method === "DELETE") {
        var delKey = parsed.query.sessionKey || "";
        removeSessionQACacheEntry(sessionQACache, delKey);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (req.method === "POST") {
        readBody(req).then(function (body) {
          try {
            var payload = JSON.parse(body);
            if (!payload.sessionKey) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: "sessionKey is required" }));
              return;
            }
            var savedSession = saveSessionQACacheEntry(
              sessionQACache,
              payload.sessionKey,
              payload
            );
            var precomputed = ensureSessionQAPrecomputed(savedSession);
            res.writeHead(200);
            res.end(JSON.stringify({
              success: true,
              sessionKey: payload.sessionKey,
              updatedAt: savedSession ? savedSession.updatedAt : null,
              precomputed: precomputed ? {
                fingerprint: precomputed.fingerprint,
                reused: precomputed.reused,
              } : null,
            }));
          } catch (e) {
            res.writeHead(500);
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

    // Session Q&A history: persists conversation history to disk
    if (pathname === "/api/session-qa-history") {
      res.setHeader("Content-Type", "application/json");
      var qaHistoryFile = getSessionQAHistoryFilePath();

      if (req.method === "GET") {
        var historySessionKey = parsed.query.sessionKey || "";
        if (!historySessionKey) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "sessionKey is required" }));
          return;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ history: getSessionQAHistoryEntry(qaHistoryFile, historySessionKey) }));
        return;
      }

      if (req.method === "DELETE") {
        var deleteHistoryKey = parsed.query.sessionKey || "";
        if (!deleteHistoryKey) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "sessionKey is required" }));
          return;
        }
        removeSessionQAHistoryEntry(qaHistoryFile, deleteHistoryKey);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      readBody(req).then(function (body) {
        try {
          var historyPayload = JSON.parse(body || "{}");
          if (!historyPayload.sessionKey) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "sessionKey is required" }));
            return;
          }
          var savedHistory = saveSessionQAHistoryEntry(
            qaHistoryFile,
            historyPayload.sessionKey,
            historyPayload.history || historyPayload
          );
          res.writeHead(200);
          res.end(JSON.stringify({ success: true, history: savedHistory }));
        } catch (error) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: error.message || "Could not persist session Q&A history" }));
        }
      }).catch(function (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      });
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
        readBody(req).then(function (body) {
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
      var eventsPath = path.join(faxDir, faxId, "events.jsonl");
      // Prevent directory traversal
      if (!eventsPath.startsWith(faxDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
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
      var filePath = path.join(faxDir, faxId, fileName);
      // Prevent directory traversal
      if (!filePath.startsWith(path.join(faxDir, faxId))) {
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
      var bundlePath = path.join(faxDir, faxId);
      if (!bundlePath.startsWith(faxDir)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }
      var manifest = parseManifest(bundlePath);
      if (!manifest) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Manifest not found" }));
        return;
      }
      // Also include markdown file contents for the observe view
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

      readBody(req).then(async function (body) {
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

        // Resolve session from cache (lean payload) or from the request body
        var resolvedSession = null;
        if (sessionKey) {
          resolvedSession = getSessionQACacheEntry(sessionQACache, sessionKey);
        }
        if (!resolvedSession && Array.isArray(payload.events) && payload.events.length > 0) {
          resolvedSession = saveSessionQACacheEntry(sessionQACache, sessionKey || "inline", payload);
        }

        if (!resolvedSession) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing session data" }));
          return;
        }

        // Extract faxId from sessionKey (format: "fax:<faxId>")
        var faxId = null;
        if (sessionKey && sessionKey.startsWith("fax:")) {
          faxId = sessionKey.substring(4);
        }

        // Ensure precomputed artifacts and program cache exist
        try {
          ensureSessionQAPrecomputed(resolvedSession);
        } catch (preErr) {}
        if (!resolvedSession.programCache) {
          resolvedSession.programCache = {};
        }

        // Build contextExtender that prepends fax markdown context
        var contextExtender = null;
        if (faxId) {
          var bundlePath = path.join(faxDir, faxId);
          if (bundlePath.startsWith(faxDir)) {
            var mdFiles = readBundleMarkdownFiles(bundlePath);
            if (mdFiles.length > 0) {
              contextExtender = function (sessionContext) {
                var faxContext = "\n\n--- FAX BUNDLE CONTEXT ---\n\n";
                for (var i = 0; i < mdFiles.length; i++) {
                  faxContext += "## " + mdFiles[i].name + "\n\n" + mdFiles[i].content + "\n\n";
                }
                faxContext += "--- END FAX BUNDLE CONTEXT ---\n\n";
                return faxContext + sessionContext;
              };
            }
          }
        }

        // SSE streaming response
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.writeHead(200);

        function sseSend(data) {
          if (!res.writableEnded) res.write("data: " + JSON.stringify(data) + "\n\n");
        }

        try {
          await handleSessionQA({
            question: question,
            resolvedSession: resolvedSession,
            requestedModel: requestedModel,
            qaSessionId: qaSessionId,
            contextExtender: contextExtender,
            sseSend: sseSend,
            homeDir: os.homedir(),
            requestKind: payload.requestKind || null,
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
        res.setHeader("Content-Type", "application/json");
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
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
      var pickupBundlePath = path.join(faxDir, pickupFaxId);

      // Prevent directory traversal
      if (!pickupBundlePath.startsWith(faxDir)) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }

      try {
        // Read bootstrap prompt
        var bootstrapPath = path.join(pickupBundlePath, "bootstrap-prompt.txt");
        var bootstrap = "";
        try {
          bootstrap = fs.readFileSync(bootstrapPath, "utf8");
        } catch (bsErr) {}

        // Read manifest for reply intent
        var pickupManifest = parseManifest(pickupBundlePath);

        // Write reply intent to fax directory root (parent of bundle folders)
        var intent = buildReplyIntent(pickupManifest, pickupFaxId);
        writeReplyIntent(faxDir, intent);

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

    // POST /api/launch-session
    if (pathname === "/api/launch-session") {
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      readBody(req).then(function (body) {
        try {
          var payload = JSON.parse(body);
          var tool = payload.tool;
          var mode = payload.mode;
          var sessionId = payload.sessionId || null;
          var prompt = payload.prompt || "";

          if (!tool || !mode) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "tool and mode are required" }));
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

          var child = spawn(cmd, cmdArgs, {
            detached: true,
            stdio: "ignore",
            shell: true,
          });
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
