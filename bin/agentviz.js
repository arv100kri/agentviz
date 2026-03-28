#!/usr/bin/env node
/**
 * CLI entry point: npx agentviz [session.jsonl]
 * Builds the SPA (if dist/ not found), starts the local server, and opens the browser.
 */

import { createServer } from "../server.js";
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import net from "net";

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var rootDir = path.resolve(__dirname, "..");
var distDir = path.join(rootDir, "dist");
var LOG_FILE = path.join(rootDir, "agentviz-server.log");

function log(msg) {
  var line = new Date().toISOString() + " " + msg + "\n";
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

process.on("uncaughtException", function (err) {
  var msg = "[crash] uncaughtException: " + (err && err.stack ? err.stack : String(err));
  log(msg);
  // Don't exit -- keep the server alive if possible
});

process.on("unhandledRejection", function (reason) {
  var msg = "[crash] unhandledRejection: " + (reason && reason.stack ? reason.stack : String(reason));
  log(msg);
});

// -- Resolve session file from argv --
// Accepts a .jsonl file path or a directory (picks the most recently modified .jsonl inside it).
function findLatestJsonl(dir) {
  var best = null;
  var bestMtime = 0;
  try {
    var entries = fs.readdirSync(dir);
    for (var i = 0; i < entries.length; i++) {
      if (!entries[i].endsWith(".jsonl")) continue;
      var full = path.join(dir, entries[i]);
      try {
        var mtime = fs.statSync(full).mtimeMs;
        if (mtime > bestMtime) { bestMtime = mtime; best = full; }
      } catch (e) {}
    }
  } catch (e) {}
  return best;
}

var sessionFile = null;
var noOpen = false;
var exportMode = false;
var digestMode = false;
var digestOutputPath = null;
var statsMode = false;
var outputPath = null;
var argv = process.argv.slice(2);
for (var i = 0; i < argv.length; i++) {
  var arg = argv[i];
  if (arg === "--no-open") { noOpen = true; continue; }
  if (arg === "--export") { exportMode = true; continue; }
  if (arg === "--digest") { digestMode = true; continue; }
  if (arg === "--stats") { statsMode = true; continue; }
  if ((arg === "-o" || arg === "--output") && i + 1 < argv.length) {
    outputPath = argv[++i]; continue;
  }
  if (!arg.startsWith("-")) {
    var resolved = path.resolve(arg);
    if (!fs.existsSync(resolved)) {
      process.stderr.write("Error: path not found: " + resolved + "\n");
      process.exit(1);
    }
    var stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      sessionFile = findLatestJsonl(resolved);
      if (!sessionFile) {
        process.stderr.write("Error: no .jsonl files found in " + resolved + "\n");
        process.exit(1);
      }
    } else {
      sessionFile = resolved;
    }
  }
}

// -- Find a free port starting from preferred --
function findFreePort(preferred, cb) {
  var server = net.createServer();
  server.listen(preferred, "127.0.0.1", function () {
    var port = server.address().port;
    server.close(function () { cb(null, port); });
  });
  server.on("error", function () {
    findFreePort(preferred + 1, cb);
  });
}

// -- Open browser (cross-platform) --
function openBrowser(url) {
  var platform = process.platform;
  var cmd = platform === "darwin" ? "open"
    : platform === "win32" ? "start"
    : "xdg-open";
  exec(cmd + " " + url, function () {});
}

// -- CLI output modes: stats, digest, export (can be combined) --
var cliMode = statsMode || digestMode || exportMode;

if (cliMode && !sessionFile) {
  var modeNames = [];
  if (statsMode) modeNames.push("--stats");
  if (digestMode) modeNames.push("--digest");
  if (exportMode) modeNames.push("--export");
  process.stderr.write("Error: " + modeNames.join(", ") + " requires a session file path.\n" +
    "Usage: agentviz [--stats] [--digest] [--export] <session.jsonl> [-o output.html]\n");
// -- Digest mode: generate structured markdown and exit --
if (digestMode) {
  if (!sessionFile) {
    process.stderr.write("Error: --digest requires a session file path.\n" +
      "Usage: agentviz --digest <session.jsonl> [-o session-digest.md]\n");
    process.exit(1);
  }

  // Dynamic import of the digest module (ESM)
  import("../src/lib/digestSession.js").then(function (mod) {
    var rawText = fs.readFileSync(sessionFile, "utf8");
    var sessionName = path.basename(sessionFile);
    var digest = mod.digestSession(rawText);
    var markdown = mod.formatDigestMarkdown(digest, sessionName);

    var outFile = outputPath
      ? path.resolve(outputPath)
      : path.resolve(sessionName.replace(/\.jsonl$/, "") + "-digest.md");

    fs.writeFileSync(outFile, markdown, "utf8");
    process.stdout.write("Digest: " + outFile + "\n");
    process.exit(0);
  }).catch(function (err) {
    process.stderr.write("Error generating digest: " + (err.message || err) + "\n");
    process.exit(1);
  });
} else {
// -- Stats mode: emit session telemetry as JSON and exit --
if (statsMode) {
  if (!sessionFile) {
    process.stderr.write("Error: --stats requires a session file path.\n" +
      "Usage: agentviz --stats <session.jsonl>\n");
    process.exit(1);
  }

  var statsRaw = fs.readFileSync(sessionFile, "utf8");
  var statsLines = statsRaw.split("\n").filter(function (l) { return l.trim(); });

  // Detect format
  var isCopilotCli = false;
  for (var si = 0; si < Math.min(statsLines.length, 5); si++) {
    if (statsLines[si].indexOf('"copilot-agent"') !== -1 ||
        statsLines[si].indexOf('"copilot_agent"') !== -1) {
      isCopilotCli = true;
      break;
    }
  }

  var totalTurns = 0;
  var totalToolCalls = 0;
  var errorCount = 0;
  var toolCounts = {};
  var inputTokens = 0;
  var outputTokens = 0;
  var cacheRead = 0;
  var cacheWrite = 0;
  var firstTimestamp = null;
  var lastTimestamp = null;
  var primaryModel = null;
  var modelCounts = {};
  var userTurnCount = 0;
  var totalCost = 0;

  for (var si = 0; si < statsLines.length; si++) {
    try {
      var record = JSON.parse(statsLines[si]);
    } catch (e) { continue; }

    // Extract timestamp for duration calculation
    var ts = record.timestamp || (record.data && record.data.timestamp);
    if (ts) {
      var tsMs = new Date(ts).getTime();
      if (!isNaN(tsMs)) {
        if (firstTimestamp === null || tsMs < firstTimestamp) firstTimestamp = tsMs;
        if (lastTimestamp === null || tsMs > lastTimestamp) lastTimestamp = tsMs;
      }
    }

    if (isCopilotCli) {
      var rtype = record.type || "";
      if (rtype === "assistant.turn_start") totalTurns++;
      if (rtype === "user.message") userTurnCount++;
      if (rtype === "tool.execution_start") {
        totalToolCalls++;
        var tn = record.data && record.data.toolName;
        if (tn) toolCounts[tn] = (toolCounts[tn] || 0) + 1;
      }
      if (rtype === "tool.execution_complete" && record.data && record.data.isError) {
        errorCount++;
      }
      if (rtype === "session.error") errorCount++;

      // Token usage from turn_end
      if (rtype === "assistant.turn_end" && record.data) {
        var usage = record.data.tokenUsage || record.data.usage;
        if (usage) {
          inputTokens += usage.inputTokens || usage.input_tokens || 0;
          outputTokens += usage.outputTokens || usage.output_tokens || 0;
          cacheRead += usage.cacheRead || usage.cache_read || 0;
          cacheWrite += usage.cacheWrite || usage.cache_write || 0;
        }
        var mdl = record.data.model;
        if (mdl) modelCounts[mdl] = (modelCounts[mdl] || 0) + 1;
      }

      // Copilot CLI cost from turn_end
      if (rtype === "assistant.turn_end" && record.data && record.data.cost != null) {
        totalCost += record.data.cost;
      }
    } else {
      // Claude Code format
      var ctype = record.type;
      if (ctype === "human" || ctype === "user") { userTurnCount++; totalTurns++; }
      if (ctype === "assistant" && record.message && record.message.content) {
        var content = record.message.content;
        if (Array.isArray(content)) {
          for (var ci = 0; ci < content.length; ci++) {
            var block = content[ci];
            if (block.type === "tool_use") {
              totalToolCalls++;
              var tname = block.name || "unknown";
              toolCounts[tname] = (toolCounts[tname] || 0) + 1;
            }
          }
        }
        // Model from assistant messages
        if (record.message && record.message.model) {
          var mdl = record.message.model;
          modelCounts[mdl] = (modelCounts[mdl] || 0) + 1;
        }
      }
      if (ctype === "tool_result" || ctype === "tool_output") {
        if (record.is_error || record.isError) errorCount++;
      }
      // Token usage from assistant message
      if (ctype === "assistant" && record.message && record.message.usage) {
        var usage = record.message.usage;
        inputTokens += usage.input_tokens || usage.inputTokens || 0;
        outputTokens += usage.output_tokens || usage.outputTokens || 0;
        cacheRead += usage.cache_read_input_tokens || usage.cacheRead || 0;
        cacheWrite += usage.cache_creation_input_tokens || usage.cacheWrite || 0;
      }
    }
  }

  // Determine primary model (most frequent)
  var maxModelCount = 0;
  for (var m in modelCounts) {
    if (modelCounts[m] > maxModelCount) {
      maxModelCount = modelCounts[m];
      primaryModel = m;
    }
  }

  // Compute cost for Claude Code format using pricing table
  if (!isCopilotCli && (inputTokens > 0 || outputTokens > 0) && primaryModel) {
    var PRICE_TABLE = [
      { match: "claude-opus-4",    input: 15.00, output: 75.00 },
      { match: "claude-sonnet-4",  input:  3.00, output: 15.00 },
      { match: "claude-haiku-4",   input:  0.80, output:  4.00 },
      { match: "claude-3-5-sonnet", input: 3.00, output: 15.00 },
      { match: "claude-3-5-haiku",  input: 0.80, output:  4.00 },
      { match: "claude-3-opus",     input: 15.00, output: 75.00 },
      { match: "claude-3-sonnet",   input:  3.00, output: 15.00 },
      { match: "claude-3-haiku",    input:  0.25, output:  1.25 },
    ];
    var price = null;
    var modelLower = primaryModel.toLowerCase();
    for (var pi = 0; pi < PRICE_TABLE.length; pi++) {
      if (modelLower.includes(PRICE_TABLE[pi].match)) { price = PRICE_TABLE[pi]; break; }
    }
    if (!price && modelLower.includes("claude")) price = { input: 3.00, output: 15.00 };
    if (price) {
      totalCost = (inputTokens / 1e6) * price.input
        + (outputTokens / 1e6) * price.output
        + (cacheRead / 1e6) * price.input * 0.1
        + (cacheWrite / 1e6) * price.input * 1.25;
    }
  }

  // Build sorted top tools
  var topTools = Object.entries(toolCounts)
    .sort(function (a, b) { return b[1] - a[1]; });

  // Calculate duration in seconds
  var duration = (firstTimestamp !== null && lastTimestamp !== null)
    ? Math.round((lastTimestamp - firstTimestamp) / 1000)
    : 0;

  // Intervention count: user turns minus the initial prompt
  var interventionCount = Math.max(0, userTurnCount - 1);

  // Autonomy efficiency: approximate from event counts
  // (simplified: ratio of tool calls to total significant events)
  var productiveEvents = totalToolCalls + totalTurns;
  var totalSignificant = productiveEvents + interventionCount;
  var autonomyEfficiency = totalSignificant > 0
    ? Math.round((productiveEvents / totalSignificant) * 100) / 100
    : 0;

  var statsOutput = {
    autonomyEfficiency: autonomyEfficiency,
    errorCount: errorCount,
    totalTurns: totalTurns,
    totalToolCalls: totalToolCalls,
    tokenUsage: { input: inputTokens, output: outputTokens },
    totalCost: Math.round(totalCost * 10000) / 10000,
    topTools: topTools,
    interventionCount: interventionCount,
    duration: duration,
  };

  process.stdout.write(JSON.stringify(statsOutput, null, 2) + "\n");
  process.exit(0);
}

// -- Check dist/ exists --
if (!fs.existsSync(path.join(distDir, "index.html"))) {
  process.stderr.write(
    "dist/ not found. Run `npm run build` inside the agentviz package first.\n"
  );
  process.exit(1);
}

if (cliMode) {
  // Read JSONL once, shared across all modes
  var rawText = fs.readFileSync(sessionFile, "utf8");
  var sessionName = path.basename(sessionFile);

  // -- Stats --
  if (statsMode) {
    var statsLines = rawText.split("\n").filter(function (l) { return l.trim(); });

    // Detect format
    var isCopilotCli = false;
    for (var si = 0; si < Math.min(statsLines.length, 5); si++) {
      if (statsLines[si].indexOf('"copilot-agent"') !== -1 ||
          statsLines[si].indexOf('"copilot_agent"') !== -1) {
        isCopilotCli = true;
        break;
      }
    }

    var totalTurns = 0;
    var totalToolCalls = 0;
    var errorCount = 0;
    var toolCounts = {};
    var inputTokens = 0;
    var outputTokens = 0;
    var cacheRead = 0;
    var cacheWrite = 0;
    var firstTimestamp = null;
    var lastTimestamp = null;
    var primaryModel = null;
    var modelCounts = {};
    var userTurnCount = 0;
    var totalCost = 0;

    for (var si = 0; si < statsLines.length; si++) {
      try {
        var record = JSON.parse(statsLines[si]);
      } catch (e) { continue; }

      var ts = record.timestamp || (record.data && record.data.timestamp);
      if (ts) {
        var tsMs = new Date(ts).getTime();
        if (!isNaN(tsMs)) {
          if (firstTimestamp === null || tsMs < firstTimestamp) firstTimestamp = tsMs;
          if (lastTimestamp === null || tsMs > lastTimestamp) lastTimestamp = tsMs;
        }
      }

      if (isCopilotCli) {
        var rtype = record.type || "";
        if (rtype === "assistant.turn_start") totalTurns++;
        if (rtype === "user.message") userTurnCount++;
        if (rtype === "tool.execution_start") {
          totalToolCalls++;
          var tn = record.data && record.data.toolName;
          if (tn) toolCounts[tn] = (toolCounts[tn] || 0) + 1;
        }
        if (rtype === "tool.execution_complete" && record.data && record.data.isError) {
          errorCount++;
        }
        if (rtype === "session.error") errorCount++;

        if (rtype === "assistant.turn_end" && record.data) {
          var usage = record.data.tokenUsage || record.data.usage;
          if (usage) {
            inputTokens += usage.inputTokens || usage.input_tokens || 0;
            outputTokens += usage.outputTokens || usage.output_tokens || 0;
            cacheRead += usage.cacheRead || usage.cache_read || 0;
            cacheWrite += usage.cacheWrite || usage.cache_write || 0;
          }
          var mdl = record.data.model;
          if (mdl) modelCounts[mdl] = (modelCounts[mdl] || 0) + 1;
        }

        if (rtype === "assistant.turn_end" && record.data && record.data.cost != null) {
          totalCost += record.data.cost;
        }
      } else {
        var ctype = record.type;
        if (ctype === "human" || ctype === "user") { userTurnCount++; totalTurns++; }
        if (ctype === "assistant" && record.message && record.message.content) {
          var content = record.message.content;
          if (Array.isArray(content)) {
            for (var ci = 0; ci < content.length; ci++) {
              var block = content[ci];
              if (block.type === "tool_use") {
                totalToolCalls++;
                var tname = block.name || "unknown";
                toolCounts[tname] = (toolCounts[tname] || 0) + 1;
              }
            }
          }
          if (record.message && record.message.model) {
            var mdl = record.message.model;
            modelCounts[mdl] = (modelCounts[mdl] || 0) + 1;
          }
        }
        if (ctype === "tool_result" || ctype === "tool_output") {
          if (record.is_error || record.isError) errorCount++;
        }
        if (ctype === "assistant" && record.message && record.message.usage) {
          var usage = record.message.usage;
          inputTokens += usage.input_tokens || usage.inputTokens || 0;
          outputTokens += usage.output_tokens || usage.outputTokens || 0;
          cacheRead += usage.cache_read_input_tokens || usage.cacheRead || 0;
          cacheWrite += usage.cache_creation_input_tokens || usage.cacheWrite || 0;
        }
      }
    }

    var maxModelCount = 0;
    for (var m in modelCounts) {
      if (modelCounts[m] > maxModelCount) {
        maxModelCount = modelCounts[m];
        primaryModel = m;
      }
    }

    if (!isCopilotCli && (inputTokens > 0 || outputTokens > 0) && primaryModel) {
      var PRICE_TABLE = [
        { match: "claude-opus-4",    input: 15.00, output: 75.00 },
        { match: "claude-sonnet-4",  input:  3.00, output: 15.00 },
        { match: "claude-haiku-4",   input:  0.80, output:  4.00 },
        { match: "claude-3-5-sonnet", input: 3.00, output: 15.00 },
        { match: "claude-3-5-haiku",  input: 0.80, output:  4.00 },
        { match: "claude-3-opus",     input: 15.00, output: 75.00 },
        { match: "claude-3-sonnet",   input:  3.00, output: 15.00 },
        { match: "claude-3-haiku",    input:  0.25, output:  1.25 },
      ];
      var price = null;
      var modelLower = primaryModel.toLowerCase();
      for (var pi = 0; pi < PRICE_TABLE.length; pi++) {
        if (modelLower.includes(PRICE_TABLE[pi].match)) { price = PRICE_TABLE[pi]; break; }
      }
      if (!price && modelLower.includes("claude")) price = { input: 3.00, output: 15.00 };
      if (price) {
        totalCost = (inputTokens / 1e6) * price.input
          + (outputTokens / 1e6) * price.output
          + (cacheRead / 1e6) * price.input * 0.1
          + (cacheWrite / 1e6) * price.input * 1.25;
      }
    }

    var topTools = Object.entries(toolCounts)
      .sort(function (a, b) { return b[1] - a[1]; });

    var duration = (firstTimestamp !== null && lastTimestamp !== null)
      ? Math.round((lastTimestamp - firstTimestamp) / 1000)
      : 0;

    var interventionCount = Math.max(0, userTurnCount - 1);

    var productiveEvents = totalToolCalls + totalTurns;
    var totalSignificant = productiveEvents + interventionCount;
    var autonomyEfficiency = totalSignificant > 0
      ? Math.round((productiveEvents / totalSignificant) * 100) / 100
      : 0;

    var statsOutput = {
      autonomyEfficiency: autonomyEfficiency,
      errorCount: errorCount,
      totalTurns: totalTurns,
      totalToolCalls: totalToolCalls,
      tokenUsage: { input: inputTokens, output: outputTokens },
      totalCost: Math.round(totalCost * 10000) / 10000,
      topTools: topTools,
      interventionCount: interventionCount,
      duration: duration,
    };

    process.stdout.write(JSON.stringify(statsOutput, null, 2) + "\n");
  }

  // -- Digest (async, so we chain it) --
  var digestDone = Promise.resolve();
  if (digestMode) {
    digestDone = import("../src/lib/digestSession.js").then(function (mod) {
      var digest = mod.digestSession(rawText);
      var markdown = mod.formatDigestMarkdown(digest, sessionName);

      var digestOutFile = outputPath && !exportMode
        ? path.resolve(outputPath)
        : path.resolve(sessionName.replace(/\.jsonl$/, "") + "-digest.md");

      fs.writeFileSync(digestOutFile, markdown, "utf8");
      process.stdout.write("Digest: " + digestOutFile + "\n");
    });
  }

  digestDone.then(function () {
    // -- Export (needs dist/) --
    if (exportMode) {
      if (!fs.existsSync(path.join(distDir, "index.html"))) {
        process.stderr.write("dist/ not found. Run `npm run build` inside the agentviz package first.\n");
        process.exit(1);
      }

      var assetsDir = path.join(distDir, "assets");
      var bundleFileName = null;
      try {
        bundleFileName = fs.readdirSync(assetsDir).find(function (f) {
          return f.startsWith("index-") && f.endsWith(".js");
        });
      } catch (e) {}
      if (!bundleFileName) {
        process.stderr.write("Error: built bundle not found in dist/assets/. Run `npm run build` first.\n");
        process.exit(1);
      }
      var bundleText = fs.readFileSync(path.join(assetsDir, bundleFileName), "utf8");

  // Pure helpers mirrored from src/lib/exportHtml.js
  function jsonSafe(value) {
    return JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026");
  }

  function escapeHtmlAttr(str) {
    return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
      .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  var INLINE_STYLES = `
  :root {
    --av-bg-hover: #20202e;
    --av-bg-active: #26263a;
    --av-focus: #6475e8;
    --av-border: #2c2c30;
    --av-border-strong: #3a3a3f;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #000000; overflow: hidden; font-family: 'JetBrains Mono', monospace; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #3a3a3f; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #45454b; }
  *:focus-visible { outline: 2px solid var(--av-focus); outline-offset: 2px; }
  *:focus:not(:focus-visible) { outline: none; }
  .av-btn { cursor: pointer; transition: background 80ms ease-out, border-color 80ms ease-out, color 80ms ease-out; }
  .av-btn:hover { background: var(--av-bg-hover); }
  .av-btn:active { background: var(--av-bg-active); }
  .av-interactive { transition: background 80ms ease-out; }
  .av-interactive:hover { background: var(--av-bg-hover); }
  .av-search:focus { border-color: var(--av-focus) !important; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after {
      animation-duration: 0.01ms !important;
      transition-duration: 0.01ms !important;
    }
  }
`;

  var metaPayload = jsonSafe({ filename: sessionName, live: false });
  var rawTextPayload = jsonSafe(rawText);

  var setupScript =
    "<script>\n" +
    "(function() {\n" +
    "  var _orig = window.fetch;\n" +
    "  var _meta = " + metaPayload + ";\n" +
    "  var _text = " + rawTextPayload + ";\n" +
    "  window.fetch = function(url, opts) {\n" +
    "    var s = String(url);\n" +
    '    if (s.indexOf("/api/meta") !== -1) {\n' +
    '      return Promise.resolve(new Response(JSON.stringify(_meta), { status: 200, headers: { "Content-Type": "application/json" } }));\n' +
    "    }\n" +
    '    if (s.indexOf("/api/file") !== -1) {\n' +
    '      return Promise.resolve(new Response(_text, { status: 200, headers: { "Content-Type": "text/plain" } }));\n' +
    "    }\n" +
    "    return _orig.apply(window, arguments);\n" +
    "  };\n" +
    "})();\n" +
    "</" + "script>";

  var title = "AGENTVIZ - " + escapeHtmlAttr(sessionName);
  var html = "<!DOCTYPE html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '  <meta charset="UTF-8" />\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
    "  <title>" + title + "</title>\n" +
    '  <link rel="preconnect" href="https://fonts.googleapis.com" />\n' +
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />\n' +
    '  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />\n' +
    "  <style>" + INLINE_STYLES + "  </style>\n" +
    "</head>\n" +
    "<body>\n" +
    '  <div id="root"></div>\n' +
    "  " + setupScript + "\n" +
    '  <script type="module">\n' +
    bundleText + "\n" +
    "  </" + "script>\n" +
    "</body>\n" +
    "</html>";

  var outFile = outputPath
    ? path.resolve(outputPath)
    : path.resolve(sessionName.replace(/\.jsonl$/, "") + "-agentviz.html");

  fs.writeFileSync(outFile, html, "utf8");

  var sizeMB = (Buffer.byteLength(html, "utf8") / (1024 * 1024)).toFixed(2);
  process.stdout.write("Exported: " + outFile + " (" + sizeMB + " MB)\n");
    }

    process.exit(0);
  }).catch(function (err) {
    process.stderr.write("Error: " + (err.message || err) + "\n");
    process.exit(1);
  });
} else {

// -- Server mode (no CLI flags) --
if (!fs.existsSync(path.join(distDir, "index.html"))) {
  process.stderr.write(
    "dist/ not found. Run `npm run build` inside the agentviz package first.\n"
  );
  process.exit(1);
}

findFreePort(4242, function (err, port) {
  var server = createServer({ sessionFile: sessionFile, distDir: distDir });
  server.listen(port, "127.0.0.1", function () {
    var url = "http://localhost:" + port;
    log("[start] listening on " + url + (sessionFile ? " session=" + path.basename(sessionFile) : ""));
    process.stdout.write("\n  AGENTVIZ. running at " + url + "\n");
    if (sessionFile) {
      process.stdout.write("  Session: " + path.basename(sessionFile) + "\n");
    }
    process.stdout.write("  Logs: " + LOG_FILE + "\n");
    process.stdout.write("  Press Ctrl+C to stop.\n\n");
    if (!noOpen) { openBrowser(url); }
  });

  process.on("SIGINT", function () {
    server.close(function () { process.exit(0); });
  });
  process.on("SIGTERM", function () {
    server.close(function () { process.exit(0); });
  });
});
} // end else (non-digest mode)
