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
  function handleRequest(req, res) {
    var parsed = url.parse(req.url, true);
    var pathname = parsed.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
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
        var faxId = payload.faxId;

        if (!question) {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing 'question' field" }));
          return;
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
        var events = Array.isArray(payload.events) ? payload.events : [];
        var turns = Array.isArray(payload.turns) ? payload.turns : [];
        var metadata = payload.metadata || {};

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
          // Use copilot-sdk for model call
          var sdk = await import("@github/copilot-sdk");
          var session = new sdk.Session({
            streaming: true,
            systemMessage: {
              mode: "replace",
              content: prompt.system || "You are a helpful assistant that answers questions about fax context bundles and coding sessions.",
            },
          });

          var stream = session.sendMessage(prompt.user || question);
          var fullAnswer = "";

          for await (var chunk of stream) {
            if (chunk && chunk.content) {
              fullAnswer += chunk.content;
              sseSend({ type: "chunk", content: chunk.content });
            }
          }

          sseSend({
            type: "done",
            answer: fullAnswer,
            model: "copilot",
            references: [],
          });
        } catch (modelError) {
          sseSend({
            type: "error",
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
