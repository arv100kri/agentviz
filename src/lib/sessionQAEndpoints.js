/**
 * Shared Q&A HTTP endpoint handlers used by both server.js and fax-viz-server.js.
 *
 * Consolidates: readBody, session-qa-cache, session-qa-history, model answer cache,
 * and SSE setup to avoid duplication between the two servers.
 */

import os from "os";
import {
  ensureSessionQAPrecomputed,
  saveSessionQACacheEntry,
  getSessionQACacheEntry,
  removeSessionQACacheEntry,
  getSessionQAHistoryFilePath,
  getSessionQAHistoryEntry,
  saveSessionQAHistoryEntry,
  removeSessionQAHistoryEntry,
  resolveSessionQAArtifacts,
} from "../../server.js";

var MAX_BODY_BYTES = 100 * 1024 * 1024; // 100MB -- localhost only, no DoS surface

/**
 * Read a request body with graceful overflow handling.
 * Uses req.resume() instead of req.destroy() to prevent ECONNRESET.
 * Sends 413 with keep-alive headers on overflow.
 */
export function readBody(req, res, maxBytes) {
  var limit = maxBytes || MAX_BODY_BYTES;
  return new Promise(function (resolve, reject) {
    var chunks = [];
    var bytes = 0;
    var overflow = false;
    req.on("data", function (chunk) {
      if (overflow) return;
      var chunkBytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      bytes += chunkBytes;
      if (bytes > limit) {
        overflow = true;
        chunks = [];
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () {
      if (overflow) {
        if (res && !res.headersSent) {
          res.writeHead(413, {
            "Content-Type": "application/json",
            "Connection": "keep-alive",
          });
          res.end(JSON.stringify({ error: "Request body too large" }));
        }
        reject(new Error("Request body too large"));
        return;
      }
      var body = chunks.length > 0
        ? (Buffer.isBuffer(chunks[0]) ? Buffer.concat(chunks).toString("utf8") : chunks.join(""))
        : "";
      resolve(body);
    });
    req.on("error", reject);
  });
}

/**
 * Handle /api/session-qa-history (GET, DELETE, POST).
 * Returns true if the request was handled, false otherwise.
 */
export function handleQAHistoryEndpoint(req, res, parsed) {
  res.setHeader("Content-Type", "application/json");
  var qaHistoryFile = getSessionQAHistoryFilePath();

  if (req.method === "GET") {
    var sessionKey = parsed.query.sessionKey || "";
    if (!sessionKey) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "sessionKey is required" }));
      return true;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ history: getSessionQAHistoryEntry(qaHistoryFile, sessionKey) }));
    return true;
  }

  if (req.method === "DELETE") {
    var deleteKey = parsed.query.sessionKey || "";
    if (!deleteKey) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "sessionKey is required" }));
      return true;
    }
    removeSessionQAHistoryEntry(qaHistoryFile, deleteKey);
    res.writeHead(200);
    res.end(JSON.stringify({ success: true }));
    return true;
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }

  readBody(req, res).then(function (body) {
    try {
      var payload = JSON.parse(body || "{}");
      if (!payload.sessionKey) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "sessionKey is required" }));
        return;
      }
      var savedHistory = saveSessionQAHistoryEntry(
        qaHistoryFile,
        payload.sessionKey,
        payload.history || payload
      );
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, history: savedHistory }));
    } catch (error) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: error.message || "Could not persist session Q&A history" }));
    }
  }).catch(function (e) {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  return true;
}

/**
 * Handle /api/session-qa-cache (GET, DELETE, POST).
 * opts.sessionQACache: the cache store
 * opts.ensureFactStore: optional async function(savedSession, precomputed) for fact store
 * opts.maxBodyBytes: optional override
 * Returns true if the request was handled, false otherwise.
 */
export function handleQACacheEndpoint(req, res, parsed, opts) {
  var sessionQACache = opts.sessionQACache;
  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET") {
    var sessionKey = parsed.query.sessionKey || "";
    if (!sessionKey) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "sessionKey is required" }));
      return true;
    }
    res.writeHead(200);
    res.end(JSON.stringify({ session: getSessionQACacheEntry(sessionQACache, sessionKey) }));
    return true;
  }

  if (req.method === "DELETE") {
    var deleteKey = parsed.query.sessionKey || "";
    if (!deleteKey) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "sessionKey is required" }));
      return true;
    }
    removeSessionQACacheEntry(sessionQACache, deleteKey);
    res.writeHead(200);
    res.end(JSON.stringify({ success: true }));
    return true;
  }

  if (req.method !== "POST") {
    res.writeHead(405);
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return true;
  }

  readBody(req, res, opts.maxBodyBytes).then(async function (body) {
    try {
      var payload = JSON.parse(body || "{}");
      if (!payload.sessionKey) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "sessionKey is required" }));
        return;
      }
      var savedSession = saveSessionQACacheEntry(
        sessionQACache,
        payload.sessionKey,
        payload
      );
      var precomputed = ensureSessionQAPrecomputed(savedSession);

      // Build fact store if the caller provided an async builder
      var factStore = null;
      if (opts.ensureFactStore) {
        factStore = await opts.ensureFactStore(savedSession, precomputed);
      }

      var result = {
        success: true,
        sessionKey: payload.sessionKey,
        updatedAt: savedSession ? savedSession.updatedAt : null,
        precomputed: precomputed ? {
          fingerprint: precomputed.fingerprint,
          storage: precomputed.storage,
          builtAt: precomputed.builtAt,
          reused: precomputed.reused,
        } : null,
      };
      if (factStore) {
        result.factStore = {
          storage: factStore.storage,
          builtAt: factStore.builtAt,
          reused: factStore.reused,
        };
      }
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: error.message || "Could not cache session Q&A data" }));
      }
    }
  }).catch(function (e) {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  return true;
}

/**
 * Create a model answer cache with LRU eviction.
 */
export function createModelAnswerCache(maxEntries) {
  var max = maxEntries || 50;
  var cache = {};
  var order = [];

  function makeKey(fingerprint, family, contextSubstr, model, question) {
    // Include question text in key so different questions never share cache entries
    var fp = (fingerprint || "").slice(0, 40);
    var fam = (family || "").slice(0, 30);
    var ctx = (contextSubstr || "").slice(0, 200);
    var mod = (model || "").slice(0, 20);
    var q = (question || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim().slice(0, 120);
    return fp + "|" + fam + "|" + mod + "|" + q + "|" + ctx;
  }

  return {
    get: function (fingerprint, family, context, model, question) {
      var key = makeKey(fingerprint, family, context, model, question);
      var entry = cache[key];
      if (!entry) return null;
      var idx = order.indexOf(key);
      if (idx > 0) { order.splice(idx, 1); order.unshift(key); }
      return entry;
    },
    set: function (fingerprint, family, context, answer, references, model, question) {
      var key = makeKey(fingerprint, family, context, model, question);
      cache[key] = { answer: answer, references: references, model: model, cachedAt: Date.now() };
      var idx = order.indexOf(key);
      if (idx !== -1) order.splice(idx, 1);
      order.unshift(key);
      while (order.length > max) {
        var evicted = order.pop();
        delete cache[evicted];
      }
    },
    clear: function () {
      cache = {};
      order = [];
    },
  };
}

/**
 * Set up SSE response headers and return a send function.
 */
export function setupSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.writeHead(200);
  return function sseSend(data) {
    if (!res.writableEnded) res.write("data: " + JSON.stringify(data) + "\n\n");
  };
}
