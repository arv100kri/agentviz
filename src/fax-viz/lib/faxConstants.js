/** Fax-Viz constants and defaults. */

export var FAX_VIZ_PORT = 4243;

export var IMPORTANCE_COLORS = {
  urgent: "#ff6b6b",
  high: "#ffa94d",
  normal: "#868e96",
};

export var IMPORTANCE_LABELS = {
  urgent: "URGENT",
  high: "HIGH",
  normal: "NORMAL",
};

export var IMPORTANCE_ORDER = { urgent: 0, high: 1, normal: 2 };

export var SORT_OPTIONS = {
  DATE_DESC: "date-desc",
  DATE_ASC: "date-asc",
  IMPORTANCE: "importance",
  SENDER: "sender",
};

export var DEFAULT_SORT = SORT_OPTIONS.DATE_DESC;

// Markdown files in fax bundles (order matters for display)
export var FAX_MARKDOWN_FILES = [
  "handoff.md",
  "analysis.md",
  "decisions.md",
  "collab.md",
];

// Non-markdown text files
export var FAX_TEXT_FILES = [
  "bootstrap-prompt.txt",
];
