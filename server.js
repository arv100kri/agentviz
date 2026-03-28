/**
 * AGENTVIZ local server.
 * Serves dist/ as a static SPA and provides:
 *   GET /api/file   -- returns the watched session file as text
 *   GET /api/meta   -- returns { filename } JSON
 *   GET /api/stream -- SSE endpoint, pushes new JSONL lines as the file grows
 */

import http from "http";
import fs from "fs";
import os from "os";
import path from "path";
import url from "url";
import { runCoachAgent } from "./src/lib/aiCoachAgent.js";
import { buildQAContext, buildQAPrompt } from "./src/lib/sessionQA.js";
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export function getCompleteJsonlLines(content) {
  if (!content) return [];
  var normalized = content.replace(/\r\n/g, "\n");
  var hasTrailingNewline = normalized.endsWith("\n");
  var lines = normalized.split("\n");

  if (!hasTrailingNewline) {
    lines.pop();
  }

  return lines.filter(function (line) { return line.trim(); });
}

export function getJsonlStreamChunk(content, lastLineIdx) {
  var completeLines = getCompleteJsonlLines(content);

  if (completeLines.length <= lastLineIdx) {
    return { lines: [], nextLineIdx: lastLineIdx };
  }

  return {
    lines: completeLines.slice(lastLineIdx),
    nextLineIdx: completeLines.length,
  };
}

export function buildQASessionConfig(promptSystem, onPermissionRequest) {
  return {
    onPermissionRequest: onPermissionRequest,
    streaming: true,
    systemMessage: {
      mode: "replace",
      content: promptSystem,
    },
  };
}

export function getSessionQAHistoryFilePath(homeDir) {
  return path.join(homeDir || os.homedir(), ".agentviz", "session-qa-history.json");
}

export function sanitizeSessionQAMessages(messages) {
  return Array.isArray(messages) ? messages
    .filter(function (message) {
      return message && typeof message.role === "string" &&
        typeof message.content === "string" &&
        (message.content || message.role !== "assistant");
    })
    .map(function (message) {
      return {
        role: message.role,
        content: message.content,
        references: Array.isArray(message.references) ? message.references : [],
      };
    }) : [];
}

export function sanitizeSessionQAHistoryEntry(entry) {
  return {
    messages: sanitizeSessionQAMessages(entry && entry.messages),
    responseModel: entry && entry.responseModel ? String(entry.responseModel) : null,
    qaSessionId: entry && entry.qaSessionId ? String(entry.qaSessionId) : null,
    updatedAt: new Date().toISOString(),
  };
}

export function readSessionQAHistoryStore(filePath, fsModule) {
  var targetFs = fsModule || fs;
  try {
    var raw = targetFs.readFileSync(filePath, "utf8");
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { version: 1, sessions: {} };
    return {
      version: 1,
      sessions: parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {},
    };
  } catch (error) {
    return { version: 1, sessions: {} };
  }
}

export function writeSessionQAHistoryStore(filePath, store, fsModule) {
  var targetFs = fsModule || fs;
  targetFs.mkdirSync(path.dirname(filePath), { recursive: true });
  targetFs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf8");
}

export function getSessionQAHistoryEntry(filePath, sessionKey, fsModule) {
  if (!sessionKey) return null;
  var store = readSessionQAHistoryStore(filePath, fsModule);
  return store.sessions[sessionKey] || null;
}

export function saveSessionQAHistoryEntry(filePath, sessionKey, entry, fsModule) {
  if (!sessionKey) return null;
  var store = readSessionQAHistoryStore(filePath, fsModule);
  store.sessions[sessionKey] = sanitizeSessionQAHistoryEntry(entry);
  writeSessionQAHistoryStore(filePath, store, fsModule);
  return store.sessions[sessionKey];
}

export function removeSessionQAHistoryEntry(filePath, sessionKey, fsModule) {
  if (!sessionKey) return false;
  var store = readSessionQAHistoryStore(filePath, fsModule);
  if (!Object.prototype.hasOwnProperty.call(store.sessions, sessionKey)) return false;
  delete store.sessions[sessionKey];
  writeSessionQAHistoryStore(filePath, store, fsModule);
  return true;
}

export function getQAEventText(data, isDelta) {
  if (!data) return "";
  if (isDelta && typeof data.deltaContent === "string") return data.deltaContent;
  if (typeof data.text === "string") return data.text;
  if (typeof data.content === "string") return data.content;
  if (Array.isArray(data.content)) {
    return data.content.map(function (item) {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      return item.text || item.content || "";
    }).join("");
  }
  if (data.content && typeof data.content === "object") {
    return data.content.text || data.content.content || "";
  }
  if (typeof data.deltaContent === "string") return data.deltaContent;
  return "";
}

export function getQAToolName(data) {
  if (!data || typeof data !== "object") return "";
  return data.toolName || data.name || (data.tool && data.tool.name) ||
    (data.invocation && data.invocation.toolName) || "";
}

export function describeQAToolStatus(toolName, phase) {
  var name = String(toolName || "").trim();
  var lower = name.toLowerCase();
  if (!lower) {
    return phase === "complete" ? "Analyzing tool results..." : "Running tools...";
  }
  if (lower === "view" || lower === "read" || lower === "grep" || lower === "rg" || lower === "search_code") {
    return phase === "complete" ? "Analyzing search results..." : "Searching the session...";
  }
  if (lower.indexOf("kusto") !== -1) {
    return phase === "complete" ? "Analyzing Kusto results..." : "Running Kusto queries...";
  }
  if (lower === "powershell" || lower === "bash" || lower === "terminal") {
    return phase === "complete" ? "Analyzing command output..." : "Running shell commands...";
  }
  return phase === "complete" ? "Analyzing " + name + " results..." : "Running " + name + "...";
}

function serveStatic(res, filePath) {
  try {
    var data = fs.readFileSync(filePath);
    var ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end("Not found");
  }
}

export function createServer({ sessionFile, distDir }) {
  var clients = new Set();
  var lastLineIdx = 0;
  var watcher = null;
  var watcherClosed = false;
  var pollInterval = null;

  function broadcastNewLines() {
    if (!sessionFile || clients.size === 0) return;
    try {
      var content = fs.readFileSync(sessionFile, "utf8");
      var update = getJsonlStreamChunk(content, lastLineIdx);
      var newLines = update.lines;
      lastLineIdx = update.nextLineIdx;
      if (newLines.length === 0) return;
      var payload = "data: " + JSON.stringify({ lines: newLines.join("\n") }) + "\n\n";
      for (var client of clients) {
        try { client.write(payload); } catch (e) { clients.delete(client); }
      }
    } catch (e) {}
  }

  if (sessionFile) {
    // Initialize from complete newline-terminated records only so a trailing
    // in-progress JSONL record can still be streamed once it is finished.
    try {
      var initContent = fs.readFileSync(sessionFile, "utf8");
      lastLineIdx = getCompleteJsonlLines(initContent).length;
    } catch (e) {}

    function attachWatcher() {
      try {
        watcher = fs.watch(sessionFile, function (eventType) {
          // macOS fs.watch fires "rename" for appends on some file systems / write patterns
          // (e.g. atomic write-then-rename). Accept both event types.
          if (eventType === "change" || eventType === "rename") {
            broadcastNewLines();
            // After a rename the inode may have changed, so the current watcher
            // may stop receiving events. Re-attach on the next tick so we keep
            // following the path rather than the old inode.
            if (eventType === "rename") {
              try { watcher.close(); } catch (e) {}
              setTimeout(function () {
                if (watcherClosed) return;
                // Only re-attach if the file still exists at the same path.
                try { fs.accessSync(sessionFile); } catch (e) { return; }
                attachWatcher();
              }, 50);
            }
          }
        });
        watcher.on("error", function (err) {
          process.stderr.write("AGENTVIZ: file watcher error: " + (err && err.message || err) + "\n");
          // Notify connected SSE clients so the UI can show the stream as disconnected
          var errPayload = "data: " + JSON.stringify({ error: "watcher_error" }) + "\n\n";
          for (var client of clients) {
            try { client.write(errPayload); } catch (e) { clients.delete(client); }
          }
        });
      } catch (e) {}
    }

    attachWatcher();

    // Polling fallback: macOS kqueue (used by fs.watch) coalesces or drops
    // events when a file is written to rapidly. Poll every 500ms so we never
    // miss new lines regardless of write pattern.
    pollInterval = setInterval(broadcastNewLines, 500);
  }

  var server = http.createServer(function (req, res) {
    try {
      handleRequest(req, res);
    } catch (err) {
      process.stderr.write("[agentviz] unhandled request error: " + req.url + "\n" + (err.stack || err.message) + "\n");
      try {
        if (!res.headersSent) { res.writeHead(500); res.end("Internal server error"); }
      } catch (e2) {}
    }
  });

  function handleRequest(req, res) {
    var parsed = url.parse(req.url, true);
    var pathname = parsed.pathname;

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (pathname === "/api/config") {
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "GET") {
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      var CONFIG_SURFACES = [
        { id: "claude-md",            path: "CLAUDE.md",                       glob: null,         skillDirs: false },
        { id: "copilot-instructions", path: ".github/copilot-instructions.md", glob: null,         skillDirs: false },
        { id: "agents-md",            path: "AGENTS.md",                       glob: null,         skillDirs: false },
        { id: "claude-agents",        path: ".claude/agents",                  glob: ".md",        skillDirs: false },
        { id: "claude-commands",      path: ".claude/commands",                glob: ".md",        skillDirs: false },
        { id: "claude-rules",         path: ".claude/rules",                   glob: ".md",        skillDirs: false },
        { id: "claude-skills",        path: ".claude/skills",                  glob: null,         skillDirs: false },
        { id: "mcp-json",             path: ".mcp.json",                       glob: null,         skillDirs: false },
        { id: "claude-settings",      path: ".claude/settings.json",           glob: null,         skillDirs: false },
        { id: "github-prompts",       path: ".github/prompts",                 glob: ".prompt.md", skillDirs: false },
        { id: "github-skills",        path: ".github/skills",                  glob: null,         skillDirs: true  },
        { id: "github-extensions",    path: ".github/extensions",              glob: ".yml",       skillDirs: false },
      ];

      var cwd = process.cwd();
      var configResults = CONFIG_SURFACES.map(function (surface) {
        var resolvedPath = path.resolve(cwd, surface.path);

        // Skills directory: each skill is a subdirectory containing SKILL.md
        if (surface.skillDirs) {
          try {
            var skillEntries = [];
            var subdirs = fs.readdirSync(resolvedPath, { withFileTypes: true });
            for (var si = 0; si < subdirs.length; si++) {
              if (!subdirs[si].isDirectory()) continue;
              var skillFile = path.join(resolvedPath, subdirs[si].name, "SKILL.md");
              try {
                var skillContent = fs.readFileSync(skillFile, "utf8");
                skillEntries.push({ path: path.join(surface.path, subdirs[si].name, "SKILL.md"), content: skillContent });
              } catch (e2) {}
            }
            return { id: surface.id, path: surface.path, exists: true, entries: skillEntries };
          } catch (e) {
            return { id: surface.id, path: surface.path, exists: false, entries: [] };
          }
        }

        // Regular directory surface
        if (surface.glob !== null) {
          try {
            var entries = [];
            var dirEntries = fs.readdirSync(resolvedPath);
            var ext = surface.glob.replace(/^\*/, "");
            for (var di = 0; di < dirEntries.length; di++) {
              var entryName = dirEntries[di];
              if (!entryName.endsWith(ext)) continue;
              try {
                var entryPath = path.join(surface.path, entryName);
                var entryContent = fs.readFileSync(path.resolve(cwd, entryPath), "utf8");
                entries.push({ path: entryPath, content: entryContent });
              } catch (e2) {}
            }
            return { id: surface.id, path: surface.path, exists: true, entries: entries };
          } catch (e) {
            return { id: surface.id, path: surface.path, exists: false, entries: [] };
          }
        }

        // Single file surface
        try {
          var fileContent = fs.readFileSync(resolvedPath, "utf8");
          // For .mcp.json, also extract server names for convenience
          var extra = {};
          if (surface.id === "mcp-json") {
            try {
              var mcpParsed = JSON.parse(fileContent);
              extra.mcpServers = Object.keys(mcpParsed.mcpServers || mcpParsed.servers || {});
            } catch (pe) {}
          }
          return Object.assign({ id: surface.id, path: surface.path, exists: true, content: fileContent }, extra);
        } catch (e) {
          return { id: surface.id, path: surface.path, exists: false, content: null };
        }
      });

      res.writeHead(200);
      res.end(JSON.stringify(configResults));
      return;
    }

    // Read a single file for preview before applying
    if (pathname === "/api/read-file") {
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "GET") { res.writeHead(405); res.end(JSON.stringify({ error: "Method not allowed" })); return; }
      var qFilePath = parsedUrl.query.path || "";
      if (!qFilePath) { res.writeHead(400); res.end(JSON.stringify({ error: "path is required" })); return; }
      try {
        var qCwd = process.cwd();
        var qResolved = path.resolve(qCwd, qFilePath);
        if (!qResolved.startsWith(qCwd + path.sep) && qResolved !== qCwd) {
          res.writeHead(400); res.end(JSON.stringify({ error: "Path outside project" })); return;
        }
        var qContent = null;
        try { qContent = fs.readFileSync(qResolved, "utf8"); } catch (e) {}
        res.writeHead(200);
        res.end(JSON.stringify({ exists: qContent !== null, content: qContent }));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    if (pathname === "/api/apply") {
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "POST") {
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", function () {
        try {
          var payload = JSON.parse(body);
          // Accept both 'relativePath' (static recs) and 'path' (AI recs)
          var relativePath = payload.relativePath || payload.path;
          var content = payload.content;
          var mode = payload.mode || "auto"; // "auto"|"append"|"merge"|"overwrite"
          if (typeof relativePath !== "string" || !relativePath) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "path is required" }));
            return;
          }
          if (typeof content !== "string") {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "content is required" }));
            return;
          }
          var cwd = process.cwd();
          var resolvedPath = path.resolve(cwd, relativePath);
          if (!resolvedPath.startsWith(cwd + path.sep) && resolvedPath !== cwd) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: "Path outside project directory" }));
            return;
          }
          var parentDir = path.dirname(resolvedPath);
          fs.mkdirSync(parentDir, { recursive: true });
          var fileExists = false;
          var originalContent = null;
          try { originalContent = fs.readFileSync(resolvedPath, "utf8"); fileExists = true; } catch (e) {}

          if (!fileExists || mode === "overwrite") {
            fs.writeFileSync(resolvedPath, content, "utf8");
          } else if (relativePath.endsWith(".mcp.json") || relativePath === ".mcp.json") {
            // Smart merge: merge mcpServers objects
            try {
              var existing = JSON.parse(originalContent);
              var incoming = JSON.parse(content);
              var merged = Object.assign({}, existing);
              if (incoming.mcpServers) {
                merged.mcpServers = Object.assign({}, existing.mcpServers || {}, incoming.mcpServers);
              }
              fs.writeFileSync(resolvedPath, JSON.stringify(merged, null, 2), "utf8");
            } catch (e) {
              fs.appendFileSync(resolvedPath, "\n\n" + content, "utf8");
            }
          } else if (mode === "append" || relativePath.endsWith(".md")) {
            fs.appendFileSync(resolvedPath, "\n\n" + content, "utf8");
          } else {
            fs.appendFileSync(resolvedPath, "\n\n---\n\n" + content, "utf8");
          }
          res.writeHead(200);
          // Return original content so the client can offer a revert
          res.end(JSON.stringify({ success: true, path: resolvedPath, originalContent: originalContent }));
        } catch (e) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message || "Internal server error" }));
        }
      });
      return;
    }

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
        var deleteSessionKey = parsed.query.sessionKey || "";
        if (!deleteSessionKey) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "sessionKey is required" }));
          return;
        }
        removeSessionQAHistoryEntry(qaHistoryFile, deleteSessionKey);
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        return;
      }

      if (req.method !== "POST") {
        res.writeHead(405);
        res.end(JSON.stringify({ error: "Method not allowed" }));
        return;
      }

      var qaHistoryBody = "";
      req.on("data", function (chunk) { qaHistoryBody += chunk; });
      req.on("end", function () {
        try {
          var historyPayload = JSON.parse(qaHistoryBody || "{}");
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
      });
      return;
    }

    if (pathname === "/api/qa") {
      if (req.method !== "POST") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(405); res.end(JSON.stringify({ error: "Method not allowed" })); return;
      }
      var qaBody = "";
      req.on("data", function (chunk) { qaBody += chunk; });
      req.on("end", async function () {
        // SSE streaming response
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.writeHead(200);

        function sseSend(data) {
          if (!res.writableEnded) res.write("data: " + JSON.stringify(data) + "\n\n");
        }
        try {
          var payload = JSON.parse(qaBody);
          var question = payload.question;
          var events = payload.events || [];
          var turns = payload.turns || [];
          var metadata = payload.metadata || {};
          var requestedModel = payload.model || null;
          var qaSessionId = payload.qaSessionId || null;
          var sessionFilePath = payload.sessionFilePath || null;

          if (!question) {
            sseSend({ error: "Missing 'question' field" });
            if (!res.writableEnded) res.end();
            return;
          }

          var lastStatus = null;
          function sendStatus(status) {
            if (!status || status === lastStatus) return;
            lastStatus = status;
            sseSend({ status: status });
          }

          sendStatus("Preparing session context...");
          var context = buildQAContext(events, turns, metadata);
          var prompt = buildQAPrompt(question, context, { sessionFilePath: sessionFilePath });

          var { CopilotClient, approveAll } = await import("@github/copilot-sdk");
          var client = new CopilotClient();
          var answer = "";
          var returnedSessionId = qaSessionId;

          try {
            await client.start();

            var session;
            if (qaSessionId) {
              sendStatus("Resuming previous Q&A session...");
              try {
                session = await client.resumeSession(
                  qaSessionId,
                  buildQASessionConfig(prompt.system, approveAll)
                );
              } catch (resumeErr) {
                session = null;
              }
            }

            if (!session) {
              sendStatus("Starting Q&A session...");
              var sessionOpts = buildQASessionConfig(prompt.system, approveAll);
              if (requestedModel) sessionOpts.model = requestedModel;
              session = await client.createSession(sessionOpts);
              returnedSessionId = session.sessionId;
            }

            // Abort on client disconnect
            res.on("close", function () {
              session && session.abort && session.abort().catch(function () {});
            });

            // Send the question and stream deltas back via SSE
            await new Promise(function (resolve, reject) {
              var done = false;
              var sawDelta = false;
              var unsubscribe = session.on(function (event) {
                if (done) return;
                if (event.type === "session.idle") {
                  done = true;
                  unsubscribe();
                  resolve();
                } else if (event.type === "session.error") {
                  done = true;
                  unsubscribe();
                  reject(new Error(event.data && event.data.message ? event.data.message : "Session error"));
                } else if (event.type === "tool.execution_start") {
                  sendStatus(describeQAToolStatus(getQAToolName(event.data), "start"));
                } else if (event.type === "tool.execution_complete" && !sawDelta) {
                  sendStatus(describeQAToolStatus(getQAToolName(event.data), "complete"));
                } else if (event.type === "assistant.reasoning_delta" && !sawDelta) {
                  sendStatus("Thinking through the session...");
                } else if (event.type === "assistant.message_delta" || event.type === "assistant.message.delta") {
                  var delta = getQAEventText(event.data, true);
                  if (delta) {
                    sawDelta = true;
                    answer += delta;
                    sendStatus("Streaming answer...");
                    sseSend({ delta: delta });
                  }
                } else if (event.type === "assistant.message") {
                  var text = getQAEventText(event.data, false);
                  if (text) {
                    answer = text;
                    if (!sawDelta) {
                      sendStatus("Streaming answer...");
                      sseSend({ delta: text });
                    }
                  }
                }
              });
              sendStatus(sessionFilePath ? "Ready to inspect the raw session file..." : "Sending your question to the model...");
              session.send({ prompt: "[AGENTVIZ-QA] " + prompt.user }).catch(function (err) {
                if (!done) { done = true; unsubscribe(); reject(err); }
              });
            });

            await session.disconnect();
          } finally {
            await client.stop().catch(function () {});
          }

          // Extract turn references from the answer
          var references = [];
          var refRegex = /\[Turn (\d+)\]/g;
          var refMatch;
          while ((refMatch = refRegex.exec(answer)) !== null) {
            var turnIdx = parseInt(refMatch[1], 10);
            if (!references.some(function (r) { return r.turnIndex === turnIdx; })) {
              references.push({ turnIndex: turnIdx });
            }
          }

          var modelLabel = requestedModel || "default";
          sseSend({ done: true, answer: answer, references: references, model: modelLabel, qaSessionId: returnedSessionId });
          if (!res.writableEnded) res.end();
        } catch (e) {
          sseSend({ error: e.message || "Q&A failed" });
          if (!res.writableEnded) res.end();
        }
      });
      return;
    }

    if (pathname === "/api/coach/analyze") {
      if (req.method !== "POST") {
        res.setHeader("Content-Type", "application/json");
        res.writeHead(405); res.end(JSON.stringify({ error: "Method not allowed" })); return;
      }
      var coachBody = "";
      req.on("data", function (chunk) { coachBody += chunk; });
      req.on("end", async function () {
        var abort = new AbortController();
        // res.on("close") fires when the client drops the connection (e.g. navigates away)
        // req.on("close") fires too early when POST body is consumed -- do NOT use for SSE
        res.on("close", function () { abort.abort(); });

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.writeHead(200);

        function sseEvent(data) {
          if (!res.writableEnded) res.write("data: " + JSON.stringify(data) + "\n\n");
        }

        // Provide the agent with a readConfigFile function backed by disk
        var cwd = process.cwd();
        function readConfigFile(filePath) {
          try {
            var resolved = path.resolve(cwd, filePath);
            // Security: must stay within cwd
            if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) return null;
            var stat = fs.statSync(resolved);
            if (stat.isDirectory()) {
              // Return listing for directories
              var entries = fs.readdirSync(resolved);
              return "Directory listing:\n" + entries.join("\n");
            }
            return fs.readFileSync(resolved, "utf8");
          } catch (e) {
            return null;
          }
        }

        try {
          var payload = JSON.parse(coachBody);

          var result = await runCoachAgent(payload, {
            signal: abort.signal,
            readConfigFile: readConfigFile,
            onStep: function (step) { sseEvent({ step: step }); },
          });

          sseEvent({ done: true, result: result });
          if (!res.writableEnded) res.end();
        } catch (e) {
          if (e.name === "AbortError") { if (!res.writableEnded) res.end(); return; }
          sseEvent({ error: e.message || "AI analysis failed" });
          if (!res.writableEnded) res.end();
        }
      });
      return;
    }

    if (pathname === "/api/sessions") {
      res.setHeader("Content-Type", "application/json");
      if (req.method !== "GET") { res.writeHead(405); res.end(JSON.stringify({ error: "Method not allowed" })); return; }

      var homeDir = process.env.HOME || process.env.USERPROFILE || "";
      var results = [];

      // Claude Code: ~/.claude/projects/{project-dir}/{session-uuid}.jsonl
      var claudeRoot = path.join(homeDir, ".claude", "projects");
      function decodeProjectDir(dirName) {
        return (dirName || "").replace(/^-/, "").replace(/-/g, "/");
      }
      function projectLabel(dirName) {
        var parts = decodeProjectDir(dirName).split("/").filter(Boolean);
        return parts[parts.length - 1] || dirName;
      }
      try {
        fs.readdirSync(claudeRoot).forEach(function (projectDirName) {
          var projectPath = path.join(claudeRoot, projectDirName);
          try {
            if (!fs.statSync(projectPath).isDirectory()) return;
            fs.readdirSync(projectPath).forEach(function (fname) {
              if (!fname.endsWith(".jsonl")) return;
              var filePath = path.join(projectPath, fname);
              try {
                var stat = fs.statSync(filePath);
                results.push({ id: "claude-code:" + projectDirName + ":" + fname, path: filePath, filename: fname, project: projectLabel(projectDirName), projectDir: projectDirName, format: "claude-code", size: stat.size, mtime: stat.mtime.toISOString() });
              } catch (e) {}
            });
          } catch (e) {}
        });
      } catch (e) {}

      // Copilot CLI: ~/.copilot/session-state/{uuid}/events.jsonl (flat -- one file per session dir)
      var copilotRoot = path.join(homeDir, ".copilot", "session-state");
      try {
        fs.readdirSync(copilotRoot).forEach(function (sessionDirName) {
          var sessionDir = path.join(copilotRoot, sessionDirName);
          var eventsFile = path.join(sessionDir, "events.jsonl");
          try {
            var stat = fs.statSync(eventsFile);
            // Read workspace.yaml for rich label (summary, repo, branch)
            var label = sessionDirName.substring(0, 8);
            var repo = null;
            var branch = null;
            var summary = null;
            try {
              var yamlText = fs.readFileSync(path.join(sessionDir, "workspace.yaml"), "utf8");
              // Handle both inline summary and YAML block scalar (summary: |-)
              var inlineMatch = yamlText.match(/^summary:\s+(?!\|-\s*$)(.+)$/m);
              var blockMatch = yamlText.match(/^summary:\s*\|-\s*\n([ \t]+)(.+)$/m);
              var repoMatch = yamlText.match(/^repository:\s*(.+)$/m);
              var branchMatch = yamlText.match(/^branch:\s*(.+)$/m);
              if (inlineMatch && inlineMatch[1].trim()) {
                summary = inlineMatch[1].trim();
              } else if (blockMatch && blockMatch[2].trim()) {
                summary = blockMatch[2].trim();
              }
              if (repoMatch) repo = repoMatch[1].trim();
              if (branchMatch) branch = branchMatch[1].trim();

              // Filter out AI coach and Q&A subprocess sessions:
              // These are spawned by AGENTVIZ itself and should not appear in the inbox.
              if (summary && (
                summary.startsWith("Analyze this") ||
                (summary.includes("Session stats") && summary.includes("read_config")) ||
                summary.includes("SESSION DATA:") ||
                summary.includes("SESSION OVERVIEW") ||
                summary.includes("You are an AI assistant that answers questions about a coding session") ||
                summary.includes("[AGENTVIZ-QA]")
              )) {
                return; // skip
              }

              if (summary) label = summary;
            } catch (e) {}
            results.push({ id: "copilot-cli:" + sessionDirName + ":events.jsonl", path: eventsFile, filename: "events.jsonl", project: label, projectDir: sessionDirName, sessionId: sessionDirName, repository: repo, branch: branch, summary: summary, format: "copilot-cli", size: stat.size, mtime: stat.mtime.toISOString() });
          } catch (e) {}
        });
      } catch (e) {}

      results.sort(function (a, b) { return new Date(b.mtime) - new Date(a.mtime); });
      res.writeHead(200);
      res.end(JSON.stringify(results));
      return;
    }

    if (pathname === "/api/session") {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      if (req.method !== "GET") { res.writeHead(405); res.end("Method not allowed"); return; }
      var sessionPath = parsed.query.path;
      if (!sessionPath) { res.writeHead(400); res.end("Missing path"); return; }

      // Security: only serve files under HOME directory
      var homeDir2 = process.env.HOME || process.env.USERPROFILE || "";
      var resolvedSessionPath = path.resolve(sessionPath);
      if (!homeDir2 || !resolvedSessionPath.startsWith(homeDir2 + path.sep)) {
        res.writeHead(403); res.end("Forbidden"); return;
      }
      // Only serve .jsonl files
      if (!resolvedSessionPath.endsWith(".jsonl")) {
        res.writeHead(400); res.end("Only .jsonl files are served"); return;
      }
      try {
        var sessionText = fs.readFileSync(resolvedSessionPath, "utf8");
        res.writeHead(200);
        res.end(sessionText);
      } catch (e) {
        res.writeHead(404); res.end("Not found");
      }
      return;
    }

    if (pathname === "/api/file") {
      if (!sessionFile) { res.writeHead(404); res.end("No session file"); return; }
      try {
        var text = fs.readFileSync(sessionFile, "utf8");
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(text);
      } catch (e) {
        res.writeHead(500);
        res.end(e.message);
      }
      return;
    }

    if (pathname === "/api/meta") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        filename: sessionFile ? path.basename(sessionFile) : null,
        path: sessionFile || null,
        live: Boolean(sessionFile),
      }));
      return;
    }

    if (pathname === "/api/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      res.write("retry: 3000\n\n");
      clients.add(res);
      req.on("close", function () { clients.delete(res); });
      return;
    }

    // Static file serving
    var filePath = pathname === "/" || pathname === "/index.html"
      ? path.join(distDir, "index.html")
      : path.join(distDir, pathname);

    // Prevent directory traversal
    if (!filePath.startsWith(distDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    try {
      var stat = fs.statSync(filePath);
      if (stat.isFile()) {
        serveStatic(res, filePath);
      } else {
        serveStatic(res, path.join(distDir, "index.html"));
      }
    } catch (e) {
      // SPA fallback
      serveStatic(res, path.join(distDir, "index.html"));
    }
  } // end handleRequest

  server.on("close", function () {
    watcherClosed = true;
    if (watcher) watcher.close();
    if (pollInterval) clearInterval(pollInterval);
  });

  server.on("error", function (err) {
    process.stderr.write("[agentviz] server error: " + err.message + "\n" + (err.stack || "") + "\n");
  });

  return server;
}
