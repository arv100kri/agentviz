import { describe, it, expect } from "vitest";
import {
  eventMatchesQuery,
  filterEventEntries,
  clampTime,
  findJumpTarget,
  nextSpeed,
  toggleFilter,
  focusSearchInput,
} from "../lib/playbackUtils.js";

// ── Helpers ──

function makeEntry(index, overrides) {
  return {
    index: index,
    event: Object.assign({ text: "", agent: "assistant", track: "output" }, overrides),
  };
}

// ── clampTime ──

describe("clampTime", function () {
  it("returns time when within bounds", function () {
    expect(clampTime(5, 10)).toBe(5);
  });

  it("clamps to 0 when time is negative", function () {
    expect(clampTime(-3, 10)).toBe(0);
  });

  it("clamps to total when time exceeds total", function () {
    expect(clampTime(15, 10)).toBe(10);
  });

  it("returns 0 when total is 0", function () {
    expect(clampTime(5, 0)).toBe(0);
  });

  it("returns exact boundary values", function () {
    expect(clampTime(0, 10)).toBe(0);
    expect(clampTime(10, 10)).toBe(10);
  });
});

// ── eventMatchesQuery ──

describe("eventMatchesQuery", function () {
  it("matches on event text (case-insensitive)", function () {
    var entry = makeEntry(0, { text: "Hello World" });
    expect(eventMatchesQuery(entry, "hello")).toBe(true);
    expect(eventMatchesQuery(entry, "WORLD")).toBe(false); // lowerQuery must be lowercased by caller
    expect(eventMatchesQuery(entry, "world")).toBe(true);
  });

  it("matches on toolName", function () {
    var entry = makeEntry(0, { text: "", toolName: "Bash" });
    expect(eventMatchesQuery(entry, "bash")).toBe(true);
    expect(eventMatchesQuery(entry, "read")).toBe(false);
  });

  it("matches on agent", function () {
    var entry = makeEntry(0, { agent: "user", text: "" });
    expect(eventMatchesQuery(entry, "user")).toBe(true);
    expect(eventMatchesQuery(entry, "assistant")).toBe(false);
  });

  it("returns false when no fields match", function () {
    var entry = makeEntry(0, { text: "foo", toolName: "bar", agent: "assistant" });
    expect(eventMatchesQuery(entry, "xyz")).toBe(false);
  });

  it("handles missing optional fields gracefully", function () {
    var entry = makeEntry(0, { text: "some text" });
    // toolName is undefined
    expect(eventMatchesQuery(entry, "some")).toBe(true);
    expect(eventMatchesQuery(entry, "bash")).toBe(false);
  });

  it("handles empty text fields", function () {
    var entry = makeEntry(0, { text: "", agent: "assistant" });
    expect(eventMatchesQuery(entry, "assistant")).toBe(true);
    expect(eventMatchesQuery(entry, "")).toBe(true); // empty string always included
  });
});

// ── filterEventEntries ──

describe("filterEventEntries", function () {
  var entries = [
    makeEntry(0, { text: "Thinking about the problem", agent: "assistant" }),
    makeEntry(1, { text: "Running tests", toolName: "Bash", agent: "assistant" }),
    makeEntry(2, { text: "Hello from user", agent: "user" }),
    makeEntry(3, { text: "Reading file", toolName: "Read", agent: "assistant" }),
  ];

  it("returns empty array when query is empty", function () {
    expect(filterEventEntries(entries, "")).toEqual([]);
  });

  it("returns empty array when query is null/undefined", function () {
    expect(filterEventEntries(entries, null)).toEqual([]);
    expect(filterEventEntries(entries, undefined)).toEqual([]);
  });

  it("returns empty array when entries is null", function () {
    expect(filterEventEntries(null, "bash")).toEqual([]);
  });

  it("returns matching entries by text", function () {
    var results = filterEventEntries(entries, "thinking");
    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(0);
  });

  it("returns matching entries by toolName", function () {
    var results = filterEventEntries(entries, "bash");
    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(1);
  });

  it("returns matching entries by agent", function () {
    var results = filterEventEntries(entries, "user");
    expect(results).toHaveLength(1);
    expect(results[0].index).toBe(2);
  });

  it("returns multiple matches", function () {
    var results = filterEventEntries(entries, "assistant");
    expect(results).toHaveLength(3);
  });

  it("is case-insensitive", function () {
    var results = filterEventEntries(entries, "READ");
    expect(results).toHaveLength(1); // entry 3: "Reading file" text + "Read" toolName (same entry)
    expect(results[0].index).toBe(3);
  });

  it("returns empty array when nothing matches", function () {
    var results = filterEventEntries(entries, "zzznomatch");
    expect(results).toEqual([]);
  });

  it("preserves original entry references", function () {
    var results = filterEventEntries(entries, "bash");
    expect(results[0]).toBe(entries[1]);
  });
});

// ── findJumpTarget ──

describe("findJumpTarget", function () {
  var entries = [
    { event: { t: 1 } },
    { event: { t: 5 } },
    { event: { t: 10 } },
    { event: { t: 15 } },
  ];

  it("returns null for empty entries", function () {
    expect(findJumpTarget([], 5, "next")).toBe(null);
    expect(findJumpTarget(null, 5, "next")).toBe(null);
  });

  it("finds next entry after current time", function () {
    expect(findJumpTarget(entries, 3, "next")).toBe(5);
    expect(findJumpTarget(entries, 0, "next")).toBe(1);
  });

  it("wraps to first entry when at the end", function () {
    expect(findJumpTarget(entries, 15, "next")).toBe(1);
  });

  it("finds previous entry before current time", function () {
    expect(findJumpTarget(entries, 10, "prev")).toBe(5);
    expect(findJumpTarget(entries, 15, "prev")).toBe(10);
  });

  it("wraps to last entry when at the start", function () {
    expect(findJumpTarget(entries, 1, "prev")).toBe(15);
  });

  it("skips entries within 0.1s threshold", function () {
    expect(findJumpTarget(entries, 4.95, "next")).toBe(10);
    expect(findJumpTarget(entries, 5.05, "prev")).toBe(1);
  });
});

// ── nextSpeed ──

describe("nextSpeed", function () {
  var speeds = [0.5, 1, 2, 4, 8];

  it("returns next speed in list", function () {
    expect(nextSpeed(speeds, 1)).toBe(2);
    expect(nextSpeed(speeds, 4)).toBe(8);
  });

  it("wraps to first speed at end", function () {
    expect(nextSpeed(speeds, 8)).toBe(0.5);
  });

  it("returns first speed for unknown value", function () {
    expect(nextSpeed(speeds, 99)).toBe(0.5);
  });
});

// ── toggleFilter ──

describe("toggleFilter", function () {
  it("adds a key when not present", function () {
    expect(toggleFilter({}, "tool_call")).toEqual({ tool_call: true });
  });

  it("removes a key when present", function () {
    expect(toggleFilter({ tool_call: true }, "tool_call")).toEqual({});
  });

  it("does not mutate the original object", function () {
    var original = { reasoning: true };
    var result = toggleFilter(original, "output");
    expect(original).toEqual({ reasoning: true });
    expect(result).toEqual({ reasoning: true, output: true });
  });
});

// ── focusSearchInput ──

describe("focusSearchInput", function () {
  it("returns false for null ref", function () {
    expect(focusSearchInput(null)).toBe(false);
  });

  it("returns false when ref.current is null", function () {
    expect(focusSearchInput({ current: null })).toBe(false);
  });

  it("returns false when element is not visible (offsetParent null)", function () {
    expect(focusSearchInput({ current: { offsetParent: null, focus: function () {} } })).toBe(false);
  });

  it("focuses and returns true when element is visible", function () {
    var focused = false;
    var ref = { current: { offsetParent: {}, focus: function () { focused = true; } } };
    expect(focusSearchInput(ref)).toBe(true);
    expect(focused).toBe(true);
  });
});
