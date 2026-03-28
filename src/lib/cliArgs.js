function createCliArgError(message) {
  var error = new Error(message);
  error.code = "CLI_ARG_ERROR";
  return error;
}

export function parseCliArgs(argv) {
  var parsed = {
    sessionPath: null,
    digest: false,
    stats: false,
    noOpen: false,
    help: false,
    outputPath: null,
  };

  var args = Array.isArray(argv) ? argv.slice() : [];
  for (var index = 0; index < args.length; index += 1) {
    var arg = args[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }

    if (arg === "--digest") {
      parsed.digest = true;
      continue;
    }

    if (arg === "--stats") {
      parsed.stats = true;
      continue;
    }

    if (arg === "--no-open") {
      parsed.noOpen = true;
      continue;
    }

    if (arg === "--output" || arg === "-o") {
      index += 1;
      if (index >= args.length) {
        throw createCliArgError("Missing value for " + arg + ".");
      }
      parsed.outputPath = args[index];
      continue;
    }

    if (arg.startsWith("-")) {
      throw createCliArgError("Unknown option: " + arg);
    }

    if (parsed.sessionPath) {
      throw createCliArgError("Only one session path can be provided.");
    }

    parsed.sessionPath = arg;
  }

  if (parsed.help) return parsed;

  if (parsed.outputPath && !parsed.digest) {
    throw createCliArgError("--output requires --digest.");
  }

  if ((parsed.digest || parsed.stats) && !parsed.sessionPath) {
    throw createCliArgError("A session path is required when using --digest or --stats.");
  }

  return parsed;
}

export function resolveCliExecution(parsed) {
  var analysisMode = Boolean(parsed && (parsed.digest || parsed.stats));

  return {
    analysisMode,
    needsAnalysisBundle: analysisMode,
    needsWebBundle: !analysisMode && !(parsed && parsed.help),
    launchesApp: !analysisMode && !(parsed && parsed.help),
    opensBrowser: !analysisMode && !(parsed && parsed.help) && !(parsed && parsed.noOpen),
  };
}

export function formatCliHelp() {
  return [
    "AGENTVIZ CLI",
    "",
    "Usage:",
    "  node bin/agentviz.js [session.jsonl|session-dir]",
    "  node bin/agentviz.js --stats <session.jsonl>",
    "  node bin/agentviz.js --digest <session.jsonl> [-o session-digest.md]",
    "  node bin/agentviz.js --digest <session.jsonl> -o session-digest.md --stats",
    "",
    "Options:",
    "  --digest        Generate a markdown session digest. Analysis modes do not open the browser.",
    "  --stats         Print machine-readable JSON session stats to stdout.",
    "  -o, --output    Output path for --digest. Defaults to session-digest.md.",
    "  --no-open       Launch the local server without opening the browser.",
    "  -h, --help      Show this help text.",
    "",
    "Notes:",
    "  - A directory input resolves to the most recently modified .jsonl file inside it.",
    "  - Plain launch mode preserves the existing AGENTVIZ browser workflow.",
  ].join("\n");
}
