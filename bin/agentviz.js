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
var outputPath = null;
var argv = process.argv.slice(2);
for (var i = 0; i < argv.length; i++) {
  var arg = argv[i];
  if (arg === "--no-open") { noOpen = true; continue; }
  if (arg === "--export") { exportMode = true; continue; }
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

// -- Check dist/ exists --
if (!fs.existsSync(path.join(distDir, "index.html"))) {
  process.stderr.write(
    "dist/ not found. Run `npm run build` inside the agentviz package first.\n"
  );
  process.exit(1);
}

// -- Export mode: generate self-contained HTML and exit --
if (exportMode) {
  if (!sessionFile) {
    process.stderr.write("Error: --export requires a session file path.\n" +
      "Usage: agentviz --export <session.jsonl> [-o output.html]\n");
    process.exit(1);
  }

  // Find the built JS bundle in dist/assets/
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

  // Read session JSONL
  var rawText = fs.readFileSync(sessionFile, "utf8");
  var sessionName = path.basename(sessionFile);

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
    "  window.__AGENTVIZ_EXPORTED__ = true;\n" +
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
  process.exit(0);
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
