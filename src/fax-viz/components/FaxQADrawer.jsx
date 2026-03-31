/**
 * FaxQADrawer -- slide-over Q&A drawer for fax-viz.
 *
 * Thin wrapper: drawer chrome (backdrop, panel, header, close) around QAView.
 * Opens via Ctrl+Shift+K. Uses the existing useSessionQA hook for server-side
 * pipeline (SQLite, lunr.js, multi-tier routing).
 */

import React from "react";
import { theme, alpha } from "../../lib/theme.js";
import QAView from "../../components/QAView.jsx";
import Icon from "../../components/Icon.jsx";

export default function FaxQADrawer({ open, onClose, qa, events, turns, metadata, playback, setActiveView }) {
  if (!open) return null;

  // Escape to close
  React.useEffect(function () {
    function handleKey(e) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    }
    window.addEventListener("keydown", handleKey);
    return function () { window.removeEventListener("keydown", handleKey); };
  }, [onClose]);

  return React.createElement(React.Fragment, null,
    // Backdrop
    React.createElement("div", {
      onClick: onClose,
      style: {
        position: "fixed",
        inset: 0,
        background: alpha(theme.bg.base, 0.4),
        zIndex: theme.z.overlay,
      },
    }),
    // Drawer panel
    React.createElement("div", {
      role: "dialog",
      "aria-label": "Session Q&A",
      style: {
        position: "fixed",
        top: 0,
        right: 0,
        width: 420,
        height: "100dvh",
        background: theme.bg.surface,
        borderLeft: "1px solid " + theme.border.default,
        boxShadow: theme.shadow.lg,
        zIndex: theme.z.modal,
        display: "flex",
        flexDirection: "column",
        fontFamily: theme.font.mono,
        boxSizing: "border-box",
        overflow: "hidden",
      },
    },
      React.createElement(QAView, {
        qa: qa,
        events: events || [],
        turns: turns || [],
        metadata: metadata || {},
        sessionFilePath: null,
        rawText: "",
        enableInstantClassifier: true,
        onSeekTurn: function (turnTime) {
          if (playback && playback.seek) {
            playback.seek(turnTime);
            if (setActiveView) setActiveView("replay");
          }
          onClose();
        },
        onSetView: setActiveView || function () {},
      })
    )
  );
}
