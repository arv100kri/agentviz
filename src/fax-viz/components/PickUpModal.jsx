import React, { useState, useEffect, useCallback, useRef } from "react";
import { theme } from "../../lib/theme.js";

function formatRelativeTime(isoString) {
  var ms = Date.now() - new Date(isoString).getTime();
  var minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + " min ago";
  var hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h ago";
  var days = Math.floor(hours / 24);
  return days + "d ago";
}

var TOOLS = [
  { id: "copilot-cli", label: "Copilot CLI" },
  { id: "claude-code", label: "Claude Code" },
];

function PickUpModal({ isOpen, onClose, faxId, faxLabel, senderAlias, sourceRoot }) {
  var _tool = useState("copilot-cli");
  var tool = _tool[0];
  var setTool = _tool[1];

  var _mode = useState("new");
  var mode = _mode[0];
  var setMode = _mode[1];

  var _sessions = useState([]);
  var sessions = _sessions[0];
  var setSessions = _sessions[1];

  var _selectedSessionId = useState(null);
  var selectedSessionId = _selectedSessionId[0];
  var setSelectedSessionId = _selectedSessionId[1];

  var _loading = useState(false);
  var loading = _loading[0];
  var setLoading = _loading[1];

  var _error = useState(null);
  var error = _error[0];
  var setError = _error[1];

  var _launched = useState(false);
  var launched = _launched[0];
  var setLaunched = _launched[1];

  var _submitting = useState(false);
  var submitting = _submitting[0];
  var setSubmitting = _submitting[1];

  var _cwd = useState("");
  var cwd = _cwd[0];
  var setCwd = _cwd[1];

  var abortRef = useRef(null);

  // Abort pending requests on unmount
  useEffect(function () {
    return function () {
      if (abortRef.current) abortRef.current.abort();
    };
  }, []);

  // Fetch sessions when modal opens
  useEffect(function () {
    if (!isOpen) return;
    setTool("copilot-cli");
    setMode("new");
    setSelectedSessionId(null);
    setError(null);
    setLaunched(false);
    setSubmitting(false);
    setLoading(true);
    fetch("/api/copilot-sessions")
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to fetch sessions");
        return res.json();
      })
      .then(function (data) {
        setSessions(Array.isArray(data) ? data : Array.isArray(data.sessions) ? data.sessions : []);
        setLoading(false);
      })
      .catch(function (err) {
        setError(err.message);
        setSessions([]);
        setLoading(false);
      });
  }, [isOpen]);

  // Smart default for cwd when sessions load or mode/tool changes
  useEffect(function () {
    if (!isOpen) return;
    if (sourceRoot) {
      setCwd(sourceRoot);
      return;
    }
    var match = sessions.find(function (s) { return s.tool === tool; });
    setCwd(match && match.cwd ? match.cwd : "");
  }, [isOpen, sessions, tool, sourceRoot]);

  var filteredSessions = sessions.filter(function (s) {
    return s.tool === tool;
  });

  var canPickUp = mode === "new" || (mode === "resume" && selectedSessionId);

  var handlePickUp = useCallback(function () {
    if (!canPickUp || submitting) return;
    setSubmitting(true);
    setError(null);

    var controller = new AbortController();
    abortRef.current = controller;

    fetch("/api/fax/" + encodeURIComponent(faxId) + "/pickup", {
      method: "POST",
      signal: controller.signal,
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to get bootstrap prompt");
        return res.json();
      })
      .then(function (data) {
        var bootstrap = data.bootstrap || data.prompt || "";
        if (!bootstrap) {
          setError("No bootstrap prompt found in the fax bundle");
          setSubmitting(false);
          return;
        }
        var body = {
          tool: tool,
          mode: mode,
          prompt: bootstrap,
          cwd: cwd || null,
        };
        if (mode === "resume" && selectedSessionId) {
          body.sessionId = selectedSessionId;
        }
        return fetch("/api/launch-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      })
      .then(function (res) {
        if (!res) return; // early return from bootstrap validation
        if (!res.ok) throw new Error("Failed to launch session");
        setLaunched(true);
        setSubmitting(false);
        setTimeout(function () {
          onClose();
        }, 1200);
      })
      .catch(function (err) {
        if (err.name === "AbortError") return;
        setError(err.message);
        setSubmitting(false);
      });
  }, [canPickUp, submitting, faxId, tool, mode, selectedSessionId, cwd, onClose]);

  // Keyboard handling
  var handleKeyDown = useCallback(function (e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  }, [onClose]);

  useEffect(function () {
    if (!isOpen) return;
    document.addEventListener("keydown", handleKeyDown);
    return function () {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  // Launched success state
  if (launched) {
    return React.createElement("div", {
      style: {
        position: "fixed",
        inset: 0,
        background: theme.bg.overlay,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: theme.z.modal,
      },
    },
      React.createElement("div", {
        style: {
          background: theme.bg.surface,
          border: "1px solid " + theme.border.subtle,
          borderRadius: theme.radius.lg,
          padding: theme.space.xxl,
          textAlign: "center",
          fontFamily: theme.font.mono,
        },
      },
        React.createElement("div", {
          style: {
            fontSize: theme.fontSize.lg,
            color: theme.semantic.success,
            fontWeight: 600,
          },
        }, "Launched!")
      )
    );
  }

  // Tool toggle buttons
  var toolButtons = TOOLS.map(function (t) {
    var isActive = tool === t.id;
    return React.createElement("button", {
      key: t.id,
      onClick: function () {
        setTool(t.id);
        setSelectedSessionId(null);
      },
      style: {
        background: isActive ? theme.accent.primary : theme.bg.raised,
        color: isActive ? theme.text.primary : theme.text.secondary,
        border: "1px solid " + (isActive ? theme.accent.primary : theme.border.default),
        borderRadius: theme.radius.md,
        padding: "6px 14px",
        fontSize: theme.fontSize.base,
        fontFamily: theme.font.mono,
        cursor: "pointer",
        fontWeight: isActive ? 600 : 400,
        transition: "background " + theme.transition.fast + ", color " + theme.transition.fast,
      },
    }, t.label);
  });

  // Radio options
  var radioNew = React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "flex-start",
      gap: theme.space.md,
      cursor: "pointer",
      padding: theme.space.md,
      borderRadius: theme.radius.md,
      background: mode === "new" ? theme.accent.muted : "transparent",
      transition: "background " + theme.transition.fast,
    },
  },
    React.createElement("input", {
      type: "radio",
      name: "pickup-mode",
      value: "new",
      checked: mode === "new",
      onChange: function () { setMode("new"); setSelectedSessionId(null); },
      style: { marginTop: 2, accentColor: theme.accent.primary },
    }),
    React.createElement("div", null,
      React.createElement("div", {
        style: { color: theme.text.primary, fontSize: theme.fontSize.md, fontWeight: 500 },
      }, "New session"),
      React.createElement("div", {
        style: { color: theme.text.secondary, fontSize: theme.fontSize.sm, marginTop: 2 },
      }, "Launch a fresh session with fax context")
    )
  );

  var radioResume = React.createElement("label", {
    style: {
      display: "flex",
      alignItems: "flex-start",
      gap: theme.space.md,
      cursor: "pointer",
      padding: theme.space.md,
      borderRadius: theme.radius.md,
      background: mode === "resume" ? theme.accent.muted : "transparent",
      transition: "background " + theme.transition.fast,
    },
  },
    React.createElement("input", {
      type: "radio",
      name: "pickup-mode",
      value: "resume",
      checked: mode === "resume",
      onChange: function () { setMode("resume"); },
      style: { marginTop: 2, accentColor: theme.accent.primary },
    }),
    React.createElement("div", null,
      React.createElement("div", {
        style: { color: theme.text.primary, fontSize: theme.fontSize.md, fontWeight: 500 },
      }, "Resume session")
    )
  );

  // Session list
  var sessionListDisabled = mode !== "resume";
  var sessionListContent;
  if (loading) {
    sessionListContent = React.createElement("div", {
      style: { color: theme.text.muted, fontSize: theme.fontSize.sm, padding: theme.space.md },
    }, "Loading sessions...");
  } else if (filteredSessions.length === 0) {
    sessionListContent = React.createElement("div", {
      style: { color: theme.text.muted, fontSize: theme.fontSize.sm, padding: theme.space.md },
    }, "No sessions found for this tool");
  } else {
    sessionListContent = filteredSessions.map(function (s) {
      var isSelected = selectedSessionId === s.id;
      return React.createElement("div", {
        key: s.id,
        role: "option",
        "aria-selected": isSelected,
        tabIndex: sessionListDisabled ? -1 : 0,
        onClick: function () {
          if (!sessionListDisabled) setSelectedSessionId(s.id);
        },
        onKeyDown: function (e) {
          if (!sessionListDisabled && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setSelectedSessionId(s.id);
          }
        },
        style: {
          display: "flex",
          alignItems: "center",
          gap: theme.space.md,
          padding: "6px " + theme.space.lg + "px",
          cursor: sessionListDisabled ? "default" : "pointer",
          borderRadius: theme.radius.sm,
          border: isSelected ? "1px solid " + theme.accent.primary : "1px solid transparent",
          background: isSelected ? theme.accent.muted : "transparent",
          transition: "border " + theme.transition.fast + ", background " + theme.transition.fast,
        },
      },
        React.createElement("span", {
          style: {
            color: isSelected ? theme.accent.primary : theme.text.dim,
            fontSize: theme.fontSize.sm,
            flexShrink: 0,
          },
        }, isSelected ? "\u25B8" : " "),
        React.createElement("div", {
          style: { display: "flex", flexDirection: "column", flex: 1, minWidth: 0 },
        },
          React.createElement("span", {
            style: { color: theme.text.primary, fontSize: theme.fontSize.base, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
          }, s.summary || s.project || "Session"),
          (s.project && s.summary) ? React.createElement("span", {
            style: { color: theme.text.dim, fontSize: theme.fontSize.xs, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
          }, s.project + (s.branch ? " (" + s.branch + ")" : "")) : null
        ),
        React.createElement("span", {
          style: { color: theme.text.dim, fontSize: theme.fontSize.sm, flexShrink: 0 },
        }, s.mtime ? formatRelativeTime(s.mtime) : s.updatedAt ? formatRelativeTime(s.updatedAt) : "")
      );
    });
  }

  var sessionList = React.createElement("div", {
    role: "listbox",
    "aria-label": "Available sessions",
    style: {
      background: theme.bg.raised,
      border: "1px solid " + theme.border.default,
      borderRadius: theme.radius.md,
      padding: theme.space.sm,
      marginLeft: 28,
      maxHeight: 160,
      overflowY: "auto",
      opacity: sessionListDisabled ? 0.4 : 1,
      pointerEvents: sessionListDisabled ? "none" : "auto",
      transition: "opacity " + theme.transition.fast,
    },
  }, sessionListContent);

  // Working directory row
  var resumeSessionCwd = null;
  if (mode === "resume" && selectedSessionId) {
    var selectedSession = filteredSessions.find(function (s) { return s.id === selectedSessionId; });
    if (selectedSession && selectedSession.cwd) {
      resumeSessionCwd = selectedSession.cwd;
    }
  }
  var cwdReadOnly = mode === "resume" && selectedSessionId;
  var cwdEl = React.createElement("div", {
    style: { display: "flex", flexDirection: "column", gap: theme.space.sm },
  },
    React.createElement("label", {
      style: {
        color: theme.text.secondary,
        fontSize: theme.fontSize.sm,
      },
    }, "Working directory (optional):"),
    React.createElement("input", {
      type: "text",
      value: cwdReadOnly ? (resumeSessionCwd || "") : cwd,
      readOnly: cwdReadOnly,
      onChange: cwdReadOnly ? undefined : function (e) { setCwd(e.target.value); },
      placeholder: "/path/to/project",
      style: {
        background: theme.bg.raised,
        border: "1px solid " + theme.border.default,
        borderRadius: theme.radius.md,
        color: cwdReadOnly ? theme.text.muted : theme.text.primary,
        fontSize: theme.fontSize.base,
        fontFamily: theme.font.mono,
        padding: "6px " + theme.space.md + "px",
        outline: "none",
        opacity: cwdReadOnly ? 0.6 : 1,
      },
    })
  );

  // Error display
  var errorEl = error ? React.createElement("div", {
    role: "alert",
    style: {
      background: theme.semantic.errorBg,
      border: "1px solid " + theme.semantic.errorBorder,
      borderRadius: theme.radius.md,
      color: theme.semantic.errorText,
      fontSize: theme.fontSize.sm,
      padding: theme.space.md,
      marginTop: theme.space.md,
    },
  }, error) : null;

  // Action buttons
  var pickUpBtn = React.createElement("button", {
    onClick: handlePickUp,
    disabled: !canPickUp || submitting,
    style: {
      background: canPickUp && !submitting ? theme.accent.primary : theme.bg.active,
      color: canPickUp && !submitting ? theme.text.primary : theme.text.muted,
      border: "none",
      borderRadius: theme.radius.md,
      padding: "8px 20px",
      fontSize: theme.fontSize.md,
      fontFamily: theme.font.mono,
      fontWeight: 600,
      cursor: canPickUp && !submitting ? "pointer" : "not-allowed",
      transition: "background " + theme.transition.fast,
    },
  }, submitting ? "Launching..." : "Pick Up");

  var cancelBtn = React.createElement("button", {
    onClick: onClose,
    style: {
      background: theme.bg.raised,
      color: theme.text.secondary,
      border: "1px solid " + theme.border.default,
      borderRadius: theme.radius.md,
      padding: "8px 20px",
      fontSize: theme.fontSize.md,
      fontFamily: theme.font.mono,
      cursor: "pointer",
      transition: "background " + theme.transition.fast,
    },
  }, "Cancel");

  // Title
  var title = React.createElement("div", {
    style: {
      fontSize: theme.fontSize.lg,
      fontWeight: 600,
      color: theme.text.primary,
      fontFamily: theme.font.mono,
    },
  },
    "Pick Up: ",
    faxLabel || faxId,
    React.createElement("span", {
      style: { color: theme.text.secondary, fontWeight: 400, fontSize: theme.fontSize.base },
    }, " (from " + (senderAlias || "unknown") + ")")
  );

  // Compose modal
  return React.createElement("div", {
    style: {
      position: "fixed",
      inset: 0,
      background: theme.bg.overlay,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      zIndex: theme.z.modal,
    },
    onClick: function (e) {
      if (e.target === e.currentTarget) onClose();
    },
  },
    React.createElement("div", {
      role: "dialog",
      "aria-label": "Pick up fax: " + (faxLabel || faxId),
      style: {
        background: theme.bg.surface,
        border: "1px solid " + theme.border.subtle,
        borderRadius: theme.radius.lg,
        padding: theme.space.xxl,
        width: 480,
        maxWidth: "90vw",
        maxHeight: "80vh",
        overflowY: "auto",
        fontFamily: theme.font.mono,
        display: "flex",
        flexDirection: "column",
        gap: theme.space.xl,
        boxShadow: theme.shadow.lg,
      },
    },
      // Title
      title,

      // Tool selector
      React.createElement("div", {
        style: { display: "flex", alignItems: "center", gap: theme.space.md },
      },
        React.createElement("span", {
          style: { color: theme.text.secondary, fontSize: theme.fontSize.base },
        }, "Tool:"),
        React.createElement("div", {
          style: { display: "flex", gap: theme.space.sm },
        }, toolButtons)
      ),

      // Mode selection
      React.createElement("div", {
        style: { display: "flex", flexDirection: "column", gap: theme.space.md },
      },
        radioNew,
        radioResume,
        sessionList
      ),

      // Working directory
      cwdEl,

      // Error
      errorEl,

      // Actions
      React.createElement("div", {
        style: {
          display: "flex",
          justifyContent: "flex-end",
          gap: theme.space.md,
          marginTop: theme.space.md,
        },
      }, pickUpBtn, cancelBtn)
    )
  );
}

export default PickUpModal;
