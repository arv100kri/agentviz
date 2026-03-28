/**
 * Hook for managing Session Q&A conversations.
 *
 * Each analyzed session gets its own independent Q&A state, persisted to
 * localStorage so conversations survive tab switches AND app restarts.
 * The Copilot SDK sessionId is saved per conversation so subsequent
 * questions use resumeSession() -- the LLM retains full context.
 */

import { useState, useCallback, useRef } from "react";
import usePersistentState from "./usePersistentState.js";

var DEFAULT_MODEL = "gpt-5.4";
var STORAGE_KEY = "agentviz:qa-history";

function freshState() {
  return { messages: [], loading: false, error: null, responseModel: null, qaSessionId: null, abort: null };
}

function loadPersistedHistory() {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) { return {}; }
}

function savePersistedHistory(map) {
  try {
    // Only persist serializable fields (no abort controllers)
    var serializable = {};
    for (var key in map) {
      var s = map[key];
      if (s.messages.length > 0 || s.qaSessionId) {
        serializable[key] = {
          messages: s.messages,
          responseModel: s.responseModel,
          qaSessionId: s.qaSessionId,
        };
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch (e) {}
}

export default function useSessionQA() {
  var [selectedModel, setSelectedModel] = usePersistentState("agentviz:qa-model", DEFAULT_MODEL);
  var [sessionKey, setSessionKey] = useState(null);
  var sessionsRef = useRef(null);
  var [renderTick, setRenderTick] = useState(0);
  function tick() { setRenderTick(function (n) { return n + 1; }); }

  // Lazy-load persisted history on first access
  if (sessionsRef.current === null) {
    var persisted = loadPersistedHistory();
    var restored = {};
    for (var key in persisted) {
      restored[key] = {
        messages: persisted[key].messages || [],
        loading: false,
        error: null,
        responseModel: persisted[key].responseModel || null,
        qaSessionId: persisted[key].qaSessionId || null,
        abort: null,
      };
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

  var current = getSession(sessionKey);

  var askQuestion = useCallback(function (question, events, turns, metadata, model) {
    if (!sessionKey || !question.trim()) return;
    var sess = getSession(sessionKey);
    if (sess.loading) return;

    sess.messages = sess.messages.concat([{ role: "user", content: question }]);
    sess.loading = true;
    sess.error = null;
    persist();
    tick();

    if (sess.abort) sess.abort.abort();
    var controller = new AbortController();
    sess.abort = controller;

    var targetKey = sessionKey;
    var body = { question: question, events: events, turns: turns, metadata: metadata, model: model };
    if (sess.qaSessionId) body.qaSessionId = sess.qaSessionId;

    fetch("/api/qa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Server error: " + res.status);
        return res.json();
      })
      .then(function (data) {
        var target = getSession(targetKey);
        var assistantMsg = {
          role: "assistant",
          content: data.answer || "No answer available.",
          references: data.references || [],
        };
        target.messages = target.messages.concat([assistantMsg]);
        if (data.model) target.responseModel = data.model;
        if (data.qaSessionId) target.qaSessionId = data.qaSessionId;
        target.loading = false;
        target.abort = null;
        persist();
        tick();
      })
      .catch(function (err) {
        if (err.name === "AbortError") return;
        var target = getSession(targetKey);
        target.error = err.message || "Failed to get answer";
        target.loading = false;
        target.abort = null;
        tick();
      });
  }, [sessionKey]);

  var clearHistory = useCallback(function () {
    if (!sessionKey) return;
    var sess = getSession(sessionKey);
    if (sess.abort) sess.abort.abort();
    sessionsRef.current[sessionKey] = freshState();
    persist();
    tick();
  }, [sessionKey]);

  var switchSession = useCallback(function (newSessionKey) {
    if (!newSessionKey || newSessionKey === sessionKey) return;
    setSessionKey(newSessionKey);
  }, [sessionKey]);

  return {
    messages: current.messages,
    loading: current.loading,
    error: current.error,
    responseModel: current.responseModel,
    selectedModel: selectedModel,
    setSelectedModel: setSelectedModel,
    askQuestion: askQuestion,
    clearHistory: clearHistory,
    switchSession: switchSession,
  };
}
