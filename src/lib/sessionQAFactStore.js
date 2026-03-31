import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sliceRawJsonlRange } from "./sessionQA.js";

export var SESSION_QA_FACT_STORE_VERSION = 1;

var sqliteModulePromise = null;

function hashText(text) {
  var value = 0;
  var source = text || "";

  for (var index = 0; index < source.length; index += 1) {
    value = ((value << 5) - value + source.charCodeAt(index)) | 0;
  }

  return String(Math.abs(value));
}

function normalizeSearchValue(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function uniqueValues(values) {
  var results = [];
  var seen = new Set();

  for (var index = 0; index < values.length; index += 1) {
    var value = values[index];
    if (!value || seen.has(value)) continue;
    seen.add(value);
    results.push(value);
  }

  return results;
}

function pluralize(value, singular, plural) {
  var count = Number(value) || 0;
  return count + " " + (count === 1 ? singular : (plural || singular + "s"));
}

function formatDuration(seconds) {
  var numericSeconds = typeof seconds === "number" ? seconds : Number(seconds);
  if (!Number.isFinite(numericSeconds) || numericSeconds < 0) return "0s";
  var totalSeconds = Math.round(numericSeconds);
  var hours = Math.floor(totalSeconds / 3600);
  var minutes = Math.floor((totalSeconds % 3600) / 60);
  var remainingSeconds = totalSeconds % 60;
  var parts = [];
  if (hours > 0) parts.push(hours + "h");
  if (minutes > 0) parts.push(minutes + "m");
  if (remainingSeconds > 0 || parts.length === 0) parts.push(remainingSeconds + "s");
  return parts.join(" ");
}

function truncate(value, maxChars) {
  var source = typeof value === "string" ? value.trim() : "";
  if (!source) return "";
  if (!maxChars || source.length <= maxChars) return source;
  return source.slice(0, Math.max(0, maxChars - 1)).trimEnd() + "...";
}

function parseJson(value, fallback) {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

async function getSqliteModule() {
  if (!sqliteModulePromise) {
    sqliteModulePromise = import("node:sqlite").catch(function () {
      return null;
    });
  }
  return sqliteModulePromise;
}

export function getSessionQAFactStoreCacheDir(homeDir) {
  return path.join(homeDir || os.homedir(), ".agentviz", "session-qa-cache");
}

export function getSessionQAFactStoreSidecarPath(sessionFilePath) {
  if (!sessionFilePath) return null;
  var ext = path.extname(sessionFilePath);
  if (ext.toLowerCase() === ".jsonl") {
    return sessionFilePath.slice(0, sessionFilePath.length - ext.length) + ".agentviz-qa.sqlite";
  }
  return sessionFilePath + ".agentviz-qa.sqlite";
}

export function getManagedSessionQAFactStorePath(fingerprint, homeDir) {
  return path.join(
    getSessionQAFactStoreCacheDir(homeDir),
    "session-" + hashText(String(fingerprint || "")) + ".sqlite"
  );
}

function factStoreMetaMatches(db, fingerprint) {
  try {
    var versionRow = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    var fingerprintRow = db.prepare("SELECT value FROM meta WHERE key = 'fingerprint'").get();
    return Number(versionRow && versionRow.value) === SESSION_QA_FACT_STORE_VERSION &&
      String(fingerprintRow && fingerprintRow.value || "") === String(fingerprint || "");
  } catch (error) {
    return false;
  }
}

async function openReusableFactStore(filePath, fingerprint) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  var sqlite = await getSqliteModule();
  if (!sqlite) return null;
  var db = null;
  try {
    db = new sqlite.DatabaseSync(filePath);
    if (!factStoreMetaMatches(db, fingerprint)) {
      db.close();
      return null;
    }
    db.close();
    return {
      fingerprint: String(fingerprint || ""),
      path: filePath,
      reused: true,
      version: SESSION_QA_FACT_STORE_VERSION,
    };
  } catch (error) {
    if (db) {
      try { db.close(); } catch (closeError) {}
    }
    return null;
  }
}

function createFactStoreSchema(db) {
  db.exec([
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS session_metrics (metric_key TEXT PRIMARY KEY, numeric_value REAL, text_value TEXT, json_value TEXT, ref_json TEXT)",
    "CREATE TABLE IF NOT EXISTS turns (turn_index INTEGER PRIMARY KEY, user_message TEXT, summary TEXT, event_count INTEGER, tool_count INTEGER, error_count INTEGER, has_error INTEGER, start_time REAL, end_time REAL, tool_names_json TEXT, focus_entities_json TEXT)",
    "CREATE TABLE IF NOT EXISTS tool_calls (call_id TEXT PRIMARY KEY, turn_index INTEGER, event_index INTEGER, turn_tool_index INTEGER, tool_name TEXT, tool_name_normalized TEXT, duration REAL, is_error INTEGER, payload_type TEXT, operation TEXT, buckets_json TEXT, input_preview TEXT, output_preview TEXT, user_message TEXT, path_preview TEXT, query_preview TEXT, command_preview TEXT, raw_line_start INTEGER, raw_line_end INTEGER, raw_char_start INTEGER, raw_char_end INTEGER)",
    "CREATE TABLE IF NOT EXISTS tool_call_entities (call_id TEXT NOT NULL, turn_index INTEGER, tool_name_normalized TEXT, entity_type TEXT NOT NULL, entity_value TEXT NOT NULL, PRIMARY KEY (call_id, entity_type, entity_value))",
    "CREATE TABLE IF NOT EXISTS summary_chunks (chunk_index INTEGER PRIMARY KEY, start_turn INTEGER, end_turn INTEGER, turn_count INTEGER, error_count INTEGER, has_error INTEGER, tool_names_json TEXT, focus_entities_json TEXT, summary TEXT, raw_range_json TEXT)",
    "CREATE TABLE IF NOT EXISTS fax_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
  ].join(";"));
  db.exec([
    "CREATE INDEX IF NOT EXISTS tool_calls_tool_name_idx ON tool_calls(tool_name_normalized)",
    "CREATE INDEX IF NOT EXISTS tool_calls_turn_idx ON tool_calls(turn_index)",
    "CREATE INDEX IF NOT EXISTS tool_call_entities_lookup_idx ON tool_call_entities(entity_type, entity_value)",
    "CREATE INDEX IF NOT EXISTS tool_call_entities_turn_idx ON tool_call_entities(turn_index)"
  ].join(";"));
}

function clearFactStoreTables(db) {
  db.exec([
    "DELETE FROM meta",
    "DELETE FROM session_metrics",
    "DELETE FROM turns",
    "DELETE FROM tool_calls",
    "DELETE FROM tool_call_entities",
    "DELETE FROM summary_chunks",
    "DELETE FROM fax_metadata"
  ].join(";"));
}

function writeFactStoreMeta(db, fingerprint, builtAt, storage, sessionFilePath) {
  var insertMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  insertMeta.run("version", String(SESSION_QA_FACT_STORE_VERSION));
  insertMeta.run("fingerprint", String(fingerprint || ""));
  insertMeta.run("built_at", builtAt || "");
  insertMeta.run("storage", storage || "");
  insertMeta.run("session_file_path", sessionFilePath || "");
}

function writeFactStoreMetrics(db, metricCatalog) {
  var safeCatalog = metricCatalog && typeof metricCatalog === "object" ? metricCatalog : {};
  var insertMetric = db.prepare(
    "INSERT INTO session_metrics (metric_key, numeric_value, text_value, json_value, ref_json) VALUES (?, ?, ?, ?, ?)"
  );
  var keys = Object.keys(safeCatalog);

  for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
    var key = keys[keyIndex];
    var value = safeCatalog[key];
    var numericValue = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numericValue)) numericValue = null;
    var textValue = typeof value === "string" ? value : null;
    var jsonValue = value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? null
      : JSON.stringify(value);
    insertMetric.run(key, numericValue, textValue, jsonValue, null);
  }
}

function writeFactStoreFaxMetadata(db, faxMetadata) {
  if (!faxMetadata || typeof faxMetadata !== "object") return;
  var insert = db.prepare("INSERT OR REPLACE INTO fax_metadata (key, value) VALUES (?, ?)");
  var manifest = faxMetadata;

  if (manifest.sender) {
    var s = manifest.sender;
    var senderStr = typeof s === "string" ? s : (s.alias || s.email || s.name || JSON.stringify(s));
    insert.run("sender", senderStr);
    if (s.email && typeof s.email === "string") insert.run("sender_email", s.email);
    if (s.alias && typeof s.alias === "string") insert.run("sender_alias", s.alias);
    if (s.program && typeof s.program === "string") insert.run("sender_tool", s.program);
  }
  if (manifest.importance) insert.run("importance", String(manifest.importance));
  if (manifest.thread) insert.run("thread", String(manifest.thread));
  if (manifest.summary) insert.run("summary", String(manifest.summary));
  if (manifest.timestamp) insert.run("timestamp", String(manifest.timestamp));
  if (manifest.repo) insert.run("repo", String(manifest.repo));
  if (manifest.branch) insert.run("branch", String(manifest.branch));
  if (manifest.bundleLabel) insert.run("bundle_label", String(manifest.bundleLabel));
  if (manifest.program) insert.run("program", String(manifest.program));
  if (manifest.progress) {
    if (Array.isArray(manifest.progress.stepsCompleted) && manifest.progress.stepsCompleted.length > 0) {
      insert.run("steps_completed", manifest.progress.stepsCompleted.join(", "));
      insert.run("steps_completed_count", String(manifest.progress.stepsCompleted.length));
    }
    if (Array.isArray(manifest.progress.stepsRemaining) && manifest.progress.stepsRemaining.length > 0) {
      insert.run("steps_remaining", manifest.progress.stepsRemaining.join(", "));
      insert.run("steps_remaining_count", String(manifest.progress.stepsRemaining.length));
    }
  }
  if (Array.isArray(manifest.doNotRetry) && manifest.doNotRetry.length > 0) {
    insert.run("do_not_retry", manifest.doNotRetry.join(", "));
  }
}

function writeFactStoreTurns(db, turnSummaries) {
  var safeTurns = Array.isArray(turnSummaries) ? turnSummaries : [];
  var insertTurn = db.prepare(
    "INSERT INTO turns (turn_index, user_message, summary, event_count, tool_count, error_count, has_error, start_time, end_time, tool_names_json, focus_entities_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );

  for (var index = 0; index < safeTurns.length; index += 1) {
    var turn = safeTurns[index];
    if (!turn || turn.turnIndex == null) continue;
    insertTurn.run(
      Number(turn.turnIndex),
      typeof turn.userMessage === "string" ? turn.userMessage : "",
      typeof turn.summary === "string" ? turn.summary : "",
      Number(turn.eventCount) || 0,
      Number(turn.toolCount) || 0,
      Number(turn.errorCount) || 0,
      turn.hasError ? 1 : 0,
      typeof turn.startTime === "number" ? turn.startTime : null,
      typeof turn.endTime === "number" ? turn.endTime : null,
      JSON.stringify(Array.isArray(turn.toolNames) ? turn.toolNames : []),
      JSON.stringify(Array.isArray(turn.focusEntities) ? turn.focusEntities : [])
    );
  }
}

function writeFactStoreToolCalls(db, ledger) {
  var safeLedger = Array.isArray(ledger) ? ledger : [];
  var insertCall = db.prepare(
    "INSERT INTO tool_calls (call_id, turn_index, event_index, turn_tool_index, tool_name, tool_name_normalized, duration, is_error, payload_type, operation, buckets_json, input_preview, output_preview, user_message, path_preview, query_preview, command_preview, raw_line_start, raw_line_end, raw_char_start, raw_char_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  var insertEntity = db.prepare(
    "INSERT OR IGNORE INTO tool_call_entities (call_id, turn_index, tool_name_normalized, entity_type, entity_value) VALUES (?, ?, ?, ?, ?)"
  );

  for (var index = 0; index < safeLedger.length; index += 1) {
    var entry = safeLedger[index];
    if (!entry || !entry.id) continue;
    var classification = entry.classification && typeof entry.classification === "object" ? entry.classification : {};
    var entities = entry.entities && typeof entry.entities === "object" ? entry.entities : {};
    var pathValues = Array.isArray(entities.paths) ? entities.paths : [];
    var queryValues = Array.isArray(entities.queries) ? entities.queries : [];
    var commandValues = Array.isArray(entities.commands) ? entities.commands : [];
    var rawSlice = entry.rawSlice && typeof entry.rawSlice === "object" ? entry.rawSlice : {};

    insertCall.run(
      String(entry.id),
      entry.turnIndex != null ? Number(entry.turnIndex) : null,
      entry.eventIndex != null ? Number(entry.eventIndex) : null,
      entry.turnToolIndex != null ? Number(entry.turnToolIndex) : null,
      String(entry.toolName || "unknown"),
      String(entry.toolNameNormalized || normalizeSearchValue(entry.toolName)),
      typeof entry.duration === "number" ? entry.duration : Number(entry.duration) || 0,
      entry.isError ? 1 : 0,
      classification.payloadType || null,
      classification.operation || null,
      JSON.stringify(Array.isArray(classification.buckets) ? classification.buckets : []),
      typeof entry.inputPreview === "string" ? entry.inputPreview : "",
      typeof entry.outputPreview === "string" ? entry.outputPreview : "",
      typeof entry.userMessage === "string" ? entry.userMessage : "",
      pathValues.length > 0 ? String(pathValues[0]) : null,
      queryValues.length > 0 ? String(queryValues[0]) : null,
      commandValues.length > 0 ? String(commandValues[0]) : null,
      rawSlice.lineStart != null ? Number(rawSlice.lineStart) : null,
      rawSlice.lineEnd != null ? Number(rawSlice.lineEnd) : null,
      rawSlice.charStart != null ? Number(rawSlice.charStart) : null,
      rawSlice.charEnd != null ? Number(rawSlice.charEnd) : null
    );

    var entityTypes = Object.keys(entities);
    for (var entityIndex = 0; entityIndex < entityTypes.length; entityIndex += 1) {
      var entityType = entityTypes[entityIndex];
      var entityValues = Array.isArray(entities[entityType]) ? entities[entityType] : [];
      for (var valueIndex = 0; valueIndex < entityValues.length; valueIndex += 1) {
        var normalizedValue = normalizeSearchValue(entityValues[valueIndex]);
        if (!normalizedValue) continue;
        insertEntity.run(
          String(entry.id),
          entry.turnIndex != null ? Number(entry.turnIndex) : null,
          String(entry.toolNameNormalized || normalizeSearchValue(entry.toolName)),
          String(entityType),
          normalizedValue
        );
      }
    }
  }
}

function writeFactStoreSummaryChunks(db, summaryChunks) {
  var safeChunks = Array.isArray(summaryChunks) ? summaryChunks : [];
  var insertChunk = db.prepare(
    "INSERT INTO summary_chunks (chunk_index, start_turn, end_turn, turn_count, error_count, has_error, tool_names_json, focus_entities_json, summary, raw_range_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );

  for (var index = 0; index < safeChunks.length; index += 1) {
    var chunk = safeChunks[index];
    if (!chunk || chunk.chunkIndex == null) continue;
    insertChunk.run(
      Number(chunk.chunkIndex),
      chunk.startTurn != null ? Number(chunk.startTurn) : null,
      chunk.endTurn != null ? Number(chunk.endTurn) : null,
      Number(chunk.turnCount) || 0,
      Number(chunk.errorCount) || 0,
      chunk.hasError ? 1 : 0,
      JSON.stringify(Array.isArray(chunk.toolNames) ? chunk.toolNames : []),
      JSON.stringify(Array.isArray(chunk.focusEntities) ? chunk.focusEntities : []),
      typeof chunk.summary === "string" ? chunk.summary : "",
      chunk.rawRange ? JSON.stringify(chunk.rawRange) : null
    );
  }
}

async function buildFactStoreAtPath(filePath, entry, precomputed, storage) {
  var sqlite = await getSqliteModule();
  if (!sqlite) return null;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try { fs.unlinkSync(filePath); } catch (error) {}

  var db = new sqlite.DatabaseSync(filePath);
  try {
    createFactStoreSchema(db);
    db.exec("BEGIN");
    clearFactStoreTables(db);
    writeFactStoreMeta(
      db,
      precomputed && precomputed.fingerprint,
      precomputed && precomputed.builtAt ? precomputed.builtAt : new Date().toISOString(),
      storage,
      entry && entry.sessionFilePath ? String(entry.sessionFilePath) : ""
    );
    writeFactStoreMetrics(db, precomputed && precomputed.artifacts && precomputed.artifacts.metricCatalog);
    writeFactStoreFaxMetadata(db, entry && entry.faxMetadata);
    writeFactStoreTurns(db, precomputed && precomputed.artifacts && precomputed.artifacts.turnSummaries);
    writeFactStoreToolCalls(db, precomputed && precomputed.artifacts && precomputed.artifacts.ledger);
    writeFactStoreSummaryChunks(db, precomputed && precomputed.artifacts && precomputed.artifacts.summaryChunks);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch (rollbackError) {}
    db.close();
    throw error;
  }
  db.close();
}

export async function ensureSessionQAFactStore(entry, precomputed, options) {
  if (!entry || !precomputed || !precomputed.fingerprint || !precomputed.artifacts) return null;
  if (
    entry.factStore &&
    entry.factStore.fingerprint === precomputed.fingerprint &&
    entry.factStore.path &&
    fs.existsSync(entry.factStore.path)
  ) {
    return entry.factStore;
  }

  var opts = options && typeof options === "object" ? options : {};
  var candidates = [];
  var sidecarPath = entry.sessionFilePath ? getSessionQAFactStoreSidecarPath(entry.sessionFilePath) : null;
  var managedPath = getManagedSessionQAFactStorePath(precomputed.fingerprint, opts.homeDir);
  if (sidecarPath) candidates.push({ path: sidecarPath, storage: "sidecar" });
  candidates.push({ path: managedPath, storage: "managed" });

  for (var reuseIndex = 0; reuseIndex < candidates.length; reuseIndex += 1) {
    var reused = await openReusableFactStore(candidates[reuseIndex].path, precomputed.fingerprint);
    if (!reused) continue;
    entry.factStore = {
      fingerprint: precomputed.fingerprint,
      path: candidates[reuseIndex].path,
      storage: candidates[reuseIndex].storage,
      builtAt: precomputed.builtAt || null,
      reused: true,
      version: SESSION_QA_FACT_STORE_VERSION,
    };
    return entry.factStore;
  }

  for (var buildIndex = 0; buildIndex < candidates.length; buildIndex += 1) {
    try {
      await buildFactStoreAtPath(candidates[buildIndex].path, entry, precomputed, candidates[buildIndex].storage);
      entry.factStore = {
        fingerprint: precomputed.fingerprint,
        path: candidates[buildIndex].path,
        storage: candidates[buildIndex].storage,
        builtAt: precomputed.builtAt || new Date().toISOString(),
        reused: false,
        version: SESSION_QA_FACT_STORE_VERSION,
      };
      return entry.factStore;
    } catch (error) {}
  }

  entry.factStore = {
    fingerprint: precomputed.fingerprint,
    path: null,
    storage: "memory",
    builtAt: precomputed.builtAt || new Date().toISOString(),
    reused: false,
    version: SESSION_QA_FACT_STORE_VERSION,
  };
  return entry.factStore;
}

async function openFactStoreDatabase(factStore) {
  if (!factStore || !factStore.path || !fs.existsSync(factStore.path)) return null;
  var sqlite = await getSqliteModule();
  if (!sqlite) return null;
  return new sqlite.DatabaseSync(factStore.path);
}

function loadTurnSummary(db, turnIndex) {
  return db.prepare("SELECT * FROM turns WHERE turn_index = ?").get(Number(turnIndex));
}

function loadMaxTurnIndex(db) {
  var row = db.prepare("SELECT MAX(turn_index) AS max_turn FROM turns").get();
  return row && typeof row.max_turn === "number" ? row.max_turn : null;
}

function loadTurnToolCalls(db, turnIndex, limit) {
  return db.prepare(
    "SELECT tool_name, duration, is_error FROM tool_calls WHERE turn_index = ? ORDER BY event_index LIMIT ?"
  ).all(Number(turnIndex), Number(limit) || 6);
}

function buildTurnLookupAnswer(turnRow, toolRows) {
  if (!turnRow) return null;
  var toolNames = uniqueValues(toolRows.map(function (row) { return row.tool_name; }));
  var parts = [
    "Turn " + turnRow.turn_index + " ran " + pluralize(turnRow.tool_count, "tool call") + ".",
  ];
  if (turnRow.user_message) parts.push("User prompt: \"" + truncate(turnRow.user_message, 200) + "\"");
  if (toolNames.length > 0) parts.push("Tools: " + toolNames.join(", ") + ".");
  if (turnRow.has_error) parts.push("It included " + pluralize(turnRow.error_count || 1, "error") + ".");
  if (turnRow.start_time != null && turnRow.end_time != null) {
    var duration = Number(turnRow.end_time) - Number(turnRow.start_time);
    if (duration > 0) parts.push("Duration: " + formatDuration(duration) + ".");
  }
  if (turnRow.summary) parts.push("Summary: " + truncate(turnRow.summary, 320));
  return {
    answer: parts.join(" "),
    references: [{ turnIndex: turnRow.turn_index }],
    detail: "Queried the SQLite fact store for the requested turn summary.",
  };
}

function lookupToolUsage(db, toolName, turnHint) {
  var normalizedToolName = normalizeSearchValue(toolName);
  if (!normalizedToolName) return null;

  if (turnHint != null) {
    var turnRows = db.prepare(
      "SELECT tool_name, duration, output_preview FROM tool_calls WHERE tool_name_normalized = ? AND turn_index = ? ORDER BY event_index"
    ).all(normalizedToolName, Number(turnHint));
    if (!turnRows || turnRows.length === 0) return null;
    var longestTurnRow = turnRows.slice().sort(function (left, right) {
      return Number(right.duration || 0) - Number(left.duration || 0);
    })[0];
    return {
      answer:
        "In Turn " + Number(turnHint) + ", " + turnRows[0].tool_name + " ran " +
        pluralize(turnRows.length, "time") + "." +
        (longestTurnRow && Number(longestTurnRow.duration) > 0
          ? " The longest call lasted " + formatDuration(longestTurnRow.duration) + "."
          : "") +
        (longestTurnRow && longestTurnRow.output_preview
          ? " Preview: " + truncate(longestTurnRow.output_preview, 220)
          : ""),
      references: [{ turnIndex: Number(turnHint) }],
      detail: "Queried the SQLite fact store for tool usage in the requested turn.",
    };
  }

  var aggregate = db.prepare(
    "SELECT tool_name, COUNT(*) AS use_count, COUNT(DISTINCT turn_index) AS turn_count, MAX(duration) AS max_duration FROM tool_calls WHERE tool_name_normalized = ? GROUP BY tool_name"
  ).get(normalizedToolName);
  if (!aggregate) return null;
  var sampleTurns = db.prepare(
    "SELECT DISTINCT turn_index FROM tool_calls WHERE tool_name_normalized = ? ORDER BY turn_index LIMIT 4"
  ).all(normalizedToolName);
  var turnLabels = sampleTurns.map(function (row) { return "Turn " + row.turn_index; });
  return {
    answer:
      "The session used " + aggregate.tool_name + " " + pluralize(aggregate.use_count, "time") +
      " across " + pluralize(aggregate.turn_count, "turn") + "." +
      (Number(aggregate.max_duration) > 0
        ? " The longest " + aggregate.tool_name + " call lasted " + formatDuration(aggregate.max_duration) + "."
        : "") +
      (turnLabels.length > 0 ? " Matches appeared in " + turnLabels.join(", ") + "." : ""),
    references: sampleTurns.map(function (row) { return { turnIndex: row.turn_index }; }),
    detail: "Queried the SQLite fact store for tool usage across the session.",
  };
}

function lookupEntityUsage(db, entityType, entityValue, detailLabel) {
  var normalizedValue = normalizeSearchValue(entityValue);
  if (!normalizedValue) return null;
  var rows = db.prepare(
    "SELECT tool_name_normalized, turn_index FROM tool_call_entities WHERE entity_type = ? AND entity_value LIKE ? ORDER BY turn_index"
  ).all(entityType, "%" + normalizedValue + "%");
  if (!rows || rows.length === 0) return null;
  var turnIndices = uniqueValues(rows.map(function (row) { return row.turn_index; })).slice(0, 5);
  var toolNames = uniqueValues(rows.map(function (row) { return row.tool_name_normalized; })).slice(0, 5);
  return {
    answer:
      "The session referenced " + entityValue + " in " + pluralize(rows.length, "tool call") +
      " across " + pluralize(turnIndices.length, "turn") + "." +
      (toolNames.length > 0 ? " Matching tools: " + toolNames.join(", ") + "." : ""),
    references: turnIndices.map(function (turnIndex) { return { turnIndex: turnIndex }; }),
    detail: detailLabel,
  };
}

function lookupExactEvidence(db, program, rawText) {
  if (typeof rawText !== "string" || !rawText) return null;
  var turnHint = program.slots.turnHints.length > 0 ? program.slots.turnHints[0] : null;
  var toolName = program.slots.toolNames.length > 0 ? program.slots.toolNames[0] : null;
  var pathTerm = program.slots.pathTerms.length > 0 ? program.slots.pathTerms[0] : null;

  var row = null;
  if (turnHint != null && toolName) {
    row = db.prepare(
      "SELECT * FROM tool_calls WHERE turn_index = ? AND tool_name_normalized = ? AND raw_char_start IS NOT NULL AND raw_char_end IS NOT NULL ORDER BY event_index LIMIT 1"
    ).get(Number(turnHint), normalizeSearchValue(toolName));
  }
  if (!row && turnHint != null && pathTerm) {
    row = db.prepare(
      "SELECT tc.* FROM tool_calls tc JOIN tool_call_entities ent ON ent.call_id = tc.call_id WHERE tc.turn_index = ? AND ent.entity_type = 'paths' AND ent.entity_value LIKE ? AND tc.raw_char_start IS NOT NULL AND tc.raw_char_end IS NOT NULL ORDER BY tc.event_index LIMIT 1"
    ).get(Number(turnHint), "%" + normalizeSearchValue(pathTerm) + "%");
  }
  if (!row && turnHint != null) {
    row = db.prepare(
      "SELECT * FROM tool_calls WHERE turn_index = ? AND raw_char_start IS NOT NULL AND raw_char_end IS NOT NULL ORDER BY event_index LIMIT 1"
    ).get(Number(turnHint));
  }
  if (!row) return null;

  var snippet = sliceRawJsonlRange(rawText, {
    lineStart: row.raw_line_start,
    lineEnd: row.raw_line_end,
    charStart: row.raw_char_start,
    charEnd: row.raw_char_end,
  });
  var boundedSnippet = truncate(snippet, 700);
  if (!boundedSnippet) return null;

  return {
    answer:
      "The strongest exact raw JSONL match is a " + row.tool_name + " call in Turn " + row.turn_index + ":\n\n```json\n" +
      boundedSnippet +
      "\n```",
    references: [{ turnIndex: row.turn_index }],
    detail: "Queried the SQLite fact store for exact raw evidence before falling back to the model.",
  };
}

function buildErrorSummaryContext(db, program) {
  var clauses = ["is_error = 1"];
  var params = [];

  if (program.slots.turnHints.length > 0) {
    clauses.push("turn_index = ?");
    params.push(Number(program.slots.turnHints[0]));
  }
  if (program.slots.toolNames.length > 0) {
    clauses.push("tool_name_normalized = ?");
    params.push(normalizeSearchValue(program.slots.toolNames[0]));
  }

  var statement = db.prepare(
    "SELECT turn_index, tool_name, output_preview FROM tool_calls WHERE " + clauses.join(" AND ") + " ORDER BY turn_index LIMIT 5"
  );
  var rows = statement.all.apply(statement, params);
  if (!rows || rows.length === 0) {
    return {
      answer: "No errors were recorded in this session.",
      references: [],
      detail: "Queried the SQLite fact store and found no error records.",
      model: "AGENTVIZ SQLite fact store",
    };
  }

  var lines = [];
  for (var index = 0; index < rows.length; index += 1) {
    lines.push(
      "- Turn " + rows[index].turn_index + " | " + rows[index].tool_name + " | " +
      truncate(rows[index].output_preview || "", 220)
    );
  }

  return {
    answer: "The session recorded " + pluralize(rows.length, "error") + ":\n" + lines.join("\n"),
    references: rows.map(function (row) { return { turnIndex: row.turn_index }; }),
    detail: "Built a compact error summary from the SQLite fact store.",
    model: "AGENTVIZ SQLite fact store",
  };
}

function buildChunkSummaryContext(db, heading) {
  var totalChunks = db.prepare("SELECT COUNT(*) AS cnt FROM summary_chunks").get();
  var chunkCount = totalChunks ? Number(totalChunks.cnt) : 0;
  
  // Select chunks from diverse positions: first, middle, and last
  var rows = [];
  if (chunkCount <= 4) {
    var allStmt = db.prepare(
      "SELECT start_turn, end_turn, summary FROM summary_chunks ORDER BY chunk_index"
    );
    rows = allStmt.all();
  } else {
    // Pick first, 1/3, 2/3, and last chunks for diversity
    var indices = [0, Math.floor(chunkCount / 3), Math.floor(2 * chunkCount / 3), chunkCount - 1];
    var seen = {};
    for (var ci = 0; ci < indices.length; ci++) {
      if (seen[indices[ci]]) continue;
      seen[indices[ci]] = true;
      var chunkStmt = db.prepare(
        "SELECT start_turn, end_turn, summary FROM summary_chunks WHERE chunk_index = ?"
      );
      var row = chunkStmt.get(indices[ci]);
      if (row) rows.push(row);
    }
  }
  if (!rows || rows.length === 0) return null;

  // Add session metrics preamble for richer context
  var metricRows = db.prepare("SELECT metric_key, numeric_value, text_value FROM session_metrics WHERE metric_key IN ('totalTurns', 'totalToolCalls', 'errorCount', 'duration') LIMIT 4").all();
  var metricMap = {};
  for (var mi = 0; mi < metricRows.length; mi++) {
    metricMap[metricRows[mi].metric_key] = metricRows[mi].numeric_value != null ? metricRows[mi].numeric_value : metricRows[mi].text_value;
  }

  var lines = [heading];
  if (Object.keys(metricMap).length > 0) {
    var metricParts = [];
    if (metricMap.totalTurns != null) metricParts.push(pluralize(metricMap.totalTurns, "turn"));
    if (metricMap.totalToolCalls != null) metricParts.push(pluralize(metricMap.totalToolCalls, "tool call"));
    if (metricMap.errorCount != null) metricParts.push(pluralize(metricMap.errorCount, "error"));
    if (metricMap.duration != null) metricParts.push(formatDuration(metricMap.duration));
    if (metricParts.length > 0) lines.push("Session: " + metricParts.join(", "));
  }

  for (var index = 0; index < rows.length; index += 1) {
    lines.push(
      "- Turns " + rows[index].start_turn + "-" + rows[index].end_turn + ": " +
      truncate(rows[index].summary || "", 260)
    );
  }

  return {
    context: lines.join("\n"),
    detail: "Built a compact session summary from the SQLite fact store.",
  };
}

export async function querySessionQAFactStore(queryProgram, factStore, options) {
  if (!queryProgram || !factStore || !factStore.path) return null;
  var opts = options && typeof options === "object" ? options : {};
  var db = await openFactStoreDatabase(factStore);
  if (!db) return null;

  try {
    // Fax metadata lookup — deterministic answers for sender, importance, repo, etc.
    if (queryProgram.family === "fax-metadata") {
      var faxRows = null;
      try { faxRows = db.prepare("SELECT key, value FROM fax_metadata").all(); } catch (_) {}
      if (faxRows && faxRows.length > 0) {
        var faxMap = {};
        for (var fi = 0; fi < faxRows.length; fi++) faxMap[faxRows[fi].key] = faxRows[fi].value;
        var faxSlot = queryProgram.slots && queryProgram.slots.faxMetadataKey || "";
        // Direct key lookup
        if (faxSlot && faxMap[faxSlot]) {
          return {
            answer: "**" + faxSlot.replace(/_/g, " ") + "**: " + faxMap[faxSlot],
            references: [],
            detail: "Looked up fax metadata key: " + faxSlot,
            model: "AGENTVIZ fax metadata",
          };
        }
        // Build a full metadata summary
        var faxLines = [];
        var displayOrder = ["sender", "sender_email", "sender_tool", "importance", "repo", "branch", "bundle_label", "summary", "timestamp", "thread", "steps_completed", "steps_remaining", "do_not_retry"];
        for (var di = 0; di < displayOrder.length; di++) {
          if (faxMap[displayOrder[di]]) {
            faxLines.push("- **" + displayOrder[di].replace(/_/g, " ") + "**: " + faxMap[displayOrder[di]]);
          }
        }
        if (faxLines.length > 0) {
          return {
            answer: "Fax metadata:\n" + faxLines.join("\n"),
            references: [],
            detail: "Retrieved all fax metadata from the SQLite fact store.",
            model: "AGENTVIZ fax metadata",
          };
        }
      }
      return null;
    }

    // Implicit turn lookup for "last turn" / "first turn" questions
    if ((queryProgram.family === "session-summary" || queryProgram.family === "broad-synthesis") &&
        queryProgram.normalizedQuestion) {
      var nq = queryProgram.normalizedQuestion;
      var implicitTurnIndex = null;
      if (/\b(last|final)\s+turn\b/.test(nq)) {
        implicitTurnIndex = loadMaxTurnIndex(db);
      } else if (/\b(first|initial|opening)\s+turn\b/.test(nq)) {
        implicitTurnIndex = 0;
      }
      if (implicitTurnIndex !== null) {
        var implicitRow = loadTurnSummary(db, implicitTurnIndex);
        if (implicitRow) {
          var implicitTools = loadTurnToolCalls(db, implicitTurnIndex, 6);
          return Object.assign(buildTurnLookupAnswer(implicitRow, implicitTools), {
            model: "AGENTVIZ SQLite fact store",
          });
        }
      }
    }

    if (queryProgram.family === "turn-lookup" && queryProgram.slots.turnHints.length > 0) {
      var turnIndex = queryProgram.slots.turnHints[0];
      // Resolve symbolic turn hints: -1 means "last turn"
      if (turnIndex === -1) {
        var resolvedMax = loadMaxTurnIndex(db);
        turnIndex = resolvedMax !== null ? resolvedMax : 0;
      }
      var turnRow = loadTurnSummary(db, turnIndex);
      if (!turnRow) {
        var maxTurn = loadMaxTurnIndex(db);
        if (maxTurn !== null) {
          return {
            answer: "Turn " + turnIndex + " is out of range. This session uses zero-based turn indexing, so valid turns are 0 through " + maxTurn + ". Try asking about Turn " + maxTurn + " to see the last turn, or Turn 0 to see the first.",
            references: [],
            model: "AGENTVIZ turn-range guard",
          };
        }
        return null;
      }
      var toolRows = loadTurnToolCalls(db, turnIndex, 6);
      return Object.assign(buildTurnLookupAnswer(turnRow, toolRows), {
        model: "AGENTVIZ SQLite fact store",
      });
    }

    if (queryProgram.family === "tool-lookup" && queryProgram.slots.toolNames.length > 0) {
      var toolResult = lookupToolUsage(
        db,
        queryProgram.slots.toolNames[0],
        queryProgram.slots.turnHints.length > 0 ? queryProgram.slots.turnHints[0] : null
      );
      return toolResult ? Object.assign(toolResult, { model: "AGENTVIZ SQLite fact store" }) : null;
    }

    if (queryProgram.family === "tool-lookup" && queryProgram.slots.toolNames.length === 0) {
      var allToolRows = db.prepare(
        "SELECT tool_name, COUNT(*) AS use_count, COUNT(DISTINCT turn_index) AS turn_count, ROUND(SUM(duration), 1) AS total_duration FROM tool_calls GROUP BY tool_name ORDER BY use_count DESC LIMIT 15"
      ).all();
      if (allToolRows && allToolRows.length > 0) {
        var toolLines = allToolRows.map(function (row) {
          var parts = ["- " + row.tool_name + ": " + pluralize(row.use_count, "call") + " across " + pluralize(row.turn_count, "turn")];
          if (Number(row.total_duration) > 0) parts[0] += " (" + formatDuration(row.total_duration) + " total)";
          return parts[0];
        });
        return {
          answer: "The session used " + pluralize(allToolRows.length, "tool") + ":\n" + toolLines.join("\n"),
          references: [],
          detail: "Listed all tool usage from the SQLite fact store.",
          model: "AGENTVIZ SQLite fact store",
        };
      }
    }

    if (queryProgram.family === "file-lookup" && queryProgram.slots.pathTerms.length > 0) {
      var fileResult = lookupEntityUsage(
        db,
        "paths",
        queryProgram.slots.pathTerms[0],
        "Queried the SQLite fact store for file and path references."
      );
      return fileResult ? Object.assign(fileResult, { model: "AGENTVIZ SQLite fact store" }) : null;
    }

    if (queryProgram.family === "file-lookup" && queryProgram.slots.pathTerms.length === 0 && queryProgram.slots.wantsPaths) {
      var allFileRows = db.prepare(
        "SELECT entity_value, COUNT(*) AS ref_count, COUNT(DISTINCT turn_index) AS turn_count FROM tool_call_entities WHERE entity_type = 'paths' GROUP BY entity_value ORDER BY ref_count DESC LIMIT 15"
      ).all();
      if (allFileRows && allFileRows.length > 0) {
        var fileLines = allFileRows.map(function (row) {
          return "- " + row.entity_value + " (" + pluralize(row.ref_count, "reference") + " across " + pluralize(row.turn_count, "turn") + ")";
        });
        return {
          answer: "The session referenced " + pluralize(allFileRows.length, "file") + ":\n" + fileLines.join("\n"),
          references: [],
          detail: "Listed all file references from the SQLite fact store.",
          model: "AGENTVIZ SQLite fact store",
        };
      }
    }

    if (queryProgram.family === "command-query-lookup") {
      if (queryProgram.slots.commandTerms.length > 0) {
        var commandResult = lookupEntityUsage(
          db,
          "commands",
          queryProgram.slots.commandTerms[0],
          "Queried the SQLite fact store for command usage."
        );
        return commandResult ? Object.assign(commandResult, { model: "AGENTVIZ SQLite fact store" }) : null;
      }
      if (queryProgram.slots.queryTerms.length > 0) {
        var queryResult = lookupEntityUsage(
          db,
          "queries",
          queryProgram.slots.queryTerms[0],
          "Queried the SQLite fact store for query usage."
        );
        return queryResult ? Object.assign(queryResult, { model: "AGENTVIZ SQLite fact store" }) : null;
      }
      // Check for entity-specific terms from question matchers (e.g., "kusto" from "were any kusto queries run?")
      var matcherTerms = queryProgram.slots && queryProgram.slots.matchers;
      if (matcherTerms && matcherTerms.length > 0) {
        for (var mi = 0; mi < matcherTerms.length; mi++) {
          var matcherTerm = typeof matcherTerms[mi] === "string" ? matcherTerms[mi] : (matcherTerms[mi].term || matcherTerms[mi].value || "");
          if (!matcherTerm) continue;
          // Try as query entity first, then command, then tool name
          var mqResult = lookupEntityUsage(db, "queries", matcherTerm, "Queried for " + matcherTerm + " queries.");
          if (mqResult) return Object.assign(mqResult, { model: "AGENTVIZ SQLite fact store" });
          var mcResult = lookupEntityUsage(db, "commands", matcherTerm, "Queried for " + matcherTerm + " commands.");
          if (mcResult) return Object.assign(mcResult, { model: "AGENTVIZ SQLite fact store" });
          // Also check tool_calls by name match
          var toolMatchRows = db.prepare(
            "SELECT tool_name, COUNT(*) AS use_count FROM tool_calls WHERE tool_name_normalized LIKE ? GROUP BY tool_name ORDER BY use_count DESC LIMIT 10"
          ).all("%" + matcherTerm.toLowerCase() + "%");
          if (toolMatchRows && toolMatchRows.length > 0) {
            var tmLines = toolMatchRows.map(function (r) { return "- " + r.tool_name + ": " + pluralize(r.use_count, "call"); });
            return {
              answer: "Found " + pluralize(toolMatchRows.length, "tool") + " matching \"" + matcherTerm + "\":\n" + tmLines.join("\n"),
              references: [],
              detail: "Searched tool calls for " + matcherTerm,
              model: "AGENTVIZ SQLite fact store",
            };
          }
          // No matches found for this specific term
          return {
            answer: "No " + matcherTerm + " queries or commands were found in this session.",
            references: [],
            detail: "Searched commands, queries, and tool names for " + matcherTerm + " with zero results.",
            model: "AGENTVIZ SQLite fact store",
          };
        }
      }
      // Generic command/query listing when no specific terms are provided
      var allCommandRows = db.prepare(
        "SELECT entity_value, COUNT(*) AS ref_count, COUNT(DISTINCT turn_index) AS turn_count FROM tool_call_entities WHERE entity_type = 'commands' GROUP BY entity_value ORDER BY ref_count DESC LIMIT 15"
      ).all();
      if (allCommandRows && allCommandRows.length > 0) {
        var cmdLines = allCommandRows.map(function (row) {
          return "- `" + truncate(row.entity_value, 120) + "` (" + pluralize(row.ref_count, "call") + " across " + pluralize(row.turn_count, "turn") + ")";
        });
        return {
          answer: "The session ran " + pluralize(allCommandRows.length, "distinct command") + ":\n" + cmdLines.join("\n"),
          references: [],
          detail: "Listed all commands from the SQLite fact store.",
          model: "AGENTVIZ SQLite fact store",
        };
      }
    }

    if (queryProgram.family === "exact-raw-evidence") {
      var evidenceResult = lookupExactEvidence(db, queryProgram, opts.rawText);
      return evidenceResult ? Object.assign(evidenceResult, { model: "AGENTVIZ SQLite fact store" }) : null;
    }

    if (queryProgram.family === "error-diagnosis") {
      return buildErrorSummaryContext(db, queryProgram);
    }

    if (queryProgram.family === "session-summary") {
      return buildChunkSummaryContext(db, "=== FACT STORE SESSION SUMMARY ===");
    }

    if (queryProgram.family === "broad-synthesis") {
      return buildChunkSummaryContext(db, "=== FACT STORE SYNTHESIS SUMMARY ===");
    }

    return null;
  } finally {
    db.close();
  }
}
