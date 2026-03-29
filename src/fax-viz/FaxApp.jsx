import React, { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { theme } from "../lib/theme.js";
import useFaxDiscovery from "./hooks/useFaxDiscovery.js";
import useFaxReadStatus from "./hooks/useFaxReadStatus.js";
import useKeyboardShortcuts from "../hooks/useKeyboardShortcuts.js";
import FaxInboxView from "./components/FaxInboxView.jsx";
import FaxObserveShell from "./components/FaxObserveShell.jsx";

function parseFaxHash() {
  var hash = window.location.hash || "";
  var match = hash.match(/^#\/fax\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function FaxApp() {
  var discovery = useFaxDiscovery();
  var readStatus = useFaxReadStatus();

  var _route = useState({ view: "inbox", faxId: null });
  var route = _route[0];
  var setRoute = _route[1];

  // Handle #/fax/:id hash route for direct open (e.g. --open flag)
  var _hashHandled = useRef(false);
  useEffect(function () {
    if (_hashHandled.current || discovery.loading) return;
    var hashFaxId = parseFaxHash();
    if (!hashFaxId) return;
    var faxEntry = discovery.faxes.find(function (f) { return f.id === hashFaxId; });
    if (faxEntry) {
      _hashHandled.current = true;
      readStatus.markRead(faxEntry.folderName);
      setRoute({ view: "observe", faxId: faxEntry.id, faxEntry: faxEntry });
    } else if (!discovery.loading && discovery.faxes.length > 0) {
      _hashHandled.current = true;
    }
  }, [discovery.faxes, discovery.loading]);

  var openFax = useCallback(function (faxEntry) {
    readStatus.markRead(faxEntry.folderName);
    setRoute({ view: "observe", faxId: faxEntry.id, faxEntry: faxEntry });
  }, [readStatus]);

  var goBack = useCallback(function () {
    setRoute({ view: "inbox", faxId: null });
  }, []);

  // Keyboard shortcuts
  var shortcutHandlers = useMemo(function () {
    return {
      Escape: function () {
        if (route.view === "observe") goBack();
      },
    };
  }, [route.view, goBack]);

  var containerRef = useRef(null);
  useKeyboardShortcuts(shortcutHandlers, containerRef);

  if (route.view === "observe" && route.faxEntry) {
    return React.createElement("div", {
      ref: containerRef,
      style: {
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        background: theme.bg.primary,
        color: theme.text.primary,
        fontFamily: theme.font.mono,
      },
    },
      React.createElement(FaxObserveShell, {
        faxEntry: route.faxEntry,
        onBack: goBack,
      })
    );
  }

  return React.createElement("div", {
    ref: containerRef,
    style: {
      height: "100vh",
      display: "flex",
      flexDirection: "column",
      background: theme.bg.primary,
      color: theme.text.primary,
      fontFamily: theme.font.mono,
    },
  },
    // Header
    React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 20px",
        borderBottom: "1px solid " + theme.border.default,
        flexShrink: 0,
      },
    },
      React.createElement("span", {
        style: { fontSize: 16, fontWeight: 700, color: theme.text.primary, letterSpacing: 2 },
      }, "FAX-VIZ"),
      React.createElement("span", {
        style: { fontSize: 12, color: theme.text.dim },
      }, discovery.faxes.length + " bundles"),
      React.createElement("div", { style: { flex: 1 } }),
      React.createElement("button", {
        className: "av-btn",
        onClick: discovery.refresh,
        style: {
          background: "transparent",
          border: "1px solid " + theme.border.default,
          borderRadius: 6,
          color: theme.text.secondary,
          padding: "4px 12px",
          fontSize: 12,
          fontFamily: theme.font.mono,
        },
      }, "\u21BB Refresh")
    ),
    // Body
    React.createElement(FaxInboxView, {
      faxes: discovery.faxes,
      loading: discovery.loading,
      error: discovery.error,
      readStatus: readStatus,
      onOpenFax: openFax,
    })
  );
}
