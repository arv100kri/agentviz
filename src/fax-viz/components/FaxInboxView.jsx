import React, { useState, useMemo } from "react";
import { theme } from "../../lib/theme.js";
import {
  IMPORTANCE_COLORS,
  IMPORTANCE_LABELS,
  IMPORTANCE_ORDER,
  SORT_OPTIONS,
} from "../lib/faxConstants.js";
import PickUpModal from "./PickUpModal.jsx";

function ImportanceBadge({ importance }) {
  var color = IMPORTANCE_COLORS[importance] || IMPORTANCE_COLORS.normal;
  var label = IMPORTANCE_LABELS[importance] || "NORMAL";
  return React.createElement("span", {
    style: {
      fontSize: 10,
      fontWeight: 700,
      color: color,
      border: "1px solid " + color,
      borderRadius: 3,
      padding: "1px 5px",
      letterSpacing: 1,
      flexShrink: 0,
    },
  }, label);
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    var d = new Date(iso);
    var now = new Date();
    var diff = now.getTime() - d.getTime();
    var days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return "Today " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (days === 1) return "Yesterday";
    if (days < 7) return days + "d ago";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch (e) {
    return iso.substring(0, 10);
  }
}

function ProgressSummary({ progress }) {
  if (!progress) return null;
  var completed = Array.isArray(progress.stepsCompleted) ? progress.stepsCompleted.length : 0;
  var remaining = Array.isArray(progress.stepsRemaining) ? progress.stepsRemaining.length : 0;
  var total = completed + remaining;
  if (total === 0) return null;
  return React.createElement("span", {
    style: { fontSize: 11, color: theme.text.dim },
  }, completed + "/" + total + " steps");
}

function ThreadIndicator({ count }) {
  if (!count || count <= 1) return null;
  return React.createElement("span", {
    style: {
      fontSize: 10,
      color: theme.text.dim,
      background: theme.bg.secondary,
      borderRadius: 3,
      padding: "1px 5px",
    },
  }, "\uD83D\uDD17 " + count);
}

export default function FaxInboxView({ faxes, loading, error, readStatus, onOpenFax }) {
  var _sort = useState(SORT_OPTIONS.DATE_DESC);
  var sortBy = _sort[0];
  var setSortBy = _sort[1];

  var _search = useState("");
  var search = _search[0];
  var setSearch = _search[1];

  var _filter = useState("all");
  var importanceFilter = _filter[0];
  var setImportanceFilter = _filter[1];

  var _pickupFax = useState(null);
  var pickupFax = _pickupFax[0];
  var setPickupFax = _pickupFax[1];

  // Group by thread
  var threadCounts = useMemo(function () {
    var counts = {};
    faxes.forEach(function (f) {
      if (f.threadId) counts[f.threadId] = (counts[f.threadId] || 0) + 1;
    });
    return counts;
  }, [faxes]);

  // Filter and sort
  var filteredFaxes = useMemo(function () {
    var result = faxes.filter(function (f) {
      if (importanceFilter !== "all" && f.importance !== importanceFilter) return false;
      if (search) {
        var q = search.toLowerCase();
        var haystack = [f.label, f.sender.alias, f.sender.email, f.folderName].join(" ").toLowerCase();
        if (haystack.indexOf(q) === -1) return false;
      }
      return true;
    });

    result.sort(function (a, b) {
      if (sortBy === SORT_OPTIONS.DATE_DESC) return (b.createdUtc || "").localeCompare(a.createdUtc || "");
      if (sortBy === SORT_OPTIONS.DATE_ASC) return (a.createdUtc || "").localeCompare(b.createdUtc || "");
      if (sortBy === SORT_OPTIONS.IMPORTANCE) {
        var ia = IMPORTANCE_ORDER[a.importance] != null ? IMPORTANCE_ORDER[a.importance] : 2;
        var ib = IMPORTANCE_ORDER[b.importance] != null ? IMPORTANCE_ORDER[b.importance] : 2;
        if (ia !== ib) return ia - ib;
        return (b.createdUtc || "").localeCompare(a.createdUtc || "");
      }
      if (sortBy === SORT_OPTIONS.SENDER) {
        var sa = (a.sender.alias || a.sender.email || "").toLowerCase();
        var sb = (b.sender.alias || b.sender.email || "").toLowerCase();
        return sa.localeCompare(sb);
      }
      return 0;
    });

    return result;
  }, [faxes, sortBy, search, importanceFilter]);

  if (loading && faxes.length === 0) {
    return React.createElement("div", {
      style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: theme.text.dim },
    }, "Loading fax bundles...");
  }

  if (error) {
    return React.createElement("div", {
      style: { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#ff6b6b" },
    }, "Error: " + error);
  }

  if (faxes.length === 0) {
    return React.createElement("div", {
      style: {
        flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", gap: 12, color: theme.text.dim,
      },
    },
      React.createElement("div", { style: { fontSize: 32 } }, "\uD83D\uDCE0"),
      React.createElement("div", { style: { fontSize: 14 } }, "No fax bundles found"),
      React.createElement("div", { style: { fontSize: 12 } }, "Check that --fax-dir points to the right directory")
    );
  }

  return React.createElement("div", {
    style: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" },
  },
    // Toolbar
    React.createElement("div", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 20px",
        borderBottom: "1px solid " + theme.border.default,
        flexShrink: 0,
      },
    },
      React.createElement("input", {
        className: "av-search",
        type: "text",
        placeholder: "Search faxes...",
        value: search,
        onChange: function (e) { setSearch(e.target.value); },
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
      }),
      React.createElement("select", {
        value: importanceFilter,
        onChange: function (e) { setImportanceFilter(e.target.value); },
        style: {
          background: theme.bg.secondary,
          border: "1px solid " + theme.border.default,
          borderRadius: 6,
          color: theme.text.secondary,
          padding: "5px 8px",
          fontSize: 12,
          fontFamily: theme.font.mono,
        },
      },
        React.createElement("option", { value: "all" }, "All"),
        React.createElement("option", { value: "urgent" }, "Urgent"),
        React.createElement("option", { value: "high" }, "High"),
        React.createElement("option", { value: "normal" }, "Normal")
      ),
      React.createElement("select", {
        value: sortBy,
        onChange: function (e) { setSortBy(e.target.value); },
        style: {
          background: theme.bg.secondary,
          border: "1px solid " + theme.border.default,
          borderRadius: 6,
          color: theme.text.secondary,
          padding: "5px 8px",
          fontSize: 12,
          fontFamily: theme.font.mono,
        },
      },
        React.createElement("option", { value: SORT_OPTIONS.DATE_DESC }, "Newest first"),
        React.createElement("option", { value: SORT_OPTIONS.DATE_ASC }, "Oldest first"),
        React.createElement("option", { value: SORT_OPTIONS.IMPORTANCE }, "By importance"),
        React.createElement("option", { value: SORT_OPTIONS.SENDER }, "By sender")
      ),
      React.createElement("span", {
        style: { fontSize: 11, color: theme.text.dim, marginLeft: 8 },
      }, filteredFaxes.length + " of " + faxes.length)
    ),

    // Fax list
    React.createElement("div", {
      style: { flex: 1, overflowY: "auto", padding: "4px 0" },
    },
      filteredFaxes.map(function (fax) {
        var isUnread = !readStatus.isRead(fax.folderName);
        return React.createElement("div", {
          key: fax.id,
          className: "av-interactive",
          onClick: function () { onOpenFax(fax); },
          style: {
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 20px",
            cursor: "pointer",
            borderBottom: "1px solid " + theme.border.default,
            opacity: isUnread ? 1 : 0.7,
          },
        },
          // Unread indicator
          React.createElement("div", {
            style: {
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: isUnread ? theme.accent.blue : "transparent",
              flexShrink: 0,
            },
          }),
          // Main content
          React.createElement("div", {
            style: { flex: 1, minWidth: 0 },
          },
            React.createElement("div", {
              style: {
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 2,
              },
            },
              React.createElement("span", {
                style: {
                  fontSize: 13,
                  fontWeight: isUnread ? 600 : 400,
                  color: theme.text.primary,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                },
              }, fax.label),
              React.createElement(ImportanceBadge, { importance: fax.importance }),
              React.createElement(ThreadIndicator, { count: threadCounts[fax.threadId] }),
              fax.hasEvents && React.createElement("span", {
                style: {
                  fontSize: 10,
                  color: theme.accent.green,
                  border: "1px solid " + theme.accent.green,
                  borderRadius: 3,
                  padding: "0px 4px",
                },
              }, "SESSION")
            ),
            React.createElement("div", {
              style: {
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11,
                color: theme.text.dim,
              },
            },
              React.createElement("span", null, fax.sender.alias || fax.sender.email),
              fax.git && fax.git.branch && React.createElement("span", {
                style: { color: theme.text.dim },
              }, "\u2192 " + fax.git.branch),
              React.createElement(ProgressSummary, { progress: fax.progress })
            )
          ),
          // Date
          React.createElement("span", {
            style: { fontSize: 11, color: theme.text.dim, flexShrink: 0, whiteSpace: "nowrap" },
          }, formatDate(fax.createdUtc)),
          // Pick Up button
          React.createElement("button", {
            className: "av-btn",
            onClick: function (e) {
              e.stopPropagation();
              setPickupFax(fax);
            },
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
              flexShrink: 0,
            },
          }, "Pick Up")
        );
      })
    ),
    pickupFax && React.createElement(PickUpModal, {
      isOpen: true,
      onClose: function () { setPickupFax(null); },
      faxId: pickupFax.id,
      faxLabel: pickupFax.label,
      senderAlias: pickupFax.sender && pickupFax.sender.alias ? pickupFax.sender.alias : "Unknown",
    })
  );
}
