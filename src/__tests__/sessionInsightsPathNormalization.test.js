import { describe, expect, it } from "vitest";
import { buildFileAccessSummary } from "../lib/sessionInsights.js";

describe("sessionInsights path normalization", function () {
  it("merges basename-only shutdown summaries into matching tool paths", function () {
    var files = buildFileAccessSummary([
      {
        track: "tool_call",
        toolName: "view",
        toolInput: { path: "/repo/src/utils.js" },
        turnIndex: 0,
        isError: false,
      },
      {
        track: "tool_call",
        toolName: "edit",
        toolInput: { path: "/repo/src/utils.js", old_str: "a", new_str: "b" },
        turnIndex: 0,
        isError: false,
      },
    ], {
      codeChanges: {
        filesModified: ["utils.js"],
      },
    });

    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("/repo/src/utils.js");
    expect(files[0].summaryTouches).toBe(1);
    expect(files[0].edits).toBe(1);
    expect(files[0].views).toBe(1);
  });
});
