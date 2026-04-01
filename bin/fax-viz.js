#!/usr/bin/env node
/**
 * FAX-VIZ CLI entry point.
 *   node bin/fax-viz.js --fax-dir <path>
 *
 * Starts the FAX-VIZ server and opens the browser.
 */

import { createFaxVizServer } from "../fax-viz-server.js";
import { DEFAULT_API_PORT, PORT_FILE } from "../config.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { exec } from "child_process";
import net from "net";

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var rootDir = path.resolve(__dirname, "..");
var distDir = path.join(rootDir, "dist-fax-viz");
var LOG_FILE = path.join(rootDir, "fax-viz-server.log");

function log(msg) {
  var line = new Date().toISOString() + " " + msg + "\n";
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

function exitWithError(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

function parseArgs(argv) {
  var args = { faxDir: null, noOpen: false, open: null, threadsFile: null };
  for (var i = 2; i < argv.length; i++) {
    if (argv[i] === "--fax-dir" && argv[i + 1]) {
      args.faxDir = argv[++i];
    } else if (argv[i] === "--threads-file" && argv[i + 1]) {
      args.threadsFile = argv[++i];
    } else if (argv[i] === "--open" && argv[i + 1]) {
      args.open = argv[++i];
    } else if (argv[i] === "--no-open") {
      args.noOpen = true;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      process.stdout.write([
        "",
        "  FAX-VIZ - Fax Bundle Viewer",
        "",
        "  Usage: fax-viz --fax-dir <path>",
        "",
        "  Options:",
        "    --fax-dir <path>        Path to directory containing fax bundles (required)",
        "    --threads-file <path>   Path to threads.json for thread store integration",
        "    --open <name>           Open browser directly to a specific fax bundle",
        "    --no-open               Don't open browser automatically",
        "    -h, --help              Show this help",
        "",
      ].join("\n") + "\n");
      process.exit(0);
    }
  }
  return args;
}

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

function openBrowser(url) {
  var platform = process.platform;
  var cmd = platform === "darwin" ? "open"
    : platform === "win32" ? "start"
    : "xdg-open";
  exec(cmd + " " + url, function () {});
}

process.on("uncaughtException", function (err) {
  log("[crash] uncaughtException: " + (err && err.stack ? err.stack : String(err)));
});

process.on("unhandledRejection", function (reason) {
  log("[crash] unhandledRejection: " + (reason && reason.stack ? reason.stack : String(reason)));
});

// Main
var args = parseArgs(process.argv);

if (!args.faxDir) {
  exitWithError("Error: --fax-dir <path> is required.\n\nUsage: fax-viz --fax-dir <path>");
}

var resolvedFaxDir = path.resolve(args.faxDir);
if (!fs.existsSync(resolvedFaxDir)) {
  exitWithError("Error: fax directory not found: " + resolvedFaxDir);
}

// Check for dist bundle
var hasDistBundle = fs.existsSync(path.join(distDir, "fax-viz-index.html"));

// Determine preferred port: one after the running AgentViz port
function getPreferredPort() {
  try {
    var portStr = fs.readFileSync(PORT_FILE, "utf8").trim();
    var agentVizPort = parseInt(portStr, 10);
    if (agentVizPort > 0) {
      return agentVizPort + 1;
    }
  } catch (e) {}
  return DEFAULT_API_PORT + 1;
}

findFreePort(getPreferredPort(), function (err, port) {
  if (err) {
    exitWithError("Could not find a free port: " + err.message);
    return;
  }

  var serverDistDir = hasDistBundle ? distDir : null;
  var resolvedThreadsFile = args.threadsFile ? path.resolve(args.threadsFile) : null;
  var server = createFaxVizServer({ faxDir: resolvedFaxDir, distDir: serverDistDir, threadsFile: resolvedThreadsFile });

  server.listen(port, "127.0.0.1", function () {
    var serverUrl = "http://localhost:" + port;
    log("[start] listening on " + serverUrl + " fax-dir=" + resolvedFaxDir);
    process.stdout.write("\n  FAX-VIZ. running at " + serverUrl + "\n");
    process.stdout.write("  Fax directory: " + resolvedFaxDir + "\n");
    process.stdout.write("  Logs: " + LOG_FILE + "\n");
    process.stdout.write("  Press Ctrl+C to stop.\n\n");

    if (!args.noOpen) {
      var browserUrl = args.open ? serverUrl + "#/fax/" + args.open : serverUrl;
      openBrowser(browserUrl);
    }

    process.on("SIGINT", function () {
      server.close(function () { process.exit(0); });
    });
    process.on("SIGTERM", function () {
      server.close(function () { process.exit(0); });
    });
  });
});
