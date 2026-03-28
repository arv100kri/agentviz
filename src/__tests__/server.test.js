import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import {
  buildQAProgressPayload,
  createSessionQACacheStore,
  buildQADonePayload,
  buildQASessionConfig,
  buildSessionQAPrecomputeEntry,
  buildSessionQAPrecomputeFingerprint,
  describeQAToolStatus,
  ensureSessionQAPrecomputed,
  getCompleteJsonlLines,
  getSessionQACacheEntry,
  getSessionQAPrecomputeCacheDir,
  getSessionQASidecarFilePath,
  getQAEventText,
  getJsonlStreamChunk,
  getSessionQAHistoryEntry,
  getSessionQAHistoryFilePath,
  readSessionQAHistoryStore,
  removeSessionQAHistoryEntry,
  resolveSessionQAArtifacts,
  saveSessionQACacheEntry,
  saveSessionQAHistoryEntry,
  writeSessionQAPrecompute,
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

  it("builds rich progress payloads with phase metadata and timing", function () {
    expect(buildQAProgressPayload("waiting-for-model", {
      detail: "Prompt sent. Waiting for the first model response.",
      elapsedMs: 1875,
    })).toEqual({
      status: "Waiting for model response...",
      phase: "waiting-for-model",
      detail: "Prompt sent. Waiting for the first model response.",
      elapsedMs: 1875,
    });
  });

  it("adds tool details to tool progress payloads", function () {
    expect(buildQAProgressPayload("tool-running", {
      toolName: "view",
      elapsedMs: 2400,
    })).toEqual({
      status: "Searching the session...",
      phase: "tool-running",
      detail: "Tool: view",
      elapsedMs: 2400,
    });
  });

  it("includes timing metadata in the done payload", function () {
    expect(buildQADonePayload(
      "hello",
      [{ turnIndex: 0 }],
      "gpt-5.4",
      "sdk-session-1",
      1000,
      9250
    )).toEqual({
      done: true,
      answer: "hello",
      references: [{ turnIndex: 0 }],
      model: "gpt-5.4",
      qaSessionId: "sdk-session-1",
      timing: { totalMs: 8250 },
    });
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
        { role: "assistant", content: "world", references: [{ turnIndex: 0 }], timing: { totalMs: 8200 } },
      ],
      qaSessionId: "sdk-session-1",
      responseModel: "gpt-5.4",
    });

    expect(saved.qaSessionId).toBe("sdk-session-1");
    expect(getSessionQAHistoryEntry(historyFile, "session-key").messages.length).toBe(2);
    expect(getSessionQAHistoryEntry(historyFile, "session-key").messages[1].timing).toEqual({ totalMs: 8200 });

    expect(removeSessionQAHistoryEntry(historyFile, "session-key")).toBe(true);
    expect(getSessionQAHistoryEntry(historyFile, "session-key")).toBeNull();

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

describe("Q&A session cache", function () {
  it("registers session artifacts by stable sessionKey", function () {
    var cache = createSessionQACacheStore();
    var saved = saveSessionQACacheEntry(cache, "session-key", {
      events: [{ t: 1, agent: "assistant", track: "output", text: "hello" }],
      turns: [{ index: 0, eventIndices: [0], startTime: 0, endTime: 1 }],
      metadata: { totalEvents: 1, totalTurns: 1, duration: 1 },
      sessionFilePath: "C:\\sessions\\agentviz.jsonl",
    });

    expect(saved.sessionFilePath).toBe("C:\\sessions\\agentviz.jsonl");
    expect(getSessionQACacheEntry(cache, "session-key")).toMatchObject({
      metadata: { totalEvents: 1, totalTurns: 1, duration: 1 },
      sessionFilePath: "C:\\sessions\\agentviz.jsonl",
    });
    expect(getSessionQACacheEntry(cache, "session-key").events).toHaveLength(1);
    expect(getSessionQACacheEntry(cache, "session-key").turns).toHaveLength(1);
  });

  it("resolves lean qa payloads from cached session artifacts", function () {
    var cache = createSessionQACacheStore();
    saveSessionQACacheEntry(cache, "session-key", {
      events: [{ t: 1, agent: "assistant", track: "output", text: "hello" }],
      turns: [{ index: 0, eventIndices: [0], startTime: 0, endTime: 1 }],
      metadata: { totalEvents: 1, totalTurns: 1, duration: 1 },
      sessionFilePath: "C:\\sessions\\agentviz.jsonl",
    });

    var resolved = resolveSessionQAArtifacts(cache, {
      sessionKey: "session-key",
      question: "What happened?",
    });

    expect(resolved).toMatchObject({
      sessionKey: "session-key",
      source: "cache",
      metadata: { totalEvents: 1, totalTurns: 1, duration: 1 },
      sessionFilePath: "C:\\sessions\\agentviz.jsonl",
    });
    expect(resolved.events[0].text).toBe("hello");
    expect(resolved.turns[0].index).toBe(0);
  });

  it("seeds the cache from inline artifacts when a sessionKey is supplied", function () {
    var cache = createSessionQACacheStore();
    var resolved = resolveSessionQAArtifacts(cache, {
      sessionKey: "session-key",
      events: [{ t: 1, agent: "assistant", track: "output", text: "hello" }],
      turns: [{ index: 0, eventIndices: [0], startTime: 0, endTime: 1 }],
      metadata: { totalEvents: 1, totalTurns: 1, duration: 1 },
      sessionFilePath: "C:\\sessions\\agentviz.jsonl",
    });

    expect(resolved.source).toBe("inline");
    expect(getSessionQACacheEntry(cache, "session-key")).toMatchObject({
      metadata: { totalEvents: 1, totalTurns: 1, duration: 1 },
      sessionFilePath: "C:\\sessions\\agentviz.jsonl",
    });
  });
});

describe("Q&A precompute persistence", function () {
  it("builds sidecar and managed precompute paths", function () {
    expect(getSessionQASidecarFilePath("C:\\sessions\\events.jsonl")).toBe("C:\\sessions\\events.agentviz-qa.json");
    expect(getSessionQAPrecomputeCacheDir("C:\\tmp\\agentviz-home")).toBe(path.join("C:\\tmp\\agentviz-home", ".agentviz", "session-qa-cache"));
  });

  it("changes the precompute fingerprint when the raw session content changes", function () {
    var base = buildSessionQAPrecomputeFingerprint({
      events: [{ t: 1, agent: "assistant", track: "output", text: "hello" }],
      turns: [{ index: 0, eventIndices: [0], startTime: 0, endTime: 1 }],
      metadata: { totalEvents: 1, totalTurns: 1, duration: 1 },
      rawText: "{\"type\":\"assistant\"}\n",
    });
    var changed = buildSessionQAPrecomputeFingerprint({
      events: [{ t: 1, agent: "assistant", track: "output", text: "hello" }],
      turns: [{ index: 0, eventIndices: [0], startTime: 0, endTime: 1 }],
      metadata: { totalEvents: 1, totalTurns: 1, duration: 1 },
      rawText: "{\"type\":\"assistant\",\"extra\":true}\n",
    });

    expect(changed).not.toBe(base);
  });

  it("writes and reuses a persisted sidecar artifact when a session path is available", function () {
    var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentviz-qa-precompute-"));
    var sessionDir = path.join(tempDir, "sessions");
    var sessionFile = path.join(sessionDir, "events.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(sessionFile, "{\"type\":\"assistant\",\"message\":{\"content\":\"hello\"}}\n", "utf8");

    var entry = {
      events: [{ t: 1, agent: "assistant", track: "output", text: "hello" }],
      turns: [{ index: 0, eventIndices: [0], startTime: 0, endTime: 1, userMessage: "hello" }],
      metadata: { totalEvents: 1, totalTurns: 1, totalToolCalls: 0, duration: 1, format: "copilot-cli" },
      sessionFilePath: sessionFile,
    };

    var first = buildSessionQAPrecomputeEntry(entry, { homeDir: tempDir });
    var second = buildSessionQAPrecomputeEntry(entry, { homeDir: tempDir });

    expect(first.storage).toBe("sidecar");
    expect(first.reused).toBe(false);
    expect(fs.existsSync(getSessionQASidecarFilePath(sessionFile))).toBe(true);
    expect(second.reused).toBe(true);
    expect(second.fingerprint).toBe(first.fingerprint);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reuses in-memory precompute artifacts when the fingerprint is unchanged", function () {
    var tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentviz-qa-cache-"));
    var cache = createSessionQACacheStore();
    var saved = saveSessionQACacheEntry(cache, "session-key", {
      events: [{ t: 1, agent: "assistant", track: "output", text: "hello" }],
      turns: [{ index: 0, eventIndices: [0], startTime: 0, endTime: 1, userMessage: "hello" }],
      metadata: { totalEvents: 1, totalTurns: 1, totalToolCalls: 0, duration: 1, format: "copilot-cli" },
      rawText: "{\"type\":\"assistant\",\"message\":{\"content\":\"hello\"}}\n",
    });

    var first = ensureSessionQAPrecomputed(saved, { homeDir: tempDir });
    var second = ensureSessionQAPrecomputed(saved, { homeDir: tempDir });

    expect(first).toBe(second);
    expect(first.artifacts.metricCatalog.totalTurns).toBe(1);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
