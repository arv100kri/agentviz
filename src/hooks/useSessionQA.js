/**
 * Hook for managing Session Q&A conversations.
 *
 * Each analyzed session gets its own independent Q&A state. History is kept
 * in memory for fast tab switching, mirrored to localStorage as a fallback,
 * and persisted to the AGENTVIZ server so conversations survive app restarts
 * and port changes.
 */

import { useState, useCallback, useRef } from "react";
import usePersistentState from "./usePersistentState.js";
import { parseDetailRequests, buildDetailResponse } from "../lib/sessionQA.js";

var DEFAULT_MODEL = "gpt-5.4";
var STORAGE_KEY = "agentviz:qa-history";
var HISTORY_ENDPOINT = "/api/session-qa-history";

function sanitizeMessages(messages) {
  return Array.isArray(messages) ? messages
    .filter(function (message) {
      return message && typeof message.role === "string" &&
        typeof message.content === "string" &&
        (message.content || message.role !== "assistant");
    })
    .map(function (message) {
      var nextMessage = {
        role: message.role,
        content: message.content,
      };
      if (Array.isArray(message.references) && message.references.length > 0) {
        nextMessage.references = message.references;
      }
      return nextMessage;
    }) : [];
}

function serializeSessionState(session) {
  return {
    messages: sanitizeMessages(session && session.messages),
    responseModel: session && session.responseModel ? session.responseModel : null,
    qaSessionId: session && session.qaSessionId ? session.qaSessionId : null,
  };
}

function freshState() {
  return {
    messages: [],
    loading: false,
    loadingLabel: null,
    error: null,
    responseModel: null,
    qaSessionId: null,
    abort: null,
    activeAssistantIndex: null,
    activeRequestToken: 0,
    requestCounter: 0,
    hydrated: false,
    hydrating: false,
    hydrationToken: 0,
  };
}

function loadPersistedHistory() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function savePersistedHistory(map) {
  try {
    var serializable = {};
    for (var key in map) {
      var serialized = serializeSessionState(map[key]);
      if (serialized.messages.length > 0 || serialized.qaSessionId) {
        serializable[key] = serialized;
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch (e) {}
}

export default function useSessionQA() {
  var [selectedModel, setSelectedModel] = usePersistentState("agentviz:qa-model", DEFAULT_MODEL);
  var [sessionKey, setSessionKey] = useState(null);
  var sessionsRef = useRef(null);
  var queueRef = useRef({});
  var [renderTick, setRenderTick] = useState(0);
  function tick() { setRenderTick(function (n) { return n + 1; }); }

  if (sessionsRef.current === null) {
    var persisted = loadPersistedHistory();
    var restored = {};
    for (var key in persisted) {
      restored[key] = Object.assign(freshState(), {
        messages: sanitizeMessages(persisted[key].messages),
        responseModel: persisted[key].responseModel || null,
        qaSessionId: persisted[key].qaSessionId || null,
      });
    }
    sessionsRef.current = restored;
  }

  function getSession(key) {
    if (!key) return freshState();
    if (!sessionsRef.current[key]) sessionsRef.current[key] = freshState();
    return sessionsRef.current[key];
  }

  function persist() {
    savePersistedHistory(sessionsRef.current);
  }

  function persistServerHistory(key) {
    if (!key) return;
    var serialized = serializeSessionState(getSession(key));
    if (serialized.messages.length === 0 && !serialized.qaSessionId) return;
    fetch(HISTORY_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionKey: key, history: serialized }),
    }).catch(function () {});
  }

  function deleteServerHistory(key) {
    if (!key) return;
    fetch(HISTORY_ENDPOINT + "?sessionKey=" + encodeURIComponent(key), {
      method: "DELETE",
    }).catch(function () {});
  }

  function hydrateSession(key, aliases) {
    if (!key) return;

    var sess = getSession(key);
    if (sess.hydrated || sess.hydrating) return;

    sess.hydrating = true;
    sess.hydrationToken += 1;
    var hydrationToken = sess.hydrationToken;
    var safeAliases = Array.isArray(aliases) ? aliases : [];

    for (var i = 0; i < safeAliases.length; i++) {
      var alias = safeAliases[i];
      if (!alias || alias === key) continue;
      var aliasSession = sessionsRef.current[alias];
      if (!aliasSession || (!aliasSession.messages.length && !aliasSession.qaSessionId)) continue;

      sessionsRef.current[key] = Object.assign(freshState(), serializeSessionState(aliasSession), {
        hydrated: true,
      });
      delete sessionsRef.current[alias];
      persist();
      persistServerHistory(key);
      tick();
      return;
    }

    if (sess.messages.length > 0 || sess.qaSessionId) {
      sess.hydrated = true;
      sess.hydrating = false;
      persist();
      persistServerHistory(key);
      tick();
      return;
    }

    fetch(HISTORY_ENDPOINT + "?sessionKey=" + encodeURIComponent(key))
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (payload) {
        var target = getSession(key);
        if (target.hydrationToken !== hydrationToken) return;
        target.hydrating = false;
        target.hydrated = true;

        if (target.messages.length === 0 && !target.qaSessionId && payload && payload.history) {
          target.messages = sanitizeMessages(payload.history.messages);
          target.responseModel = payload.history.responseModel || null;
          target.qaSessionId = payload.history.qaSessionId || null;
          persist();
        }

        tick();
      })
      .catch(function () {
        var target = getSession(key);
        if (target.hydrationToken !== hydrationToken) return;
        target.hydrating = false;
        target.hydrated = true;
        tick();
      });
  }

  function removeEmptyAssistantMessage(session) {
    if (typeof session.activeAssistantIndex !== "number") return;
    var index = session.activeAssistantIndex;
    var message = session.messages[index];
    if (message && message.role === "assistant" && !message.content) {
      session.messages = session.messages.filter(function (_, messageIndex) {
        return messageIndex !== index;
      });
    }
  }

  function isActiveRequest(key, requestToken) {
    return getSession(key).activeRequestToken === requestToken;
  }

  var current = getSession(sessionKey);

  function processQueue(key) {
    var sess = getSession(key);
    var queue = queueRef.current[key];
    if (!queue || queue.length === 0) return;
    if (sess.loading) return;

    var entry = queue.shift();

    sess.messages = sess.messages.map(function (message) {
      return (message.queued && message.content === entry.question)
        ? { role: "user", content: entry.question }
        : message;
    });
    sess.loading = true;
    sess.loadingLabel = "Preparing session context...";
    sess.error = null;
    sess.requestCounter += 1;
    var requestToken = sess.requestCounter;
    sess.activeRequestToken = requestToken;
    sess.activeAssistantIndex = null;
    tick();

    var controller = new AbortController();
    sess.abort = controller;

    var body = {
      question: entry.question,
      events: entry.events,
      turns: entry.turns,
      metadata: entry.metadata,
      model: entry.model,
    };
    if (sess.qaSessionId) body.qaSessionId = sess.qaSessionId;
    if (entry.sessionFilePath) body.sessionFilePath = entry.sessionFilePath;

    fetch("/api/qa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then(function (res) {
        if (!isActiveRequest(key, requestToken)) return null;
        if (!res.ok) throw new Error("Server error: " + res.status);

        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";
        var streamedText = "";

        var target = getSession(key);
        if (!isActiveRequest(key, requestToken)) return null;
        var msgIndex = target.messages.length;
        target.activeAssistantIndex = msgIndex;
        target.messages = target.messages.concat([{ role: "assistant", content: "", references: [] }]);
        tick();

        function readDetailResponse(detailBody, msgIndexValue) {
          return fetch("/api/qa", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(detailBody),
            signal: controller.signal,
          }).then(function (res2) {
            if (!isActiveRequest(key, requestToken)) return;
            if (!res2.ok) throw new Error("Server error: " + res2.status);

            var reader2 = res2.body.getReader();
            var buf2 = "";
            var text2 = "";

            function readDetailChunk() {
              return reader2.read().then(function (result2) {
                if (!isActiveRequest(key, requestToken)) return;
                if (result2.done) return;
                buf2 += decoder.decode(result2.value, { stream: true });
                var lines2 = buf2.split("\n");
                buf2 = lines2.pop() || "";

                for (var j = 0; j < lines2.length; j++) {
                  if (!lines2[j].startsWith("data: ")) continue;
                  var detailData;
                  try { detailData = JSON.parse(lines2[j].substring(6)); } catch (e) { continue; }
                  var detailTarget = getSession(key);
                  if (!isActiveRequest(key, requestToken)) return;

                  if (detailData.status) {
                    detailTarget.loadingLabel = detailData.status;
                    tick();
                  }
                  if (detailData.delta) {
                    text2 += detailData.delta;
                    detailTarget.loadingLabel = "Streaming answer...";
                    var update = detailTarget.messages.slice();
                    update[msgIndexValue] = { role: "assistant", content: text2, references: [] };
                    detailTarget.messages = update;
                    tick();
                  }
                  if (detailData.done) {
                    var finalUpdate = detailTarget.messages.slice();
                    finalUpdate[msgIndexValue] = {
                      role: "assistant",
                      content: detailData.answer || text2,
                      references: detailData.references || [],
                    };
                    detailTarget.messages = finalUpdate;
                    if (detailData.model) detailTarget.responseModel = detailData.model;
                    if (detailData.qaSessionId) detailTarget.qaSessionId = detailData.qaSessionId;
                    detailTarget.loading = false;
                    detailTarget.loadingLabel = null;
                    detailTarget.abort = null;
                    detailTarget.activeAssistantIndex = null;
                    detailTarget.activeRequestToken = 0;
                    persist();
                    persistServerHistory(key);
                    tick();
                    processQueue(key);
                  }
                  if (detailData.error) {
                    detailTarget.error = detailData.error;
                    detailTarget.loading = false;
                    detailTarget.loadingLabel = null;
                    detailTarget.abort = null;
                    detailTarget.activeAssistantIndex = null;
                    detailTarget.activeRequestToken = 0;
                    tick();
                    processQueue(key);
                  }
                }

                return readDetailChunk();
              });
            }

            return readDetailChunk();
          });
        }

        function readChunk() {
          return reader.read().then(function (result) {
            if (!isActiveRequest(key, requestToken)) return;
            if (result.done) return;
            buffer += decoder.decode(result.value, { stream: true });

            var lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (var li = 0; li < lines.length; li++) {
              var line = lines[li];
              if (!line.startsWith("data: ")) continue;
              var data;
              try { data = JSON.parse(line.substring(6)); } catch (e) { continue; }

              var tgt = getSession(key);
              if (!isActiveRequest(key, requestToken)) return;

              if (data.status) {
                tgt.loadingLabel = data.status;
                tick();
              }

              if (data.delta) {
                streamedText += data.delta;
                tgt.loadingLabel = "Streaming answer...";
                var updated = tgt.messages.slice();
                updated[msgIndex] = { role: "assistant", content: streamedText, references: [] };
                tgt.messages = updated;
                tick();
              }

              if (data.done) {
                var finalAnswer = data.answer || streamedText;
                var detailReqs = parseDetailRequests(finalAnswer);
                if (detailReqs.length > 0) {
                  var detailUpdate = tgt.messages.slice();
                  detailUpdate[msgIndex] = { role: "assistant", content: "Fetching detailed tool output...", references: [] };
                  tgt.messages = detailUpdate;
                  tgt.loadingLabel = "Fetching detailed tool output...";
                  tick();

                  var detailText = buildDetailResponse(detailReqs, entry.events);
                  var detailBody = {
                    question: detailText,
                    events: entry.events,
                    turns: entry.turns,
                    metadata: entry.metadata,
                    model: entry.model,
                  };
                  if (tgt.qaSessionId) detailBody.qaSessionId = tgt.qaSessionId;
                  if (entry.sessionFilePath) detailBody.sessionFilePath = entry.sessionFilePath;
                  return readDetailResponse(detailBody, msgIndex);
                }

                var refs = data.references || [];
                var finalMessages = tgt.messages.slice();
                finalMessages[msgIndex] = { role: "assistant", content: finalAnswer, references: refs };
                tgt.messages = finalMessages;
                if (data.model) tgt.responseModel = data.model;
                if (data.qaSessionId) tgt.qaSessionId = data.qaSessionId;
                tgt.loading = false;
                tgt.loadingLabel = null;
                tgt.abort = null;
                tgt.activeAssistantIndex = null;
                tgt.activeRequestToken = 0;
                persist();
                persistServerHistory(key);
                tick();
                processQueue(key);
              }

              if (data.error) {
                tgt.error = data.error;
                tgt.loading = false;
                tgt.loadingLabel = null;
                tgt.abort = null;
                tgt.activeAssistantIndex = null;
                tgt.activeRequestToken = 0;
                tick();
                processQueue(key);
              }
            }

            return readChunk();
          });
        }

        return readChunk();
      })
      .catch(function (err) {
        if (!isActiveRequest(key, requestToken)) return;
        if (err && err.name === "AbortError") return;
        var target = getSession(key);
        target.error = err && err.message ? err.message : "Failed to get answer";
        target.loading = false;
        target.loadingLabel = null;
        target.abort = null;
        target.activeAssistantIndex = null;
        target.activeRequestToken = 0;
        tick();
        processQueue(key);
      });
  }

  var askQuestion = useCallback(function (question, events, turns, metadata, model, sessionFilePath) {
    if (!sessionKey || !question.trim()) return;
    var sess = getSession(sessionKey);
    var isQueued = sess.loading;
    sess.messages = sess.messages.concat([{ role: "user", content: question, queued: isQueued || undefined }]);
    persist();
    persistServerHistory(sessionKey);
    tick();

    if (!queueRef.current[sessionKey]) queueRef.current[sessionKey] = [];
    queueRef.current[sessionKey].push({
      question: question,
      events: events,
      turns: turns,
      metadata: metadata,
      model: model,
      sessionFilePath: sessionFilePath,
    });

    if (!isQueued) processQueue(sessionKey);
  }, [sessionKey]);

  var stopAnswer = useCallback(function () {
    if (!sessionKey) return;
    var sess = getSession(sessionKey);
    if (!sess.loading) return;
    var controller = sess.abort;

    removeEmptyAssistantMessage(sess);
    sess.loading = false;
    sess.loadingLabel = null;
    sess.error = null;
    sess.abort = null;
    sess.activeAssistantIndex = null;
    sess.activeRequestToken = 0;

    persist();
    persistServerHistory(sessionKey);
    tick();

    if (controller) controller.abort();
    processQueue(sessionKey);
  }, [sessionKey]);

  var clearHistory = useCallback(function () {
    if (!sessionKey) return;
    var sess = getSession(sessionKey);
    if (sess.abort) sess.abort.abort();
    queueRef.current[sessionKey] = [];
    sessionsRef.current[sessionKey] = Object.assign(freshState(), { hydrated: true });
    persist();
    deleteServerHistory(sessionKey);
    tick();
  }, [sessionKey]);

  var switchSession = useCallback(function (newSessionKey, aliases) {
    if (!newSessionKey) return;
    if (newSessionKey !== sessionKey) setSessionKey(newSessionKey);
    hydrateSession(newSessionKey, aliases || []);
  }, [sessionKey]);

  return {
    messages: current.messages,
    loading: current.loading,
    loadingLabel: current.loadingLabel,
    queuedCount: sessionKey && queueRef.current[sessionKey] ? queueRef.current[sessionKey].length : 0,
    error: current.error,
    responseModel: current.responseModel,
    selectedModel: selectedModel,
    setSelectedModel: setSelectedModel,
    askQuestion: askQuestion,
    stopAnswer: stopAnswer,
    clearHistory: clearHistory,
    switchSession: switchSession,
  };
}
