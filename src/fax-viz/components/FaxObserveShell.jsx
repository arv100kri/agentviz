import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { theme, TRACK_TYPES, alpha } from "../../lib/theme.js";
import { parseSession } from "../../lib/parseSession.ts";
import { getSessionTotal, buildFilteredEventEntries, buildTurnStartMap, buildTimeMap } from "../../lib/session";
import { findJumpTarget, nextSpeed, toggleFilter, focusSearchInput } from "../../lib/playbackUtils.js";
import usePlayback from "../../hooks/usePlayback.js";
import useSearch from "../../hooks/useSearch.js";
import useKeyboardShortcuts from "../../hooks/useKeyboardShortcuts.js";
import usePersistentState from "../../hooks/usePersistentState.js";
import ReplayView from "../../components/ReplayView.jsx";
import TracksView from "../../components/TracksView.jsx";
import StatsView from "../../components/StatsView.jsx";
import QAView from "../../components/QAView.jsx";
import Timeline from "../../components/Timeline.jsx";
import useSessionQA from "../../hooks/useSessionQA.js";
import { IMPORTANCE_COLORS } from "../lib/faxConstants.js";
import Icon from "../../components/Icon.jsx";
import PickUpModal from "./PickUpModal.jsx";
import FaxQADrawer from "./FaxQADrawer.jsx";

var PLAYBACK_SPEEDS = [0.5, 1, 2, 4, 8];

var FAX_VIEWS = [
  { id: "replay", label: "Replay", icon: "play" },
  { id: "tracks", label: "Tracks", icon: "tracks" },
  { id: "stats", label: "Stats", icon: "stats" },
];

// Views that require events.jsonl
var SESSION_VIEWS = ["replay", "tracks", "stats"];

function formatSenderProgram(program) {
  if (!program) return null;
  if (program === "copilot-cli") return "Copilot CLI";
  if (program === "claude-code") return "Claude";
  // Capitalize first letter for unknown programs
  return program.charAt(0).toUpperCase() + program.slice(1);
}

function FaxMetadataHeader({ faxEntry, onBack, onPickUp }) {
  var importanceColor = IMPORTANCE_COLORS[faxEntry.importance] || IMPORTANCE_COLORS.normal;

  var progress = faxEntry.progress;
  var progressCompleted = progress && Array.isArray(progress.stepsCompleted) ? progress.stepsCompleted.length : 0;
  var progressRemaining = progress && Array.isArray(progress.stepsRemaining) ? progress.stepsRemaining.length : 0;
  var progressTotal = progressCompleted + progressRemaining;
  var progressAllDone = progressTotal > 0 && progressCompleted === progressTotal;

  var programLabel = formatSenderProgram(faxEntry.sender.program);

  var metaPillStyle = {
    fontSize: theme.fontSize.xs,
    color: theme.text.dim,
    background: theme.bg.raised,
    border: "1px solid " + theme.border.subtle,
    borderRadius: 3,
    padding: "1px 5px",
    flexShrink: 0,
  };

  // Row 1: Back | label | importance | spacer | Pick Up
  var row1 = React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 12,
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
    React.createElement("span", {
      style: {
        fontSize: 10, fontWeight: 700, color: importanceColor,
        border: "1px solid " + importanceColor, borderRadius: 3,
        padding: "1px 5px", letterSpacing: 1,
      },
    }, (faxEntry.importance || "normal").toUpperCase()),
    React.createElement("div", { style: { flex: 1 } }),
    React.createElement("button", {
      className: "av-btn",
      onClick: function () { if (onPickUp) onPickUp(); },
      style: {
        background: theme.accent.primary,
        color: theme.text.primary,
        border: "none",
        borderRadius: theme.radius.md + "px",
        padding: theme.space.sm + "px " + theme.space.lg + "px",
        fontSize: theme.fontSize.sm,
        fontFamily: theme.font.mono,
        fontWeight: 600,
        cursor: "pointer",
      },
    }, "Pick Up")
  );

  // Row 2: sender + program | branch | progress | artifacts | thread | session | date
  var row2Items = [];

  // Sender alias/email
  row2Items.push(
    React.createElement("span", {
      key: "sender",
      style: { fontSize: 11, color: theme.text.dim },
    }, faxEntry.sender.alias || faxEntry.sender.email)
  );

  // Sender program pill
  if (programLabel) {
    row2Items.push(
      React.createElement("span", {
        key: "program",
        style: metaPillStyle,
      }, programLabel)
    );
  }

  // Branch
  if (faxEntry.git && faxEntry.git.branch) {
    row2Items.push(
      React.createElement("span", {
        key: "branch",
        style: { fontSize: 11, color: theme.text.dim },
      }, "\u2192 " + faxEntry.git.branch)
    );
  }

  // Progress summary
  if (progressTotal > 0) {
    row2Items.push(
      React.createElement("span", {
        key: "progress",
        style: {
          fontSize: 11,
          color: progressAllDone ? theme.semantic.success : theme.text.dim,
        },
      }, progressAllDone
        ? "\u2713 " + progressTotal + "/" + progressTotal + " steps"
        : progressCompleted + "/" + progressTotal + " steps"
      )
    );
  }

  // Artifact count
  if (faxEntry.artifactCount > 0) {
    var artifactText = faxEntry.artifactCount + " file" + (faxEntry.artifactCount !== 1 ? "s" : "");
    if (faxEntry.sharedArtifactCount > 0) {
      artifactText += ", " + faxEntry.sharedArtifactCount + " shared";
    }
    row2Items.push(
      React.createElement("span", {
        key: "artifacts",
        style: { fontSize: 11, color: theme.text.dim },
      }, "\uD83D\uDCC4 " + artifactText)
    );
  }

  // Thread indicator
  if (faxEntry.threadId) {
    row2Items.push(
      React.createElement("span", {
        key: "thread",
        style: metaPillStyle,
      }, "\uD83D\uDD17 Thread")
    );
  }

  // Session badge
  if (faxEntry.hasEvents) {
    row2Items.push(
      React.createElement("span", {
        key: "session",
        style: {
          fontSize: 10,
          fontWeight: 700,
          color: theme.semantic.success,
          border: "1px solid " + theme.semantic.success,
          borderRadius: 3,
          padding: "0px 4px",
          letterSpacing: 1,
          flexShrink: 0,
        },
      }, "SESSION")
    );
  }

  // Date (pushed to end)
  row2Items.push(
    React.createElement("div", { key: "spacer", style: { flex: 1 } })
  );
  row2Items.push(
    React.createElement("span", {
      key: "date",
      style: { fontSize: 11, color: theme.text.dim },
    }, faxEntry.createdUtc ? new Date(faxEntry.createdUtc).toLocaleString() : "")
  );

  var row2 = React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      paddingLeft: 68,
    },
  }, row2Items);

  return React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 4,
      padding: "8px 16px",
      borderBottom: "1px solid " + theme.border.default,
      flexShrink: 0,
    },
  }, row1, row2);
}

function ViewTabs({ activeView, views, onSetView, hasEvents }) {
  return React.createElement("div", {
    style: {
      display: "flex",
      gap: 2,
      padding: 2,
      borderRadius: theme.radius.lg,
      background: theme.bg.surface,
      flexShrink: 0,
      marginLeft: 16,
      marginTop: 4,
      marginBottom: 4,
      width: "fit-content",
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
          background: isActive ? theme.bg.raised : "transparent",
          border: "none",
          borderRadius: theme.radius.md,
          color: disabled ? theme.text.dim : isActive ? theme.accent.primary : theme.text.muted,
          padding: "4px 8px",
          fontSize: theme.fontSize.sm,
          fontFamily: theme.font.ui,
          display: "flex",
          alignItems: "center",
          gap: 4,
          whiteSpace: "nowrap",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.4 : 1,
        },
      },
        v.icon && React.createElement(Icon, { name: v.icon, size: 13, style: { opacity: isActive ? 1 : 0.6 } }),
        v.label
      );
    })
  );
}

function SearchToolbar({
  search, searchInputRef, metadata,
  errorEntries, onJumpToError,
  trackFilters, onToggleTrackFilter, activeFilterCount,
  speed, onCycleSpeed, activeView,
}) {
  var showFiltersBtn = activeView === "replay" || activeView === "tracks";
  var showSpeed = activeView === "replay" || activeView === "tracks";
  var showErrorNav = activeView === "replay";

  var _showFilters = useState(false);
  var showFilters = _showFilters[0];
  var setShowFilters = _showFilters[1];
  var filtersRef = useRef(null);

  // Close filter dropdown on outside click
  useEffect(function () {
    if (!showFilters) return;
    function handleClick(e) {
      if (filtersRef.current && !filtersRef.current.contains(e.target)) {
        setShowFilters(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return function () { document.removeEventListener("mousedown", handleClick); };
  }, [showFilters]);

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
    // Search input
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
          background: theme.bg.raised,
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

    // Error navigation
    showErrorNav && errorEntries.length > 0 && React.createElement("div", {
      style: { display: "flex", alignItems: "center", gap: 2 },
    },
      React.createElement("button", {
        className: "av-btn",
        onClick: function () { onJumpToError("prev"); },
        title: "Previous error (Shift+E)",
        "aria-label": "Previous error",
        style: {
          background: "transparent",
          border: "1px solid " + theme.semantic.errorBorder,
          borderRadius: theme.radius.sm,
          color: theme.semantic.error,
          padding: "2px 4px",
          fontSize: theme.fontSize.sm,
          fontFamily: theme.font.ui,
          display: "flex",
          alignItems: "center",
          cursor: "pointer",
        },
      }, React.createElement(Icon, { name: "chevron-left", size: 12 })),
      React.createElement("span", {
        style: {
          fontSize: theme.fontSize.sm,
          color: theme.semantic.error,
          display: "flex",
          alignItems: "center",
          gap: 4,
        },
      },
        React.createElement(Icon, { name: "alert-circle", size: 12 }),
        " " + errorEntries.length
      ),
      React.createElement("button", {
        className: "av-btn",
        onClick: function () { onJumpToError("next"); },
        title: "Next error (E)",
        "aria-label": "Next error",
        style: {
          background: "transparent",
          border: "1px solid " + theme.semantic.errorBorder,
          borderRadius: theme.radius.sm,
          color: theme.semantic.error,
          padding: "2px 4px",
          fontSize: theme.fontSize.sm,
          fontFamily: theme.font.ui,
          display: "flex",
          alignItems: "center",
          cursor: "pointer",
        },
      }, React.createElement(Icon, { name: "chevron-right", size: 12 }))
    ),

    // Track filters
    showFiltersBtn && React.createElement("div", {
      ref: filtersRef,
      style: { position: "relative" },
    },
      React.createElement("button", {
        className: "av-btn",
        onClick: function () { setShowFilters(function (v) { return !v; }); },
        title: "Filter tracks",
        "aria-label": "Filter tracks",
        style: {
          background: activeFilterCount > 0 ? alpha(theme.accent.primary, 0.08) : "transparent",
          border: "1px solid " + (activeFilterCount > 0 ? theme.accent.primary : theme.border.default),
          borderRadius: theme.radius.md,
          color: activeFilterCount > 0 ? theme.accent.primary : theme.text.muted,
          padding: "2px 8px",
          fontSize: theme.fontSize.sm,
          fontFamily: theme.font.ui,
          display: "flex",
          alignItems: "center",
          gap: 4,
          cursor: "pointer",
        },
      },
        React.createElement(Icon, { name: "filter", size: 12 }),
        activeFilterCount > 0 && React.createElement("span", {
          style: { fontSize: theme.fontSize.xs },
        }, activeFilterCount)
      ),
      showFilters && React.createElement("div", {
        style: {
          position: "absolute",
          top: "calc(100% + 6px)",
          right: 0,
          background: theme.bg.surface,
          border: "1px solid " + theme.border.strong,
          borderRadius: theme.radius.lg,
          padding: 6,
          zIndex: theme.z.tooltip,
          boxShadow: theme.shadow.md,
          minWidth: 160,
        },
      },
        Object.entries(TRACK_TYPES).map(function (entry) {
          var key = entry[0];
          var info = entry[1];
          var isHidden = trackFilters[key];
          return React.createElement("button", {
            key: key,
            className: "av-interactive",
            onClick: function () { onToggleTrackFilter(key); },
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "4px 10px",
              borderRadius: theme.radius.md,
              width: "100%",
              background: "transparent",
              border: "none",
              cursor: "pointer",
              textAlign: "left",
            },
          },
            React.createElement(Icon, { name: key, size: 12, style: { color: isHidden ? theme.text.ghost : info.color } }),
            React.createElement("span", {
              style: {
                fontSize: theme.fontSize.xs,
                fontFamily: theme.font.mono,
                color: isHidden ? theme.text.ghost : theme.text.secondary,
                textDecoration: isHidden ? "line-through" : "none",
                flex: 1,
              },
            }, info.label),
            isHidden && React.createElement("span", {
              style: { fontSize: theme.fontSize.xs, color: theme.text.ghost, fontFamily: theme.font.mono },
            }, "hidden")
          );
        })
      )
    ),

    // Speed control
    showSpeed && React.createElement("button", {
      className: "av-btn",
      onClick: onCycleSpeed,
      title: "Playback speed (click to cycle)",
      style: {
        background: speed !== 1 ? alpha(theme.accent.primary, 0.08) : "transparent",
        border: "1px solid " + (speed !== 1 ? theme.accent.primary : theme.border.default),
        borderRadius: theme.radius.md,
        color: speed !== 1 ? theme.accent.primary : theme.text.muted,
        padding: "2px 8px",
        fontSize: theme.fontSize.sm,
        fontFamily: theme.font.ui,
        display: "flex",
        alignItems: "center",
        gap: 4,
        cursor: "pointer",
      },
    }, speed + "x")
  );
}

export default function FaxObserveShell({ faxEntry, onBack }) {
  var _view = usePersistentState("fax-viz:view", faxEntry.hasEvents ? "replay" : "qa");
  var activeView = _view[0];
  var setActiveView = _view[1];

  var _showPickup = useState(false);
  var showPickup = _showPickup[0];
  var setShowPickup = _showPickup[1];

  var _showQA = useState(false);
  var showQA = _showQA[0];
  var setShowQA = _showQA[1];

  var _trackFilters = usePersistentState("fax-viz:track-filters", {});
  var trackFilters = _trackFilters[0];
  var setTrackFilters = _trackFilters[1];

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

  // Track filter toggle
  var toggleTrackFilter = useCallback(function (trackKey) {
    setTrackFilters(function (prev) { return toggleFilter(prev, trackKey); });
  }, [setTrackFilters]);

  var activeFilterCount = Object.keys(trackFilters).length;

  // Speed cycling
  var cycleSpeed = useCallback(function () {
    playback.setSpeed(nextSpeed(PLAYBACK_SPEEDS, playback.speed));
  }, [playback.speed, playback.setSpeed]);

  // Error navigation
  var jumpToEntries = useCallback(function (entries, direction) {
    var target = findJumpTarget(entries, playback.time, direction);
    if (target !== null) playback.seek(target);
  }, [playback.seek, playback.time]);

  var errorEntries = useMemo(function () {
    return filteredEventEntries.filter(function (entry) { return entry.event.isError; });
  }, [filteredEventEntries]);

  var jumpToError = useCallback(function (direction) {
    jumpToEntries(errorEntries, direction);
  }, [errorEntries, jumpToEntries]);

  var focusSearch = useCallback(function () {
    return focusSearchInput(searchInputRef);
  }, []);

  // Ctrl+Shift+K to toggle Q&A drawer
  useEffect(function () {
    function handleQAShortcut(e) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowQA(function (prev) { return !prev; });
      }
    }
    window.addEventListener("keydown", handleQAShortcut);
    return function () { window.removeEventListener("keydown", handleQAShortcut); };
  }, []);

  // Keyboard shortcuts (full AGENTVIZ set)
  useKeyboardShortcuts({
    hasSession: Boolean(session),
    showHero: false,
    showPalette: showQA,
    time: playback.time,
    onTogglePalette: function () {},
    onDismissHero: function () {},
    onPlayPause: playback.playPause,
    onSeek: playback.seek,
    onSetView: function (viewId) {
      var viewMap = {
        replay: "replay",
        tracks: "tracks",
        waterfall: "stats",
        stats: "stats",
      };
      var target = viewMap[viewId];
      if (target) {
        var isSession = SESSION_VIEWS.indexOf(target) !== -1;
        if (!isSession || session) {
          setActiveView(target);
        }
      }
    },
    onJumpToError: jumpToError,
    onFocusSearch: focusSearch,
    onToggleShortcuts: function () {},
  });

  // Render active view
  function renderView() {
    if (loading) {
      return React.createElement("div", {
        style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: theme.text.dim },
      }, "Loading session...");
    }

    if (loadError && SESSION_VIEWS.indexOf(activeView) !== -1) {
      return React.createElement("div", {
        style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: theme.semantic.errorText },
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

    // Fallback: no events, show markdown content
    if (!faxEntry.hasEvents) {
      return React.createElement("div", {
        style: {
          flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
          flexDirection: "column", gap: 12, color: theme.text.dim,
        },
      },
        React.createElement("div", { style: { fontSize: 14 } }, "This fax bundle has no session events."),
        React.createElement("div", { style: { fontSize: 12 } }, "Press Ctrl+Shift+K to open Q&A and ask questions about the fax context.")
      );
    }

    return null;
  }

  return React.createElement("div", {
    ref: containerRef,
    style: { display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" },
  },
    React.createElement(FaxMetadataHeader, { faxEntry: faxEntry, onBack: onBack, onPickUp: function () { setShowPickup(true); } }),
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
      errorEntries: errorEntries,
      onJumpToError: jumpToError,
      trackFilters: trackFilters,
      onToggleTrackFilter: toggleTrackFilter,
      activeFilterCount: activeFilterCount,
      speed: playback.speed,
      onCycleSpeed: cycleSpeed,
      activeView: activeView,
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
    }, renderView()),
    showPickup && React.createElement(PickUpModal, {
      isOpen: true,
      onClose: function () { setShowPickup(false); },
      faxId: faxEntry.id,
      faxLabel: faxEntry.label,
      senderAlias: faxEntry.sender && faxEntry.sender.alias ? faxEntry.sender.alias : "Unknown",
      sourceRoot: faxEntry.sourceRoot || null,
    }),
    React.createElement(FaxQADrawer, {
      open: showQA,
      onClose: function () { setShowQA(false); },
      qa: qa,
      events: session ? session.events : [],
      turns: session ? session.turns : [],
      metadata: metadata,
      playback: playback,
      setActiveView: setActiveView,
    })
  );
}
