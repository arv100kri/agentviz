import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { theme } from "../../lib/theme.js";
import { parseSession } from "../../lib/parseSession.ts";
import { getSessionTotal, buildFilteredEventEntries, buildTurnStartMap, buildTimeMap } from "../../lib/session";
import usePlayback from "../../hooks/usePlayback.js";
import useSearch from "../../hooks/useSearch.js";
import useKeyboardShortcuts from "../../hooks/useKeyboardShortcuts.js";
import usePersistentState from "../../hooks/usePersistentState.js";
import ReplayView from "../../components/ReplayView.jsx";
import TracksView from "../../components/TracksView.jsx";
import WaterfallView from "../../components/WaterfallView.jsx";
import StatsView from "../../components/StatsView.jsx";
import QAView from "../../components/QAView.jsx";
import Timeline from "../../components/Timeline.jsx";
import useSessionQA from "../../hooks/useSessionQA.js";
import { IMPORTANCE_COLORS } from "../lib/faxConstants.js";
import Icon from "../../components/Icon.jsx";

var GraphView = React.lazy(function () { return import("../../components/GraphView.jsx"); });

var FAX_VIEWS = [
  { id: "replay", label: "Replay" },
  { id: "tracks", label: "Tracks" },
  { id: "waterfall", label: "Waterfall" },
  { id: "graph", label: "Graph" },
  { id: "stats", label: "Stats" },
  { id: "qa", label: "Q&A" },
];

// Views that require events.jsonl
var SESSION_VIEWS = ["replay", "tracks", "waterfall", "graph", "stats"];

function FaxMetadataHeader({ faxEntry, onBack }) {
  var importanceColor = IMPORTANCE_COLORS[faxEntry.importance] || IMPORTANCE_COLORS.normal;
  return React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "8px 16px",
      borderBottom: "1px solid " + theme.border.default,
      flexShrink: 0,
    },
  },
    React.createElement("button", {
      className: "av-btn",
      onClick: onBack,
      "aria-label": "Back to inbox",
      style: {
        background: "transparent",
        border: "1px solid " + theme.border.default,
        borderRadius: 6,
        color: theme.text.secondary,
        padding: "4px 10px",
        fontSize: 12,
        fontFamily: theme.font.mono,
        display: "flex",
        alignItems: "center",
        gap: 4,
      },
    }, "\u2190 Inbox"),
    React.createElement("span", {
      style: { fontSize: 14, fontWeight: 600, color: theme.text.primary },
    }, faxEntry.label),
    faxEntry.importance !== "normal" && React.createElement("span", {
      style: {
        fontSize: 10, fontWeight: 700, color: importanceColor,
        border: "1px solid " + importanceColor, borderRadius: 3,
        padding: "1px 5px", letterSpacing: 1,
      },
    }, faxEntry.importance.toUpperCase()),
    React.createElement("span", {
      style: { fontSize: 11, color: theme.text.dim },
    }, faxEntry.sender.alias || faxEntry.sender.email),
    faxEntry.git && faxEntry.git.branch && React.createElement("span", {
      style: { fontSize: 11, color: theme.text.dim },
    }, "\u2192 " + faxEntry.git.branch),
    React.createElement("div", { style: { flex: 1 } }),
    React.createElement("span", {
      style: { fontSize: 11, color: theme.text.dim },
    }, faxEntry.createdUtc ? new Date(faxEntry.createdUtc).toLocaleString() : "")
  );
}

function ViewTabs({ activeView, views, onSetView, hasEvents }) {
  return React.createElement("div", {
    style: {
      display: "flex",
      gap: 0,
      borderBottom: "1px solid " + theme.border.default,
      flexShrink: 0,
      paddingLeft: 16,
    },
  },
    views.map(function (v) {
      var isSession = SESSION_VIEWS.indexOf(v.id) !== -1;
      var disabled = isSession && !hasEvents;
      var isActive = activeView === v.id;
      return React.createElement("button", {
        key: v.id,
        className: "av-btn",
        onClick: disabled ? undefined : function () { onSetView(v.id); },
        disabled: disabled,
        "aria-selected": isActive,
        role: "tab",
        style: {
          background: "transparent",
          border: "none",
          borderBottom: isActive ? "2px solid " + theme.accent.blue : "2px solid transparent",
          color: disabled ? theme.text.dim : isActive ? theme.text.primary : theme.text.secondary,
          padding: "8px 14px",
          fontSize: 12,
          fontFamily: theme.font.mono,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.4 : 1,
        },
      }, v.label);
    })
  );
}

function SearchToolbar({ search, searchInputRef, metadata }) {
  var errorCount = metadata && metadata.errorCount ? metadata.errorCount : 0;
  return React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "6px 16px",
      borderBottom: "1px solid " + theme.border.default,
      flexShrink: 0,
    },
  },
    React.createElement("div", {
      style: { display: "flex", alignItems: "center", gap: 4, flex: 1 },
    },
      React.createElement("input", {
        ref: searchInputRef,
        className: "av-search",
        type: "text",
        placeholder: "Search (/)",
        value: search.searchQuery,
        onChange: function (e) { search.setSearchQuery(e.target.value); },
        style: {
          background: theme.bg.secondary,
          border: "1px solid " + theme.border.default,
          borderRadius: 6,
          color: theme.text.primary,
          padding: "5px 10px",
          fontSize: 12,
          fontFamily: theme.font.mono,
          width: 220,
        },
      })
    ),
    errorCount > 0 && React.createElement("span", {
      style: { fontSize: 11, color: "#ff6b6b", display: "flex", alignItems: "center", gap: 4 },
    }, "\u26A0 " + errorCount + " errors")
  );
}

export default function FaxObserveShell({ faxEntry, onBack }) {
  var _view = usePersistentState("fax-viz:view", faxEntry.hasEvents ? "replay" : "qa");
  var activeView = _view[0];
  var setActiveView = _view[1];

  var _trackFilters = usePersistentState("fax-viz:track-filters", {});
  var trackFilters = _trackFilters[0];

  var _session = useState(null);
  var session = _session[0];
  var setSession = _session[1];

  var _rawText = useState("");
  var rawText = _rawText[0];
  var setRawText = _rawText[1];

  var _loading = useState(false);
  var loading = _loading[0];
  var setLoading = _loading[1];

  var _error = useState(null);
  var loadError = _error[0];
  var setError = _error[1];

  var _manifest = useState(null);
  var manifestData = _manifest[0];
  var setManifestData = _manifest[1];

  // Load events.jsonl if available
  useEffect(function () {
    if (!faxEntry.hasEvents) return;
    setLoading(true);
    fetch("/api/fax/" + encodeURIComponent(faxEntry.id) + "/events")
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to load events: " + res.status);
        return res.text();
      })
      .then(function (text) {
        setRawText(text);
        var parsed = parseSession(text);
        if (!parsed || !parsed.events || parsed.events.length === 0) {
          throw new Error("Could not parse session events");
        }
        var sessionTotal = getSessionTotal(parsed.events);
        setSession({
          events: parsed.events,
          turns: parsed.turns || [],
          metadata: parsed.metadata || {},
          total: sessionTotal,
          file: faxEntry.folderName + "/events.jsonl",
        });
        setError(null);
      })
      .catch(function (err) {
        setError(err.message || String(err));
      })
      .finally(function () {
        setLoading(false);
      });
  }, [faxEntry]);

  // Load manifest and markdown files
  useEffect(function () {
    fetch("/api/fax/" + encodeURIComponent(faxEntry.id) + "/manifest")
      .then(function (res) { return res.json(); })
      .then(function (data) { setManifestData(data); })
      .catch(function () {});
  }, [faxEntry]);

  // Playback (only when session loaded)
  var events = session ? session.events : [];
  var turns = session ? session.turns : [];
  var metadata = session ? session.metadata : {};
  var total = session ? session.total : 0;

  // FIX: correct arg order is (total, isLive)
  var playback = usePlayback(total, false);

  // FIX: seek to end of session once loaded so all events are visible
  var hasInitialized = useRef(false);
  useEffect(function () {
    if (session && session.total > 0 && !hasInitialized.current) {
      hasInitialized.current = true;
      playback.seek(session.total);
    }
  }, [session]);

  // FIX: useSearch expects eventEntries (not raw events)
  var filteredEventEntries = useMemo(function () {
    return buildFilteredEventEntries(events, trackFilters);
  }, [events, trackFilters]);

  var search = useSearch(filteredEventEntries);
  var searchInputRef = useRef(null);

  var turnStartMap = useMemo(function () {
    return buildTurnStartMap(turns);
  }, [turns]);

  var timeMap = useMemo(function () {
    return buildTimeMap(events);
  }, [events]);

  // Q&A: compute sessionKey and switch session
  var sessionKey = useMemo(function () {
    if (!faxEntry) return null;
    return "fax:" + faxEntry.id;
  }, [faxEntry]);

  var qa = useSessionQA();

  useEffect(function () {
    if (sessionKey && qa.switchSession) {
      qa.switchSession(sessionKey, []);
    }
  }, [sessionKey]);

  var containerRef = useRef(null);

  // Keyboard shortcuts
  var shortcutHandlers = useMemo(function () {
    return {
      "/": function (e) {
        if (searchInputRef.current) {
          e.preventDefault();
          searchInputRef.current.focus();
        }
      },
    };
  }, []);
  useKeyboardShortcuts(shortcutHandlers, containerRef);

  // Render active view
  function renderView() {
    if (loading) {
      return React.createElement("div", {
        style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: theme.text.dim },
      }, "Loading session...");
    }

    if (loadError && SESSION_VIEWS.indexOf(activeView) !== -1) {
      return React.createElement("div", {
        style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#ff6b6b" },
      }, "Error: " + loadError);
    }

    if (activeView === "replay" && session) {
      return React.createElement(ReplayView, {
        currentTime: playback.time,
        eventEntries: filteredEventEntries,
        turns: turns,
        turnStartMap: turnStartMap,
        searchQuery: search.searchQuery,
        matchSet: search.matchSet,
        metadata: metadata,
      });
    }

    if (activeView === "tracks" && session) {
      return React.createElement(TracksView, {
        currentTime: playback.time,
        eventEntries: filteredEventEntries,
        totalTime: total,
        timeMap: timeMap,
        turns: turns,
      });
    }

    if (activeView === "waterfall" && session) {
      return React.createElement(WaterfallView, {
        currentTime: playback.time,
        eventEntries: filteredEventEntries,
        totalTime: total,
        timeMap: timeMap,
        turns: turns,
      });
    }

    if (activeView === "graph" && session) {
      return React.createElement(React.Suspense, {
        fallback: React.createElement("div", {
          style: { padding: 40, color: theme.text.dim, textAlign: "center" },
        }, "Loading graph..."),
      },
        React.createElement(GraphView, {
          currentTime: playback.time,
          eventEntries: filteredEventEntries,
          totalTime: total,
          timeMap: timeMap,
          turns: turns,
        })
      );
    }

    if (activeView === "stats" && session) {
      return React.createElement(StatsView, {
        events: events,
        totalTime: total,
        metadata: metadata,
        turns: turns,
        autonomyMetrics: null,
        onOpenCoach: function () {},
      });
    }

    if (activeView === "qa") {
      return React.createElement(QAView, {
        qa: qa,
        events: events,
        turns: turns,
        metadata: metadata,
        sessionFilePath: null,
        rawText: rawText,
        onSeekTurn: function (turnTime) {
          if (session) {
            playback.seek(turnTime);
            setActiveView("replay");
          }
        },
        onSetView: setActiveView,
      });
    }

    // Fallback: no events, show markdown content
    if (!faxEntry.hasEvents) {
      return React.createElement("div", {
        style: {
          flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
          flexDirection: "column", gap: 12, color: theme.text.dim,
        },
      },
        React.createElement("div", { style: { fontSize: 14 } }, "This fax bundle has no session events."),
        React.createElement("div", { style: { fontSize: 12 } }, "Use the Q&A tab to ask questions about the fax context.")
      );
    }

    return null;
  }

  return React.createElement("div", {
    ref: containerRef,
    style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  },
    React.createElement(FaxMetadataHeader, { faxEntry: faxEntry, onBack: onBack }),
    React.createElement(ViewTabs, {
      activeView: activeView,
      views: FAX_VIEWS,
      onSetView: setActiveView,
      hasEvents: faxEntry.hasEvents,
    }),
    session && SESSION_VIEWS.indexOf(activeView) !== -1 && React.createElement(SearchToolbar, {
      search: search,
      searchInputRef: searchInputRef,
      metadata: metadata,
    }),
    session && SESSION_VIEWS.indexOf(activeView) !== -1 && React.createElement(Timeline, {
      currentTime: playback.time,
      totalTime: total,
      timeMap: timeMap,
      onSeek: playback.seek,
      isPlaying: playback.playing,
      onPlayPause: playback.playPause,
      isLive: false,
      eventEntries: filteredEventEntries,
      turns: turns,
      matchSet: search.matchSet,
    }),
    React.createElement("div", {
      style: { flex: 1, overflow: "hidden" },
    }, renderView())
  );
}
