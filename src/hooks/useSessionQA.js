/**
 * Hook for managing Session Q&A conversations.
 * Sends questions to /api/qa and manages conversation history.
 */

import { useState, useCallback, useRef } from "react";

export default function useSessionQA() {
  var [messages, setMessages] = useState([]);
  var [loading, setLoading] = useState(false);
  var [error, setError] = useState(null);
  var abortRef = useRef(null);

  var askQuestion = useCallback(function (question, events, turns, metadata) {
    if (!question.trim() || loading) return;

    setLoading(true);
    setError(null);

    // Add user message immediately
    var userMsg = { role: "user", content: question };
    setMessages(function (prev) { return prev.concat([userMsg]); });

    // Abort any in-flight request
    if (abortRef.current) abortRef.current.abort();
    var controller = new AbortController();
    abortRef.current = controller;

    fetch("/api/qa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: question, events: events, turns: turns, metadata: metadata }),
      signal: controller.signal,
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Server error: " + res.status);
        return res.json();
      })
      .then(function (data) {
        var assistantMsg = {
          role: "assistant",
          content: data.answer || "No answer available.",
          references: data.references || [],
        };
        setMessages(function (prev) { return prev.concat([assistantMsg]); });
        setLoading(false);
      })
      .catch(function (err) {
        if (err.name === "AbortError") return;
        setError(err.message || "Failed to get answer");
        setLoading(false);
      });
  }, [loading]);

  var clearHistory = useCallback(function () {
    setMessages([]);
    setError(null);
    if (abortRef.current) abortRef.current.abort();
  }, []);

  return {
    messages: messages,
    loading: loading,
    error: error,
    askQuestion: askQuestion,
    clearHistory: clearHistory,
  };
}
