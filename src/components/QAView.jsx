/**
 * QAView -- AI-powered Session Q&A panel.
 *
 * Chat-style interface for asking natural-language questions about a loaded session.
 * Answers are grounded in session data with clickable turn references.
 */

import { useState, useRef, useEffect } from "react";
import { theme, alpha } from "../lib/theme.js";
import { formatDuration } from "../lib/formatTime.js";
import Icon from "./Icon.jsx";
import { classifyInstant } from "../lib/qaClassifier.js";

var SUGGESTED_QUESTIONS = [
  "What tools were used most frequently?",
  "What errors occurred and how were they resolved?",
  "What was the agent's overall approach?",
  "Which files were modified?",
  "What happened around the first error?",
];

function expandTurnIndices(body) {
  var indices = [];
  var segments = body.split(/,|\band\b/);
  for (var i = 0; i < segments.length; i++) {
    var seg = segments[i].trim();
    // Range: "0 - 5", "Turn 0 - Turn 5", "0-5", "Turns 0-5"
    var rangeMatch = seg.match(/(?:Turns?\s*)?(\d+)\s*[-\u2013]\s*(?:Turn\s*)?(\d+)/i);
    if (rangeMatch) {
      var lo = parseInt(rangeMatch[1], 10);
      var hi = parseInt(rangeMatch[2], 10);
      for (var n = lo; n <= hi; n++) indices.push(n);
      continue;
    }
    // Single: "Turn 3" or bare "3"
    var singleMatch = seg.match(/(?:Turns?\s*)?(\d+)/i);
    if (singleMatch) {
      indices.push(parseInt(singleMatch[1], 10));
    }
  }
  var seen = {};
  return indices.filter(function (v) {
    if (seen[v]) return false;
    seen[v] = true;
    return true;
  });
}

function parseTurnReferences(text) {
  // Two-pass approach:
  // 1. Bracketed groups: [Turn 0], [Turn 0, Turn 5], [Turn 10 - 12], [Turns 0-5]
  // 2. Unbracketed: Turn 3, turn 7 (case insensitive)
  var markers = []; // { start, end, indices }

  // Pass 1: bracketed groups with range/list expansion
  var bracketRegex = /\[Turns?\s+[\d][\d\s,\-\u2013andTurn]*/gi;
  var bm;
  while ((bm = bracketRegex.exec(text)) !== null) {
    var close = text.indexOf("]", bm.index);
    if (close === -1) continue;
    var full = text.substring(bm.index, close + 1);
    var body = full.slice(1, -1);
    var indices = expandTurnIndices(body);
    if (indices.length > 0) {
      markers.push({ start: bm.index, end: close + 1, value: full, indices: indices });
    }
    bracketRegex.lastIndex = close + 1;
  }

  // Pass 2: unbracketed "Turn N" not already inside a bracketed group
  var unbracketedRegex = /Turn\s+(\d+)/gi;
  var um;
  while ((um = unbracketedRegex.exec(text)) !== null) {
    var inside = markers.some(function (m) { return um.index >= m.start && um.index < m.end; });
    if (inside) continue;
    markers.push({ start: um.index, end: unbracketedRegex.lastIndex, value: um[0], indices: [parseInt(um[1], 10)] });
  }

  // Sort by position
  markers.sort(function (a, b) { return a.start - b.start; });

  // Build parts
  var parts = [];
  var lastIndex = 0;
  for (var i = 0; i < markers.length; i++) {
    var m = markers[i];
    if (m.start > lastIndex) {
      parts.push({ type: "text", value: text.substring(lastIndex, m.start) });
    }
    for (var j = 0; j < m.indices.length; j++) {
      parts.push({ type: "ref", turnIndex: m.indices[j], value: j === 0 ? m.value : "" });
    }
    lastIndex = m.end;
  }
  if (lastIndex < text.length) {
    parts.push({ type: "text", value: text.substring(lastIndex) });
  }
  return parts.filter(function (p) { return p.type === "ref" || p.value; });
}

export { parseTurnReferences, expandTurnIndices };

// ── Markdown rendering ──────────────────────────────────────────────────────

var BOLD_RE = /\*\*(.+?)\*\*/g;
var CODE_RE = /`([^`]+)`/g;

function splitFormattedText(str, parts, handleTurnClick) {
  // Parse turn refs first
  var turnParts = parseTurnReferences(str);

  for (var ti = 0; ti < turnParts.length; ti++) {
    var tp = turnParts[ti];
    if (tp.type === "ref") {
      parts.push({ type: "ref", turnIndex: tp.turnIndex, value: tp.value });
      continue;
    }
    // Split text on **bold** and `code`
    var RE = /\*\*(.+?)\*\*|`([^`]+)`/g;
    var last = 0;
    var match;
    var text = tp.value;
    while ((match = RE.exec(text)) !== null) {
      if (match.index > last) parts.push({ type: "text", value: text.slice(last, match.index) });
      if (match[1] != null) parts.push({ type: "bold", value: match[1] });
      else parts.push({ type: "code", value: match[2] });
      last = RE.lastIndex;
    }
    if (last < text.length) parts.push({ type: "text", value: text.slice(last) });
  }
}

function renderInlineParts(parts, handleTurnClick) {
  return parts.map(function (part, i) {
    if (part.type === "ref") {
      return (
        <button type="button" key={i} style={turnRefInlineStyle}
          onClick={function () { if (handleTurnClick) handleTurnClick(part.turnIndex); }}
          title={"Jump to Turn " + part.turnIndex}>
          {part.value}
        </button>
      );
    }
    if (part.type === "bold") return <strong key={i} style={{ fontWeight: 600 }}>{part.value}</strong>;
    if (part.type === "code") return <code key={i} style={codeInlineStyle}>{part.value}</code>;
    return <span key={i}>{part.value}</span>;
  });
}

var turnRefInlineStyle = {
  display: "inline",
  background: alpha(theme.accent.primary, 0.12),
  color: theme.accent.primary,
  border: "none",
  borderRadius: theme.radius.full + "px",
  fontFamily: theme.font.mono,
  fontSize: theme.fontSize.sm,
  padding: "1px 6px",
  cursor: "pointer",
  fontWeight: 600,
};

var codeInlineStyle = {
  background: alpha(theme.text.primary, 0.08),
  borderRadius: 3,
  padding: "1px 4px",
  fontSize: theme.fontSize.sm,
};

function renderMarkdownContent(text, handleTurnClick) {
  if (!text) return null;
  var lines = text.split("\n");
  var elements = [];
  var listItems = [];
  var tableRows = [];

  function flushList() {
    if (listItems.length === 0) return;
    elements.push(
      <ul key={"ul-" + elements.length} style={{ margin: "4px 0", paddingLeft: 18 }}>
        {listItems.map(function (item, j) {
          var parts = [];
          splitFormattedText(item, parts);
          return <li key={j} style={{ marginBottom: 2 }}>{renderInlineParts(parts, handleTurnClick)}</li>;
        })}
      </ul>
    );
    listItems = [];
  }

  function flushTable() {
    if (tableRows.length === 0) return;
    var header = null;
    var dataRows = [];
    for (var r = 0; r < tableRows.length; r++) {
      var row = tableRows[r].trim();
      if (/^\|[\s\-:|]+\|$/.test(row)) continue;
      if (!header) header = row;
      else dataRows.push(row);
    }
    if (!header) { tableRows = []; return; }
    function parseCells(row) {
      return row.split("|").filter(function (c, ci, arr) { return ci > 0 && ci < arr.length - 1; }).map(function (c) { return c.trim(); });
    }
    var headerCells = parseCells(header);
    elements.push(
      <div key={"tbl-" + elements.length} style={{ overflowX: "auto", margin: "6px 0" }}>
        <table style={{ borderCollapse: "collapse", fontSize: theme.fontSize.sm, width: "100%" }}>
          <thead><tr>
            {headerCells.map(function (cell, k) {
              var p = []; splitFormattedText(cell, p);
              return <th key={k} style={{ border: "1px solid " + alpha(theme.text.muted, 0.2), padding: "4px 8px", textAlign: "left", fontWeight: 600, background: alpha(theme.text.muted, 0.08) }}>{renderInlineParts(p, handleTurnClick)}</th>;
            })}
          </tr></thead>
          <tbody>
            {dataRows.map(function (row, j) {
              var cells = parseCells(row);
              return <tr key={j}>{cells.map(function (cell, k) {
                var p = []; splitFormattedText(cell, p);
                return <td key={k} style={{ border: "1px solid " + alpha(theme.text.muted, 0.15), padding: "4px 8px", textAlign: "left" }}>{renderInlineParts(p, handleTurnClick)}</td>;
              })}</tr>;
            })}
          </tbody>
        </table>
      </div>
    );
    tableRows = [];
  }

  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) { flushList(); tableRows.push(trimmed); continue; } else { flushTable(); }
    var listMatch = trimmed.match(/^[-*]\s+(.*)/);
    if (listMatch) { flushTable(); listItems.push(listMatch[1]); continue; } else { flushList(); }
    var numMatch = trimmed.match(/^\d+\.\s+(.*)/);
    if (numMatch) { listItems.push(numMatch[1]); continue; } else if (listItems.length > 0) { flushList(); }
    if (!trimmed) { elements.push(<div key={"br-" + i} style={{ height: 6 }} />); continue; }
    // Headers
    var h3 = trimmed.match(/^###\s+(.*)/);
    if (h3) { flushList(); flushTable(); var p3 = []; splitFormattedText(h3[1], p3); elements.push(<div key={"h3-" + i} style={{ fontWeight: 600, fontSize: theme.fontSize.sm, marginTop: 8, marginBottom: 2 }}>{renderInlineParts(p3, handleTurnClick)}</div>); continue; }
    var h2 = trimmed.match(/^##\s+(.*)/);
    if (h2) { flushList(); flushTable(); var p2 = []; splitFormattedText(h2[1], p2); elements.push(<div key={"h2-" + i} style={{ fontWeight: 700, fontSize: theme.fontSize.base, marginTop: 10, marginBottom: 2 }}>{renderInlineParts(p2, handleTurnClick)}</div>); continue; }
    var h1 = trimmed.match(/^#\s+(.*)/);
    if (h1) { flushList(); flushTable(); var p1 = []; splitFormattedText(h1[1], p1); elements.push(<div key={"h1-" + i} style={{ fontWeight: 700, fontSize: theme.fontSize.md, marginTop: 12, marginBottom: 4 }}>{renderInlineParts(p1, handleTurnClick)}</div>); continue; }
    // Regular line
    var parts = []; splitFormattedText(trimmed, parts);
    elements.push(<div key={"p-" + i}>{renderInlineParts(parts, handleTurnClick)}</div>);
  }
  flushList(); flushTable();
  return <>{elements}</>;
}

function formatAnswerTiming(timing) {
  var totalMs = timing && timing.totalMs;
  var numericTotalMs = typeof totalMs === "number" ? totalMs : Number(totalMs);
  if (!Number.isFinite(numericTotalMs) || numericTotalMs <= 0) return null;
  return "Answered in " + formatDuration(numericTotalMs / 1000);
}

function sanitizeElapsedMs(value) {
  var numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) return null;
  return Math.round(numericValue);
}

function getLiveLoadingElapsedMs(qa, nowMs) {
  var elapsedMs = sanitizeElapsedMs(qa && qa.loadingElapsedMs);
  var startedAtMs = sanitizeElapsedMs(qa && qa.loadingStartedAtMs);
  if (startedAtMs !== null) {
    var liveElapsedMs = Math.max(0, nowMs - startedAtMs);
    elapsedMs = elapsedMs === null ? liveElapsedMs : Math.max(elapsedMs, liveElapsedMs);
  }
  return elapsedMs;
}

function formatLoadingElapsed(elapsedMs) {
  var safeElapsedMs = sanitizeElapsedMs(elapsedMs);
  if (safeElapsedMs === null) return null;
  return "Elapsed " + formatDuration(Math.max(1, safeElapsedMs) / 1000);
}

var AVAILABLE_MODELS = [
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
  { id: "gpt-5.3-codex", label: "GPT-5.3-Codex" },
  { id: "gpt-5.2-codex", label: "GPT-5.2-Codex" },
  { id: "gpt-5.2", label: "GPT-5.2" },
  { id: "gpt-5.1-codex-max", label: "GPT-5.1-Codex-Max" },
  { id: "gpt-5.1-codex", label: "GPT-5.1-Codex" },
  { id: "gpt-5.1", label: "GPT-5.1" },
  { id: "gpt-5.1-codex-mini", label: "GPT-5.1-Codex-Mini" },
  { id: "gpt-5-mini", label: "GPT-5 mini" },
  { id: "gpt-4.1", label: "GPT-4.1" },
  { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4.5", label: "Claude Sonnet 4.5" },
  { id: "claude-sonnet-4", label: "Claude Sonnet 4" },
  { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
  { id: "claude-opus-4.5", label: "Claude Opus 4.5" },
];

var DEFAULT_MODEL = "gpt-5.4";

export default function QAView({ qa, events, turns, metadata, sessionFilePath, rawText, onSeekTurn, onSetView, enableInstantClassifier, onClose }) {
  var [input, setInput] = useState("");
  var [instantMessages, setInstantMessages] = useState([]);
  var [instantSeq, setInstantSeq] = useState(0);
  var [loadingNowMs, setLoadingNowMs] = useState(function () { return Date.now(); });
  var messagesEndRef = useRef(null);
  var inputRef = useRef(null);
  var lastQuestionRef = useRef("");

  // Interleave server messages and instant messages by insertion order.
  // Server messages keep their original order. Instant messages are inserted
  // at the position they were asked (tracked by seq = qa.messages.length at time of ask).
  var allMessages = [];
  var serverIdx = 0;
  var instantIdx = 0;
  while (serverIdx < qa.messages.length || instantIdx < instantMessages.length) {
    var nextInstant = instantIdx < instantMessages.length ? instantMessages[instantIdx] : null;
    if (nextInstant && nextInstant._insertAt <= serverIdx) {
      allMessages.push(nextInstant);
      instantIdx++;
    } else if (serverIdx < qa.messages.length) {
      allMessages.push(qa.messages[serverIdx]);
      serverIdx++;
    } else {
      allMessages.push(nextInstant);
      instantIdx++;
    }
  }

  useEffect(function () {
    if (messagesEndRef.current && messagesEndRef.current.scrollIntoView) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [allMessages.length, qa.loading, qa.loadingLabel, qa.queuedCount]);

  useEffect(function () {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  useEffect(function () {
    if (!qa.loading) return;
    setLoadingNowMs(Date.now());
    var intervalId = setInterval(function () {
      setLoadingNowMs(Date.now());
    }, 250);
    return function () {
      clearInterval(intervalId);
    };
  }, [qa.loading, qa.loadingStartedAtMs]);

  function tryInstantAnswer(question) {
    if (!enableInstantClassifier || !events || events.length === 0) return false;
    var result = classifyInstant(question, { events: events, turns: turns, metadata: metadata });
    if (!result) return false;
    var insertAt = qa.messages.length;
    setInstantMessages(function (prev) {
      return prev.concat([
        { role: "user", content: question, _insertAt: insertAt },
        { role: "assistant", content: result.answer, timing: { totalMs: 0 }, _insertAt: insertAt },
      ]);
    });
    return true;
  }

  function handleSubmit(e) {
    if (e) e.preventDefault();
    if (!input.trim()) return;
    var q = input.trim();
    lastQuestionRef.current = q;
    setInput("");
    if (tryInstantAnswer(q)) return;
    qa.askQuestion(q, events, turns, metadata, qa.selectedModel, sessionFilePath, rawText);
  }

  function handleSuggestion(q) {
    if (tryInstantAnswer(q)) return;
    qa.askQuestion(q, events, turns, metadata, qa.selectedModel, sessionFilePath, rawText);
  }

  function handleTurnClick(turnIndex) {
    if (onSeekTurn && turns) {
      var turn = turns.find(function (t) { return t.index === turnIndex; });
      if (turn) {
        onSeekTurn(turn.startTime);
        if (onSetView) onSetView("replay");
      }
    }
  }

  var containerStyle = {
    display: "flex",
    flexDirection: "column",
    height: "100%",
    background: theme.bg.base,
    color: theme.text.primary,
  };

  var messagesContainerStyle = {
    flex: 1,
    overflowY: "auto",
    padding: theme.space.xl + "px",
    display: "flex",
    flexDirection: "column",
    gap: theme.space.md + "px",
  };

  var emptyStateStyle = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    gap: theme.space.lg + "px",
    padding: theme.space.xxl + "px",
  };

  var titleStyle = {
    fontSize: theme.fontSize.lg,
    fontWeight: 600,
    color: theme.text.primary,
  };

  var subtitleStyle = {
    fontSize: theme.fontSize.sm,
    color: theme.text.secondary,
    textAlign: "center",
    maxWidth: 400,
    lineHeight: 1.5,
  };

  var suggestionsStyle = {
    display: "flex",
    flexDirection: "column",
    gap: theme.space.sm + "px",
    width: "100%",
    maxWidth: 500,
  };

  var suggestionBtnStyle = {
    background: theme.bg.surface,
    border: "1px solid " + theme.border.default,
    borderRadius: theme.radius.md + "px",
    padding: theme.space.md + "px " + theme.space.lg + "px",
    color: theme.text.secondary,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.font.mono,
    cursor: "pointer",
    textAlign: "left",
    transition: theme.transition.fast,
  };

  var userMsgStyle = {
    alignSelf: "flex-end",
    background: theme.accent.primary,
    color: theme.text.primary,
    padding: theme.space.md + "px " + theme.space.lg + "px",
    borderRadius: theme.radius.lg + "px",
    maxWidth: "75%",
    fontSize: theme.fontSize.sm,
    fontFamily: theme.font.mono,
    lineHeight: 1.5,
    wordBreak: "break-word",
  };

  var assistantMsgStyle = {
    alignSelf: "flex-start",
    background: theme.bg.surface,
    border: "1px solid " + theme.border.default,
    padding: theme.space.lg + "px",
    borderRadius: theme.radius.lg + "px",
    maxWidth: "85%",
    fontSize: theme.fontSize.sm,
    fontFamily: theme.font.mono,
    lineHeight: 1.6,
    color: theme.text.primary,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };

  var assistantMetaStyle = {
    marginTop: theme.space.sm + "px",
    fontSize: theme.fontSize.xs,
    fontFamily: theme.font.mono,
    color: theme.text.dim,
  };

  var turnRefStyle = {
    display: "inline",
    color: theme.accent.primary,
    cursor: "pointer",
    textDecoration: "underline",
    fontWeight: 600,
  };

  var loadingBubbleStyle = {
    alignSelf: "flex-start",
    display: "flex",
    alignItems: "flex-start",
    gap: theme.space.sm + "px",
    padding: theme.space.md + "px " + theme.space.lg + "px",
    background: alpha(theme.bg.surface, 0.95),
    border: "1px solid " + theme.border.default,
    borderRadius: theme.radius.lg + "px",
    color: theme.text.secondary,
    maxWidth: "85%",
  };

  var loadingTitleStyle = {
    fontSize: theme.fontSize.sm,
    fontFamily: theme.font.mono,
    fontWeight: 600,
    color: theme.text.primary,
    lineHeight: 1.5,
  };

  var loadingDetailStyle = {
    marginTop: 4,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.font.mono,
    color: theme.text.secondary,
    lineHeight: 1.5,
  };

  var loadingMetaStyle = {
    marginTop: 4,
    display: "flex",
    flexWrap: "wrap",
    gap: theme.space.md + "px",
    fontSize: theme.fontSize.xs,
    fontFamily: theme.font.mono,
    color: theme.text.dim,
  };

  var inputContainerStyle = {
    display: "flex",
    gap: theme.space.sm + "px",
    padding: theme.space.lg + "px",
    borderTop: "1px solid " + theme.border.default,
    background: theme.bg.surface,
  };

  var inputStyle = {
    flex: 1,
    background: theme.bg.base,
    border: "1px solid " + theme.border.default,
    borderRadius: theme.radius.md + "px",
    padding: theme.space.md + "px " + theme.space.lg + "px",
    color: theme.text.primary,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.font.mono,
    outline: "none",
  };

  var sendBtnStyle = {
    background: theme.accent.primary,
    border: "none",
    borderRadius: theme.radius.md + "px",
    padding: theme.space.md + "px " + theme.space.lg + "px",
    color: theme.text.primary,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.font.mono,
    fontWeight: 600,
    cursor: "pointer",
    transition: theme.transition.fast,
  };

  var stopBtnStyle = {
    background: alpha(theme.semantic.error, 0.14),
    border: "1px solid " + alpha(theme.semantic.error, 0.4),
    borderRadius: theme.radius.md + "px",
    padding: theme.space.md + "px " + theme.space.lg + "px",
    color: theme.semantic.error,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.font.mono,
    fontWeight: 600,
    cursor: "pointer",
    transition: theme.transition.fast,
  };

  var headerStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: theme.space.md + "px " + theme.space.xl + "px",
    borderBottom: "1px solid " + theme.border.default,
    background: theme.bg.surface,
  };

  var headerLabelStyle = {
    fontSize: theme.fontSize.sm,
    color: theme.text.secondary,
    fontWeight: 500,
  };

  var clearBtnStyle = {
    background: "transparent",
    border: "1px solid " + theme.border.default,
    borderRadius: theme.radius.sm + "px",
    padding: "4px 10px",
    color: theme.text.muted,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.font.mono,
    cursor: "pointer",
    transition: theme.transition.fast,
  };

  var errorStyle = {
    alignSelf: "center",
    color: theme.semantic.error,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.font.mono,
    padding: theme.space.md + "px",
  };

  var limitationStyle = {
    fontSize: theme.fontSize.xs,
    color: theme.text.dim,
    textAlign: "center",
    padding: "4px " + theme.space.lg + "px",
    background: theme.bg.surface,
  };

  var hasMessages = allMessages.length > 0;
  var loadingLabel = qa.loadingLabel || "Working on your question...";
  var loadingDetail = qa.loadingDetail || null;
  var loadingElapsedLabel = formatLoadingElapsed(getLiveLoadingElapsedMs(qa, loadingNowMs));

  var modelSelectStyle = {
    background: theme.bg.base,
    color: theme.text.secondary,
    border: "1px solid " + theme.border.default,
    borderRadius: theme.radius.sm + "px",
    padding: "4px 8px",
    fontSize: theme.fontSize.xs,
    fontFamily: theme.font.mono,
    outline: "none",
    cursor: "pointer",
  };

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span style={headerLabelStyle}>Session Q&A</span>
        <div style={{ display: "flex", alignItems: "center", gap: theme.space.sm + "px" }}>
          <select
            style={modelSelectStyle}
            value={qa.selectedModel}
            onChange={function (e) { qa.setSelectedModel(e.target.value); }}
            title="Choose model"
            aria-label="Choose model"
          >
            {AVAILABLE_MODELS.map(function (m) {
              return <option key={m.id} value={m.id}>{m.label}</option>;
            })}
          </select>
          {hasMessages && (
            <button
              className="av-btn"
              style={clearBtnStyle}
              onClick={function () { setInstantMessages([]); qa.clearHistory(); }}
              title="Clear conversation"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      <div style={messagesContainerStyle}>
        {!hasMessages && (
          <div style={emptyStateStyle}>
            <Icon name="message-circle" size={32} color={theme.text.dim} />
            <div style={titleStyle}>Ask about this session</div>
            <div style={subtitleStyle}>
              Ask natural-language questions about the loaded session and get answers grounded in the session data.
            </div>
            <div style={suggestionsStyle}>
              {SUGGESTED_QUESTIONS.map(function (q, i) {
                return (
                  <button
                    key={i}
                    className="av-btn"
                    style={suggestionBtnStyle}
                    onClick={function () { handleSuggestion(q); }}
                  >
                    {q}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {allMessages.map(function (msg, i) {
          if (msg.role === "user") {
            var isQueued = msg.queued;
            return (
              <div key={i} style={Object.assign({}, userMsgStyle, isQueued ? { opacity: 0.6 } : {})}>
                {isQueued && <Icon name="hourglass" size={12} style={{ marginRight: 6, verticalAlign: "middle" }} />}
                {msg.content}
              </div>
            );
          }
          if (!msg.content) return null;
          var timingLabel = formatAnswerTiming(msg.timing);
          var isInstant = msg.timing && msg.timing.totalMs === 0 && msg._insertAt != null;
          var isCached = msg.cached;
          return (
            <div key={i} style={assistantMsgStyle}>
              {renderMarkdownContent(msg.content, handleTurnClick)}
              <div style={assistantMetaStyle}>
                {isInstant && "\u26A1 instant"}
                {isCached && "\u21BB cached"}
                {!isInstant && !isCached && timingLabel}
              </div>
            </div>
          );
        })}

        {qa.loading && (
          <div style={{
            background: "rgba(34, 197, 94, 0.08)",
            border: "1px solid rgba(34, 197, 94, 0.2)",
            borderRadius: theme.radius.lg + "px",
            padding: "10px 14px",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}>
            <span style={{ display: "inline-flex", gap: 3 }}>
              {[0, 1, 2].map(function (dot) {
                return <span key={dot} style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: "rgb(34, 197, 94)",
                  opacity: 0.4,
                  animation: "pulse 1.2s ease-in-out " + (dot * 0.2) + "s infinite",
                }} />;
              })}
            </span>
            <div>
              <div style={{ fontSize: theme.fontSize.sm, color: theme.text.secondary }}>{loadingLabel}</div>
              {loadingDetail && <div style={{ fontSize: theme.fontSize.xs, color: theme.text.ghost, marginTop: 2 }}>{loadingDetail}</div>}
              {loadingElapsedLabel && <div style={{ fontSize: theme.fontSize.xs, color: theme.text.ghost, marginTop: 2 }}>{loadingElapsedLabel}</div>}
              {qa.queuedCount > 0 && <div style={{ fontSize: theme.fontSize.xs, color: theme.text.ghost, marginTop: 2 }}>{qa.queuedCount} queued {qa.queuedCount === 1 ? "message" : "messages"} behind this answer</div>}
            </div>
          </div>
        )}
        {qa.error && <div style={errorStyle}>{qa.error}</div>}
        <div ref={messagesEndRef} />
      </div>

      <div style={limitationStyle}>
        {qa.responseModel && qa.responseModel !== "default"
          ? "Powered by " + (AVAILABLE_MODELS.find(function (m) { return m.id === qa.responseModel; }) || { label: qa.responseModel }).label
          : "Powered by Copilot SDK"}
      </div>

      <form onSubmit={handleSubmit} style={inputContainerStyle}>
        <input
          ref={inputRef}
          style={inputStyle}
          className="av-search"
          type="text"
          placeholder="Ask a question about this session..."
          value={input}
          onChange={function (e) { setInput(e.target.value); }}
          onKeyDown={function (e) {
            if (e.key === "ArrowUp" && !input && lastQuestionRef.current) {
              e.preventDefault();
              setInput(lastQuestionRef.current);
            }
          }}
        />
        {qa.loading && (
          <button
            type="button"
            style={stopBtnStyle}
            onClick={qa.stopAnswer}
            title="Stop current answer"
          >
            Stop
          </button>
        )}
        <button type="submit" style={sendBtnStyle}>
          Send
        </button>
      </form>
      {onClose && (
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "4px " + theme.space.xl + "px",
          fontSize: theme.fontSize.xs,
          color: theme.text.ghost,
          borderTop: "1px solid " + theme.border.subtle,
        }}>
          <span>Esc to close</span>
          <span>Ctrl+Shift+K</span>
        </div>
      )}
    </div>
  );
}
