import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  buildQASessionConfig,
  describeQAToolStatus,
  getCompleteJsonlLines,
  getQAEventText,
  getJsonlStreamChunk,
  getSessionQAHistoryEntry,
  getSessionQAHistoryFilePath,
  readSessionQAHistoryStore,
  removeSessionQAHistoryEntry,
  saveSessionQAHistoryEntry,
} from "../../server.js";

describe("server live JSONL helpers", function () {
  it("ignores a trailing partial Claude record until it is newline-terminated", function () {
    var firstChunk = getJsonlStreamChunk(
      '{"type":"user","message":{"content":"hello"}}\n'
      + '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}}',
      0
    );

    expect(firstChunk.lines).toEqual([
      '{"type":"user","message":{"content":"hello"}}',
    ]);
    expect(firstChunk.nextLineIdx).toBe(1);

    var secondChunk = getJsonlStreamChunk(
      '{"type":"user","message":{"content":"hello"}}\n'
      + '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}\n',
      firstChunk.nextLineIdx
    );

    expect(secondChunk.lines).toEqual([
      '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}',
    ]);
    expect(secondChunk.nextLineIdx).toBe(2);
  });

  it("counts only complete newline-terminated records during initialization", function () {
    var lines = getCompleteJsonlLines(
      '{"type":"user","message":{"content":"hello"}}\n'
      + '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}}'
    );

    expect(lines).toEqual([
      '{"type":"user","message":{"content":"hello"}}',
    ]);
  });
});

describe("Q&A session config", function () {
  it("always replaces the system message for resumed and new sessions", function () {
    var approve = vi.fn();
    var config = buildQASessionConfig("system prompt", approve);

    expect(config).toEqual({
      onPermissionRequest: approve,
      streaming: true,
      systemMessage: {
        mode: "replace",
        content: "system prompt",
      },
    });
  });
});

describe("Q&A streaming helpers", function () {
  it("extracts delta text from SDK streaming events", function () {
    expect(getQAEventText({ deltaContent: "hello" }, true)).toBe("hello");
  });

  it("extracts final text from array-based content payloads", function () {
    expect(getQAEventText({ content: [{ text: "hello" }, { text: " world" }] }, false)).toBe("hello world");
  });

  it("formats friendly tool progress labels", function () {
    expect(describeQAToolStatus("view", "start")).toBe("Searching the session...");
    expect(describeQAToolStatus("powershell", "complete")).toBe("Analyzing command output...");
  });
});

describe("Q&A history persistence", function () {
  it("persists and removes session history entries on disk", function () {
    var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentviz-qa-history-"));
    var historyFile = getSessionQAHistoryFilePath(tempDir);

    expect(readSessionQAHistoryStore(historyFile).sessions).toEqual({});

    var saved = saveSessionQAHistoryEntry(historyFile, "session-key", {
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world", references: [{ turnIndex: 0 }] },
      ],
      qaSessionId: "sdk-session-1",
      responseModel: "gpt-5.4",
    });

    expect(saved.qaSessionId).toBe("sdk-session-1");
    expect(getSessionQAHistoryEntry(historyFile, "session-key").messages.length).toBe(2);

    expect(removeSessionQAHistoryEntry(historyFile, "session-key")).toBe(true);
    expect(getSessionQAHistoryEntry(historyFile, "session-key")).toBeNull();

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
