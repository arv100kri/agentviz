#!/usr/bin/env node
/**
 * CLI entry point:
 *   - node bin/agentviz.js [session.jsonl]
 *   - node bin/agentviz.js --stats <session.jsonl>
 *   - node bin/agentviz.js --digest <session.jsonl> [-o session-digest.md]
 *
 * Plain launch mode starts the local AGENTVIZ server and opens the browser.
 * Analysis modes generate digest/stats output and do not open the browser.
 */

import { createServer } from "../server.js";
import { DEFAULT_API_PORT, PORT_FILE } from "../config.js";
import { formatCliHelp, parseCliArgs, resolveCliExecution } from "../src/lib/cliArgs.js";
import { runSessionDigestAgent } from "../src/lib/sessionDigestAgent.js";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { exec } from "child_process";
import net from "net";

var __dirname = path.dirname(fileURLToPath(import.meta.url));
var rootDir = path.resolve(__dirname, "..");
var distDir = path.join(rootDir, "dist");
var cliDistDir = path.join(rootDir, "dist-cli");
var LOG_FILE = path.join(rootDir, "agentviz-server.log");
var SUPPORTED_FORMATS_ERROR = "Could not parse any events. Supported formats: Claude Code JSONL, Copilot CLI JSONL.";

function log(msg) {
  var line = new Date().toISOString() + " " + msg + "\n";
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

function writeStatus(msg) {
  process.stderr.write(msg + "\n");
}

function exitWithError(msg) {
  process.stderr.write(msg + "\n");
  process.exit(1);
}

process.on("uncaughtException", function (err) {
  var msg = "[crash] uncaughtException: " + (err && err.stack ? err.stack : String(err));
  log(msg);
});

process.on("unhandledRejection", function (reason) {
  var msg = "[crash] unhandledRejection: " + (reason && reason.stack ? reason.stack : String(reason));
  log(msg);
});

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
        if (mtime > bestMtime) {
          bestMtime = mtime;
          best = full;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return best;
}

function resolveSessionInput(inputPath) {
  if (!inputPath) return null;

  var resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) {
    throw new Error("path not found: " + resolved);
  }

  var stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    var latest = findLatestJsonl(resolved);
    if (!latest) {
      throw new Error("no .jsonl files found in " + resolved);
    }
    return latest;
  }

  return resolved;
}

function ensureWebBundle() {
  if (!fs.existsSync(path.join(distDir, "index.html"))) {
    throw new Error("Web bundle not found. Run `npm run build` inside the AGENTVIZ package first.");
  }
}

async function loadCliRuntime() {
  var runtimePath = path.join(cliDistDir, "index.js");
  if (!fs.existsSync(runtimePath)) {
    throw new Error("CLI analysis bundle not found. Run `npm run build` inside the AGENTVIZ package first.");
  }
  return import(pathToFileURL(runtimePath).href);
}

function resolveDigestOutputPath(outputPath) {
  if (outputPath) return path.resolve(outputPath);
  return path.resolve(process.cwd(), "session-digest.md");
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

function startInteractiveServer(sessionFile, noOpen) {
  return new Promise(function (resolve, reject) {
    findFreePort(DEFAULT_API_PORT, function (err, port) {
      if (err) {
        reject(err);
        return;
      }

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

        // Write port to file so fax-viz can coordinate
        try {
          fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
          fs.writeFileSync(PORT_FILE, String(port), "utf8");
        } catch (e) {}

        if (!noOpen) {
          openBrowser(url);
        }

        function cleanupPortFile() {
          try { fs.unlinkSync(PORT_FILE); } catch (e) {}
        }

        process.on("SIGINT", function () {
          cleanupPortFile();
          server.close(function () { process.exit(0); });
        });
        process.on("SIGTERM", function () {
          cleanupPortFile();
          server.close(function () { process.exit(0); });
        });
        process.on("exit", cleanupPortFile);

        resolve();
      });
    });
  });
}

async function runAnalysisMode(parsedArgs) {
  var sessionFile = resolveSessionInput(parsedArgs.sessionPath);
  var runtime = await loadCliRuntime();
  var rawText = fs.readFileSync(sessionFile, "utf8");
  var parsedSession = runtime.parseSession(rawText);

  if (!parsedSession || !parsedSession.events || parsedSession.events.length === 0) {
    throw new Error(SUPPORTED_FORMATS_ERROR);
  }

  if (parsedArgs.digest) {
    var digestEvidence = runtime.buildDigestEvidence(parsedSession, path.basename(sessionFile));
    var digestResult;

    try {
      digestResult = await runSessionDigestAgent(digestEvidence);
    } catch (error) {
      throw new Error("Digest generation failed: " + (error && error.message ? error.message : String(error)));
    }

    var digestPath = resolveDigestOutputPath(parsedArgs.outputPath);
    var digestMarkdown = runtime.renderSessionDigestMarkdown(digestEvidence, digestResult.sections, {
      sourceFile: sessionFile,
      model: digestResult.model,
    });

    fs.mkdirSync(path.dirname(digestPath), { recursive: true });
    fs.writeFileSync(digestPath, digestMarkdown, "utf8");
    writeStatus("Wrote digest: " + digestPath);
  }

  if (parsedArgs.stats) {
    var stats = runtime.buildCliStats(parsedSession);
    process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
  }
}

async function main() {
  try {
    var parsedArgs = parseCliArgs(process.argv.slice(2));
    var execution = resolveCliExecution(parsedArgs);

    if (parsedArgs.help) {
      process.stdout.write(formatCliHelp() + "\n");
      return;
    }

    if (execution.analysisMode) {
      await runAnalysisMode(parsedArgs);
      return;
    }

    var sessionFile = parsedArgs.sessionPath ? resolveSessionInput(parsedArgs.sessionPath) : null;
    ensureWebBundle();
    await startInteractiveServer(sessionFile, parsedArgs.noOpen);
  } catch (error) {
    if (error && error.code === "CLI_ARG_ERROR") {
      exitWithError(error.message + "\n\n" + formatCliHelp());
    }
    exitWithError("Error: " + (error && error.message ? error.message : String(error)));
  }
}

main();
