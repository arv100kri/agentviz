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
import {
  buildQAContext,
  buildQAPrompt,
  buildSessionQAArtifacts,
  compileSessionQAQueryProgram,
  routeSessionQAQuestion,
} from "./src/lib/sessionQA.js";

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
  var sessionQACache = {};

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
        res.end(JSON.stringify({ session: sessionQACache[cacheKey] || null }));
        return;
      }

      if (req.method === "DELETE") {
        var delKey = parsed.query.sessionKey || "";
        delete sessionQACache[delKey];
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
            sessionQACache[payload.sessionKey] = {
              events: payload.events || [],
              turns: payload.turns || [],
              metadata: payload.metadata || {},
              sessionFilePath: payload.sessionFilePath || null,
              rawText: payload.rawText || null,
              updatedAt: new Date().toISOString(),
            };
            res.writeHead(200);
            res.end(JSON.stringify({
              success: true,
              sessionKey: payload.sessionKey,
              updatedAt: sessionQACache[payload.sessionKey].updatedAt,
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

    // Session Q&A history: persists conversation history (stub)
    if (pathname === "/api/session-qa-history") {
      res.setHeader("Content-Type", "application/json");

      if (req.method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify({ history: null }));
        return;
      }

      if (req.method === "POST" || req.method === "DELETE") {
        readBody(req).then(function () {
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
        }).catch(function () {
          res.writeHead(200);
          res.end(JSON.stringify({ success: true }));
        });
        return;
      }

      res.writeHead(405);
      res.end(JSON.stringify({ error: "Method not allowed" }));
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

        if (!question) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing 'question' field" }));
          return;
        }

        // Resolve session from cache (lean payload) or from the request body
        var resolvedSession = null;
        if (sessionKey && sessionQACache[sessionKey]) {
          resolvedSession = sessionQACache[sessionKey];
        } else if (Array.isArray(payload.events) && payload.events.length > 0) {
          resolvedSession = {
            events: payload.events,
            turns: payload.turns || [],
            metadata: payload.metadata || {},
          };
        }

        // Extract faxId from sessionKey (format: "fax:<faxId>")
        var faxId = null;
        if (sessionKey && sessionKey.startsWith("fax:")) {
          faxId = sessionKey.substring(4);
        }

        // Build fax context from bundle markdown files
        var faxContext = "";
        if (faxId) {
          var bundlePath = path.join(faxDir, faxId);
          if (bundlePath.startsWith(faxDir)) {
            var mdFiles = readBundleMarkdownFiles(bundlePath);
            if (mdFiles.length > 0) {
              faxContext = "\n\n--- FAX BUNDLE CONTEXT ---\n\n";
              for (var i = 0; i < mdFiles.length; i++) {
                faxContext += "## " + mdFiles[i].name + "\n\n" + mdFiles[i].content + "\n\n";
              }
              faxContext += "--- END FAX BUNDLE CONTEXT ---\n\n";
            }
          }
        }

        // Build Q&A context from session events if available
        var events = resolvedSession ? resolvedSession.events : [];
        var turns = resolvedSession ? resolvedSession.turns : [];
        var metadata = resolvedSession ? resolvedSession.metadata : {};

        var sessionContext = "";
        if (events.length > 0) {
          try {
            sessionContext = buildQAContext(events, turns, metadata, { question: question });
          } catch (e) {
            sessionContext = "";
          }
        }

        var fullContext = faxContext + sessionContext;
        var prompt = buildQAPrompt(question, fullContext, { sessionFilePath: null });

        // Stream the response
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.writeHead(200);

        function sseSend(data) {
          if (!res.writableEnded) res.write("data: " + JSON.stringify(data) + "\n\n");
        }

        try {
          var sdk = await import("@github/copilot-sdk");
          var CopilotClient = sdk.CopilotClient;
          var approveAll = sdk.approveAll;
          var client = new CopilotClient();
          var answer = "";

          await client.start();

          var qaSessionConfig = {
            onPermissionRequest: approveAll,
            streaming: true,
            systemMessage: {
              mode: "replace",
              content: prompt.system || "You are a helpful assistant that answers questions about fax context bundles and coding sessions.",
            },
          };

          var qaSession = await client.createSession(qaSessionConfig);

          // Abort on client disconnect
          res.on("close", function () {
            qaSession && qaSession.abort && qaSession.abort().catch(function () {});
          });

          await new Promise(function (resolve, reject) {
            var done = false;
            var unsubscribe = qaSession.on(function (event) {
              if (done) return;
              if (event.type === "session.idle") {
                done = true;
                unsubscribe();
                resolve();
              } else if (event.type === "session.error") {
                done = true;
                unsubscribe();
                reject(new Error(event.data && event.data.message ? event.data.message : "Session error"));
              } else if (event.type === "assistant.message_delta" || event.type === "assistant.message.delta") {
                var delta = event.data && (event.data.text || event.data.content || "");
                if (delta) {
                  answer += delta;
                  sseSend({ delta: delta });
                }
              } else if (event.type === "assistant.message") {
                var text = event.data && (event.data.text || event.data.content || "");
                if (text && !answer) {
                  answer = text;
                  sseSend({ delta: text });
                }
              }
            });

            qaSession.send({ prompt: prompt.user || question }).catch(function (err) {
              if (!done) { done = true; unsubscribe(); reject(err); }
            });
          });

          await qaSession.disconnect();
          await client.stop().catch(function () {});

          sseSend({
            done: true,
            answer: answer,
            model: "copilot",
            references: [],
          });
        } catch (modelError) {
          sseSend({
            error: modelError.message || "Model call failed",
          });
        }

        res.end();
      }).catch(function (e) {
        res.setHeader("Content-Type", "application/json");
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
