/**
 * Session Q&A server-side utilities.
 *
 * Extracted from the original server.js to support fax-viz standalone mode.
 * Contains precomputation, caching, history, and progress-reporting helpers
 * shared by fax-viz-server.js, sessionQAPipeline.js, and sessionQAEndpoints.js.
 */

import fs from "fs";
import os from "os";
import path from "path";
import {
  buildQAContext,
  buildQAPrompt,
  buildRawJsonlRecordIndex,
  buildSessionQAProgramCacheKey,
  buildSessionQAArtifacts,
  buildToolCallSearchIndex,
  compileSessionQAQueryProgram,
  describeSessionQAQueryProgram,
  routeSessionQAQuestion,
  scanRawJsonlQuestionMatches,
} from "./sessionQA.js";

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

export function sanitizeSessionQATiming(timing) {
  var totalMs = timing && timing.totalMs;
  var numericTotalMs = typeof totalMs === "number" ? totalMs : Number(totalMs);
  if (!Number.isFinite(numericTotalMs) || numericTotalMs < 0) return null;
  return { totalMs: Math.round(numericTotalMs) };
}

export function sanitizeSessionQAMessages(messages) {
  return Array.isArray(messages) ? messages
    .filter(function (message) {
      return message && typeof message.role === "string" &&
        typeof message.content === "string" &&
        (message.content || message.role !== "assistant");
    })
    .map(function (message) {
      var sanitizedMessage = {
        role: message.role,
        content: message.content,
        references: Array.isArray(message.references) ? message.references : [],
      };
      var timing = sanitizeSessionQATiming(message.timing);
      if (timing) sanitizedMessage.timing = timing;
      return sanitizedMessage;
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

function hashText(text) {
  var value = 0;
  var source = text || "";

  for (var index = 0; index < source.length; index += 1) {
    value = ((value << 5) - value + source.charCodeAt(index)) | 0;
  }

  return String(Math.abs(value));
}

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

var SESSION_QA_PRECOMPUTE_VERSION = 2;

export function getSessionQAPrecomputeCacheDir(homeDir) {
  return path.join(homeDir || os.homedir(), ".agentviz", "session-qa-cache");
}

export function getSessionQASidecarFilePath(sessionFilePath) {
  if (!sessionFilePath) return null;
  var ext = path.extname(sessionFilePath);
  if (ext.toLowerCase() === ".jsonl") {
    return sessionFilePath.slice(0, sessionFilePath.length - ext.length) + ".agentviz-qa.json";
  }
  return sessionFilePath + ".agentviz-qa.json";
}

function getManagedSessionQAPrecomputePath(fingerprint, homeDir) {
  return path.join(getSessionQAPrecomputeCacheDir(homeDir), "session-" + hashText(fingerprint) + ".json");
}

export function readSessionQAPrecompute(filePath, fsModule) {
  if (!filePath) return null;
  var targetFs = fsModule || fs;
  try {
    var raw = targetFs.readFileSync(filePath, "utf8");
    var parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch (error) {
    return null;
  }
}

export function writeSessionQAPrecompute(filePath, record, fsModule) {
  if (!filePath || !record) return false;
  var targetFs = fsModule || fs;
  try {
    targetFs.mkdirSync(path.dirname(filePath), { recursive: true });
    targetFs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
    return true;
  } catch (error) {
    return false;
  }
}

function getSessionQARawText(entry, fsModule) {
  if (entry && typeof entry.rawText === "string") return entry.rawText;
  if (!entry || !entry.sessionFilePath) return "";
  var targetFs = fsModule || fs;
  try {
    return targetFs.readFileSync(entry.sessionFilePath, "utf8");
  } catch (error) {
    return "";
  }
}

function copyPersistedRawSlice(rawSlice) {
  if (!rawSlice || typeof rawSlice !== "object") return null;
  return {
    strategy: rawSlice.strategy || "unknown",
    lineStart: typeof rawSlice.lineStart === "number" ? rawSlice.lineStart : null,
    lineEnd: typeof rawSlice.lineEnd === "number" ? rawSlice.lineEnd : null,
    charStart: typeof rawSlice.charStart === "number" ? rawSlice.charStart : null,
    charEnd: typeof rawSlice.charEnd === "number" ? rawSlice.charEnd : null,
    startRecordIndex: typeof rawSlice.startRecordIndex === "number" ? rawSlice.startRecordIndex : null,
    endRecordIndex: typeof rawSlice.endRecordIndex === "number" ? rawSlice.endRecordIndex : null,
    toolCallId: rawSlice.toolCallId || null,
    toolUseId: rawSlice.toolUseId || null,
  };
}

function copyPersistedLedgerEntry(entry) {
  var cloned = cloneJsonValue(entry);
  if (!cloned || typeof cloned !== "object") return null;
  if (cloned.rawSlice) cloned.rawSlice = copyPersistedRawSlice(cloned.rawSlice);
  return cloned;
}

function sanitizePersistedSessionQAArtifacts(artifacts) {
  if (!artifacts || typeof artifacts !== "object") return null;
  var ledger = Array.isArray(artifacts.ledger)
    ? artifacts.ledger.map(copyPersistedLedgerEntry).filter(Boolean)
    : [];

  return {
    turnRecords: Array.isArray(artifacts.turnRecords) ? cloneJsonValue(artifacts.turnRecords) : [],
    ledger: ledger,
    turnSummaries: Array.isArray(artifacts.turnSummaries) ? cloneJsonValue(artifacts.turnSummaries) : [],
    summaryChunks: Array.isArray(artifacts.summaryChunks) ? cloneJsonValue(artifacts.summaryChunks) : [],
    stats: artifacts.stats && typeof artifacts.stats === "object" ? cloneJsonValue(artifacts.stats) : null,
    metricCatalog: artifacts.metricCatalog && typeof artifacts.metricCatalog === "object"
      ? cloneJsonValue(artifacts.metricCatalog)
      : null,
    metadata: artifacts.metadata && typeof artifacts.metadata === "object" ? cloneJsonValue(artifacts.metadata) : null,
    rawLookup: artifacts.rawLookup && typeof artifacts.rawLookup === "object"
      ? { matchedCount: Number(artifacts.rawLookup.matchedCount) || 0 }
      : null,
    rawIndex: null,
  };
}

function hydratePersistedSessionQAArtifacts(artifacts, rawText) {
  var cloned = cloneJsonValue(artifacts);
  if (!cloned || typeof cloned !== "object") return null;
  var ledger = Array.isArray(cloned.ledger) ? cloned.ledger : [];
  if (!cloned.ledgerIndex && ledger.length > 0) {
    cloned.ledgerIndex = buildToolCallSearchIndex(ledger);
  }
  cloned.rawIndex = null;
  if (cloned.rawLookup || rawText) {
    cloned.rawLookup = Object.assign({}, cloned.rawLookup || {}, {
      rawText: rawText || "",
      rawIndex: null,
      ledger: ledger,
      ledgerIndex: cloned.ledgerIndex || null,
    });
  }
  return cloned;
}

export function buildSessionQAPrecomputeFingerprint(entry, fsModule) {
  var targetFs = fsModule || fs;
  var events = Array.isArray(entry && entry.events) ? entry.events : [];
  var turns = Array.isArray(entry && entry.turns) ? entry.turns : [];
  var metadata = entry && entry.metadata && typeof entry.metadata === "object" ? entry.metadata : {};
  var lastEvent = events.length > 0 ? events[events.length - 1] : null;
  var rawText = entry && typeof entry.rawText === "string" ? entry.rawText : "";
  var fileStat = "";

  if (!rawText && entry && entry.sessionFilePath) {
    try {
      var stat = targetFs.statSync(entry.sessionFilePath);
      fileStat = [stat.size, Math.round(stat.mtimeMs)].join("|");
    } catch (error) {}
  }

  return [
    entry && entry.sessionKey ? String(entry.sessionKey).toLowerCase() : "",
    entry && entry.sessionFilePath ? String(entry.sessionFilePath).toLowerCase() : "",
    rawText ? [rawText.length, hashText(rawText)].join(":") : "",
    events.length,
    turns.length,
    lastEvent && lastEvent.t != null ? lastEvent.t : "",
    lastEvent && lastEvent.toolName ? lastEvent.toolName : "",
    metadata.totalEvents != null ? metadata.totalEvents : "",
    metadata.totalTurns != null ? metadata.totalTurns : "",
    metadata.totalToolCalls != null ? metadata.totalToolCalls : "",
    metadata.errorCount != null ? metadata.errorCount : "",
    metadata.duration != null ? metadata.duration : "",
    fileStat,
  ].join("|");
}

export function buildSessionQAPrecomputeEntry(entry, options) {
  var opts = options && typeof options === "object" ? options : {};
  var targetFs = opts.fsModule || fs;
  var fingerprint = buildSessionQAPrecomputeFingerprint(entry, targetFs);
  var rawText = getSessionQARawText(entry, targetFs);
  var includeRawText = !entry || !entry.sessionFilePath;
  var candidatePaths = [];
  var sidecarPath = entry && entry.sessionFilePath ? getSessionQASidecarFilePath(entry.sessionFilePath) : null;
  var managedPath = getManagedSessionQAPrecomputePath(fingerprint, opts.homeDir);
  if (sidecarPath) candidatePaths.push({ path: sidecarPath, storage: "sidecar" });
  candidatePaths.push({ path: managedPath, storage: "managed" });

  for (var candidateIndex = 0; candidateIndex < candidatePaths.length; candidateIndex++) {
    var existing = readSessionQAPrecompute(candidatePaths[candidateIndex].path, targetFs);
    if (
      !existing ||
      existing.version !== SESSION_QA_PRECOMPUTE_VERSION ||
      existing.fingerprint !== fingerprint ||
      !existing.artifacts
    ) continue;
    var persistedRawText = typeof existing.rawText === "string" ? existing.rawText : rawText;
    return {
      fingerprint: fingerprint,
      storage: candidatePaths[candidateIndex].storage,
      path: candidatePaths[candidateIndex].path,
      builtAt: existing.builtAt || existing.updatedAt || null,
      reused: true,
      artifacts: hydratePersistedSessionQAArtifacts(existing.artifacts, persistedRawText),
      rawText: persistedRawText || null,
    };
  }

  var artifactOptions = rawText ? { rawText: rawText } : null;
  var artifacts = buildSessionQAArtifacts(entry && entry.events, entry && entry.turns, entry && entry.metadata, artifactOptions);
  var builtAt = new Date().toISOString();
  var record = {
    version: SESSION_QA_PRECOMPUTE_VERSION,
    fingerprint: fingerprint,
    builtAt: builtAt,
    sessionFilePath: entry && entry.sessionFilePath ? String(entry.sessionFilePath) : null,
    rawText: includeRawText ? rawText : null,
    artifacts: sanitizePersistedSessionQAArtifacts(artifacts),
  };
  var persistedStorage = "memory";
  var persistedPath = null;

  for (var writeIndex = 0; writeIndex < candidatePaths.length; writeIndex++) {
    if (!writeSessionQAPrecompute(candidatePaths[writeIndex].path, record, targetFs)) continue;
    persistedStorage = candidatePaths[writeIndex].storage;
    persistedPath = candidatePaths[writeIndex].path;
    break;
  }

  var hydratedArtifacts = hydratePersistedSessionQAArtifacts(record.artifacts, rawText);

  return {
    fingerprint: fingerprint,
    storage: persistedStorage,
    path: persistedPath,
    builtAt: builtAt,
    reused: false,
    artifacts: hydratedArtifacts || artifacts,
    rawText: rawText || null,
  };
}

export function ensureSessionQAPrecomputed(entry, options) {
  if (!entry || typeof entry !== "object") return null;
  var opts = options && typeof options === "object" ? options : {};
  var targetFs = opts.fsModule || fs;
  var fingerprint = buildSessionQAPrecomputeFingerprint(entry, targetFs);
  if (entry.precomputed && entry.precomputed.fingerprint === fingerprint && entry.precomputed.artifacts) {
    return entry.precomputed;
  }
  var built = buildSessionQAPrecomputeEntry(entry, opts);
  entry.precomputed = built;
  if (!entry.questionCache || entry.questionCacheFingerprint !== built.fingerprint) {
    entry.questionCache = {};
    entry.questionCacheFingerprint = built.fingerprint;
  }
  if (!entry.programCache || entry.programCacheFingerprint !== built.fingerprint) {
    entry.programCache = {};
    entry.programCacheFingerprint = built.fingerprint;
  }
  if (entry.factStore && entry.factStore.fingerprint !== built.fingerprint) {
    entry.factStore = null;
  }
  return built;
}

export function createSessionQACacheStore() {
  return new Map();
}

export function sanitizeSessionQACacheEntry(entry) {
  return {
    events: Array.isArray(entry && entry.events) ? entry.events.slice() : [],
    turns: Array.isArray(entry && entry.turns) ? entry.turns.slice() : [],
    metadata: entry && entry.metadata && typeof entry.metadata === "object"
      ? Object.assign({}, entry.metadata)
      : {},
    sessionFilePath: entry && entry.sessionFilePath ? String(entry.sessionFilePath) : null,
    rawText: entry && typeof entry.rawText === "string" ? entry.rawText : null,
    precomputed: entry && entry.precomputed ? entry.precomputed : null,
    questionCache: entry && entry.questionCache && typeof entry.questionCache === "object"
      ? entry.questionCache
      : {},
    questionCacheFingerprint: entry && entry.questionCacheFingerprint ? String(entry.questionCacheFingerprint) : null,
    programCache: entry && entry.programCache && typeof entry.programCache === "object"
      ? entry.programCache
      : {},
    programCacheFingerprint: entry && entry.programCacheFingerprint ? String(entry.programCacheFingerprint) : null,
    factStore: entry && entry.factStore && typeof entry.factStore === "object"
      ? entry.factStore
      : null,
    updatedAt: new Date().toISOString(),
  };
}

export function getSessionQACacheEntry(cache, sessionKey) {
  if (!cache || !sessionKey) return null;
  return cache.get(String(sessionKey)) || null;
}

export function saveSessionQACacheEntry(cache, sessionKey, entry) {
  if (!cache || !sessionKey) return null;
  var existing = cache.get(String(sessionKey)) || null;
  var saved = sanitizeSessionQACacheEntry(entry);
  if (existing && existing.precomputed && !saved.precomputed) saved.precomputed = existing.precomputed;
  if (existing && existing.questionCache && Object.keys(existing.questionCache).length > 0) {
    saved.questionCache = existing.questionCache;
    if (!saved.questionCacheFingerprint && existing.questionCacheFingerprint) {
      saved.questionCacheFingerprint = existing.questionCacheFingerprint;
    }
  }
  if (existing && existing.programCache && Object.keys(existing.programCache).length > 0) {
    saved.programCache = existing.programCache;
    if (!saved.programCacheFingerprint && existing.programCacheFingerprint) {
      saved.programCacheFingerprint = existing.programCacheFingerprint;
    }
  }
  if (existing && existing.factStore && !saved.factStore) {
    saved.factStore = existing.factStore;
  }
  cache.set(String(sessionKey), saved);
  return saved;
}

export function removeSessionQACacheEntry(cache, sessionKey) {
  if (!cache || !sessionKey) return false;
  return cache.delete(String(sessionKey));
}

function hasInlineSessionQAArtifacts(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (Array.isArray(payload.events)) return true;
  if (Array.isArray(payload.turns)) return true;
  if (payload.metadata && typeof payload.metadata === "object") return true;
  return Boolean(payload.sessionFilePath);
}

export function resolveSessionQAArtifacts(cache, payload) {
  var sessionKey = payload && payload.sessionKey ? String(payload.sessionKey) : null;
  var cached = sessionKey ? getSessionQACacheEntry(cache, sessionKey) : null;
  if (cached) {
    return Object.assign({ sessionKey: sessionKey, source: "cache" }, cached);
  }
  if (!hasInlineSessionQAArtifacts(payload)) return null;
  var inlineEntry = sessionKey
    ? saveSessionQACacheEntry(cache, sessionKey, payload)
    : sanitizeSessionQACacheEntry(payload);
  return Object.assign({ sessionKey: sessionKey, source: "inline" }, inlineEntry);
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

export function buildQATiming(startedAtMs, completedAtMs) {
  var start = typeof startedAtMs === "number" ? startedAtMs : Number(startedAtMs);
  var end = typeof completedAtMs === "number" ? completedAtMs : Number(completedAtMs);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { totalMs: 0 };
  return { totalMs: Math.max(0, Math.round(end - start)) };
}

export function buildQADonePayload(answer, references, modelLabel, qaSessionId, startedAtMs, completedAtMs) {
  return {
    done: true,
    answer: answer,
    references: references,
    model: modelLabel,
    qaSessionId: qaSessionId,
    timing: buildQATiming(startedAtMs, completedAtMs),
  };
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

function sanitizeQAElapsedMs(value) {
  var numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) return null;
  return Math.round(numericValue);
}

function formatQACount(value, singular, plural) {
  var numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) return null;
  var roundedValue = Math.round(numericValue);
  return roundedValue.toLocaleString() + " " + (roundedValue === 1 ? singular : (plural || singular + "s"));
}

function describeQAContextPreparation(events, turns, metadata) {
  var safeMetadata = metadata && typeof metadata === "object" ? metadata : {};
  var eventCount = safeMetadata.totalEvents != null ? safeMetadata.totalEvents : (Array.isArray(events) ? events.length : 0);
  var turnCount = safeMetadata.totalTurns != null ? safeMetadata.totalTurns : (Array.isArray(turns) ? turns.length : 0);
  var eventLabel = formatQACount(eventCount, "event");
  var turnLabel = formatQACount(turnCount, "turn");
  if (eventLabel && turnLabel) return "Reviewing " + eventLabel + " across " + turnLabel + ".";
  if (eventLabel) return "Reviewing " + eventLabel + ".";
  if (turnLabel) return "Reviewing " + turnLabel + ".";
  return "Reviewing the loaded session.";
}

function describeQAContextRetrieval(resolvedSession) {
  if (!resolvedSession || typeof resolvedSession !== "object") return null;
  var source = resolvedSession.source === "cache"
    ? "Using the cached session snapshot."
    : "Using the session data from this request.";
  if (!resolvedSession.sessionFilePath) return source;
  return source + " Raw session file access is available if the model needs exact output.";
}

function describeSessionQAProgramCompilation(queryProgram) {
  if (!queryProgram) return "Compiling the question into a structured session query.";
  var family = describeSessionQAQueryProgram(queryProgram);
  if (queryProgram.deterministic && !queryProgram.needsModel) {
    return "Compiled the question into the " + family + " family so AGENTVIZ can avoid the model if possible.";
  }
  return "Compiled the question into the " + family + " family before choosing the fastest route.";
}

function describeSessionQAFactStoreLookup(queryProgram, factStore) {
  var family = describeSessionQAQueryProgram(queryProgram);
  if (factStore && factStore.storage === "sidecar") {
    return "Querying the SQLite fact-store sidecar for the " + family + " family.";
  }
  return "Querying the SQLite fact store for the " + family + " family.";
}

function shouldLaunchSessionQARace(queryProgram) {
  return Boolean(queryProgram && queryProgram.raceEligible && queryProgram.canAnswerFromFactStore);
}

function buildSessionQARoutePlan(question, events, turns, metadata, qaArtifacts, options) {
  var opts = options && typeof options === "object" ? options : {};
  var route = routeSessionQAQuestion(question, qaArtifacts, {
    rawText: opts.rawText,
    rawIndex: opts.rawIndex,
    sessionFilePath: opts.sessionFilePath,
    queryProgram: opts.queryProgram,
    questionProfile: opts.queryProgram && opts.queryProgram.questionProfile
      ? opts.queryProgram.questionProfile
      : null,
  });
  var rawIndex = opts.rawIndex || null;

  if (route && route.kind === "raw-full" && rawIndex) {
    route.rawMatches = scanRawJsonlQuestionMatches(rawIndex, question, {
      questionProfile: route.profile,
      artifacts: qaArtifacts,
    });
  } else if (route && route.kind === "raw-full" && opts.rawText) {
    rawIndex = buildRawJsonlRecordIndex(opts.rawText);
    if (qaArtifacts && !qaArtifacts.rawIndex) qaArtifacts.rawIndex = rawIndex;
    route.rawMatches = scanRawJsonlQuestionMatches(rawIndex, question, {
      questionProfile: route.profile,
      artifacts: qaArtifacts,
    });
  }

  var context = "";
  if (route && route.kind !== "metric") {
    context = buildQAContext(events, turns, metadata, {
      question: question,
      artifacts: qaArtifacts,
      route: route,
    });
  }

  return {
    route: route,
    context: context,
    rawIndex: rawIndex,
  };
}

function describeQAToolDetail(toolName) {
  var name = String(toolName || "").trim();
  return name ? "Tool: " + name : null;
}

export function getQAProgressStatus(phase, options) {
  var opts = options && typeof options === "object" ? options : {};
  if (opts.status) return String(opts.status);
  if (phase === "tool-running") return describeQAToolStatus(opts.toolName, "start");
  if (phase === "tool-finished") return describeQAToolStatus(opts.toolName, "complete");
  if (phase === "precomputing-session") return "Building session index...";
  if (phase === "compiling-query-program") return "Compiling query program...";
  if (phase === "checking-paraphrase-cache") return "Checking paraphrase-aware cache...";
  if (phase === "querying-fact-store") return "Querying SQLite fact store...";
  if (phase === "launching-fallback-route") return "Launching fallback route...";
  if (phase === "canceling-slower-route") return "Canceling slower route...";
  if (phase === "using-cached-program-answer") return "Using cached program answer...";
  if (phase === "using-precomputed-metrics") return "Using precomputed metrics...";
  if (phase === "searching-index") return "Searching tool and query index...";
  if (phase === "scanning-summary-chunks") return "Scanning summary chunks...";
  if (phase === "reading-targeted-raw") return "Reading targeted raw JSONL slices...";
  if (phase === "reading-full-raw") return "Reading full raw JSONL...";
  if (phase === "preparing-context") return "Preparing session context...";
  if (phase === "retrieving-context") return "Retrieving session context...";
  if (phase === "resuming-session") return "Resuming previous Q&A session...";
  if (phase === "starting-session") return "Starting Q&A session...";
  if (phase === "waiting-for-model") return "Waiting for model response...";
  if (phase === "thinking") return "Thinking through the session...";
  if (phase === "detail-fetch") return "Fetching detailed tool output...";
  if (phase === "streaming-answer") return "Streaming answer...";
  return "Working on your question...";
}

export function buildQAProgressPayload(phase, options) {
  var opts = options && typeof options === "object" ? options : {};
  var payload = {
    status: getQAProgressStatus(phase, opts),
  };
  if (phase) payload.phase = phase;

  var detail = typeof opts.detail === "string" ? opts.detail.trim() : "";
  if (!detail && (phase === "tool-running" || phase === "tool-finished")) {
    detail = describeQAToolDetail(opts.toolName) || "";
  }
  if (detail) payload.detail = detail;

  var elapsedMs = sanitizeQAElapsedMs(opts.elapsedMs);
  if (elapsedMs !== null) payload.elapsedMs = elapsedMs;
  if (opts.heartbeat) payload.heartbeat = true;
  return payload;
}
