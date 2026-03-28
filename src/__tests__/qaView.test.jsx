// @vitest-environment jsdom

import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import App from "../App.jsx";
import { parseSessionText } from "../lib/sessionParsing";
import { persistSessionSnapshot } from "../lib/sessionLibrary.js";

var FIXTURE_TEXT = readFileSync(resolve(process.cwd(), "test-files/test-copilot.jsonl"), "utf8");

function click(node) {
  if (!node) throw new Error("Expected node to click");
  return act(async function () {
    node.click();
  });
}

function changeInput(node, value) {
  if (!node) throw new Error("Expected input node");
  return act(async function () {
    var prototype = Object.getPrototypeOf(node);
    var descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    descriptor.set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function sleep(ms) {
  await act(async function () {
    await new Promise(function (resolve) { setTimeout(resolve, ms); });
  });
}

async function waitFor(check, message, timeout) {
  var start = Date.now();
  var limit = timeout || 3000;
  while (Date.now() - start < limit) {
    var result = check();
    if (result) return result;
    await sleep(20);
  }
  throw new Error(message || "Timed out waiting for condition");
}

function findByText(container, text) {
  return Array.from(container.querySelectorAll("*"))
    .find(function (node) {
      return node.textContent && node.textContent.includes(text);
    }) || null;
}

function findExactButton(container, text) {
  return Array.from(container.querySelectorAll("button"))
    .find(function (node) {
      return node.textContent && node.textContent.trim() === text;
    }) || null;
}

function findClickableText(container, text) {
  return Array.from(container.querySelectorAll("button, span"))
    .find(function (node) {
      return node.textContent && node.textContent.trim() === text;
    }) || null;
}

function createInactiveFetch() {
  return vi.fn(async function () {
    return { ok: false };
  });
}

async function renderApp(fetchImpl) {
  global.fetch = fetchImpl || createInactiveFetch();
  var container = document.createElement("div");
  document.body.appendChild(container);
  var root = createRoot(container);

  await act(async function () {
    root.render(<App />);
  });

  return {
    container: container,
    unmount: async function () {
      await act(async function () {
        root.unmount();
      });
      container.remove();
    },
  };
}

beforeEach(function () {
  var storage = {};
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  global.localStorage = {
    getItem: function (key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
    setItem: function (key, value) { storage[key] = String(value); },
    removeItem: function (key) { delete storage[key]; },
    clear: function () { storage = {}; },
  };
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  global.EventSource = class {
    close() {}
  };
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(function () { return Promise.resolve(); }),
    },
  });
  document.body.innerHTML = "";
});

afterEach(function () {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("Q&A view integration", function () {
  it("renders the Q&A empty state with suggested questions when tab is clicked", async function () {
    var parsed = parseSessionText(FIXTURE_TEXT);
    persistSessionSnapshot("fixture.jsonl", parsed.result, FIXTURE_TEXT, global.localStorage);

    var app = await renderApp();

    await waitFor(function () {
      return findByText(app.container, "Inbox");
    }, "expected landing inbox to render");

    await click(findExactButton(app.container, "Open in Observe"));
    await waitFor(function () {
      return findByText(app.container, "fixture.jsonl");
    }, "expected stored session to open");

    // Navigate to Q&A tab
    await click(findClickableText(app.container, "Q&A"));
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected Q&A empty state to render");

    // Verify suggested questions are rendered
    expect(findByText(app.container, "What tools were used most frequently?")).toBeTruthy();
    expect(findByText(app.container, "What errors occurred and how were they resolved?")).toBeTruthy();

    // Verify input is present
    var input = app.container.querySelector("input[placeholder*='Ask a question']");
    expect(input).toBeTruthy();

    // Verify model selector is present in the header
    var modelSelect = app.container.querySelector("select[title='Choose model']");
    expect(modelSelect).toBeTruthy();
    expect(modelSelect.value).toBe("gpt-5.4"); // default model

    // Verify send button
    expect(findExactButton(app.container, "Send")).toBeTruthy();

    // Verify model status bar (no response yet)
    expect(findByText(app.container, "Powered by Copilot SDK")).toBeTruthy();

    await app.unmount();
  });

  it("shows a user message in the chat when a question is submitted", async function () {
    // Mock fetch to return a Q&A answer and capture the request body
    var qaFetchCalled = false;
    var capturedBody = null;
    var fetchMock = vi.fn(async function (url, opts) {
      if (String(url).includes("/api/qa")) {
        qaFetchCalled = true;
        if (opts && opts.body) capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async function () {
            return {
              answer: "The session used the view tool in [Turn 0].",
              references: [{ turnIndex: 0 }],
              model: "gpt-5.4",
            };
          },
        };
      }
      return { ok: false };
    });

    var parsed = parseSessionText(FIXTURE_TEXT);
    persistSessionSnapshot("fixture.jsonl", parsed.result, FIXTURE_TEXT, global.localStorage);

    var app = await renderApp(fetchMock);

    await waitFor(function () {
      return findByText(app.container, "Inbox");
    }, "expected landing inbox to render");

    await click(findExactButton(app.container, "Open in Observe"));
    await waitFor(function () {
      return findByText(app.container, "fixture.jsonl");
    }, "expected stored session to open");

    await click(findClickableText(app.container, "Q&A"));
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected Q&A view to render");

    // Type a question into the input
    var input = app.container.querySelector("input[placeholder*='Ask a question']");
    await changeInput(input, "What tools were used?");

    // Submit the form
    await click(findExactButton(app.container, "Send"));

    // The user message should appear
    await waitFor(function () {
      return findByText(app.container, "What tools were used?");
    }, "expected user message to appear in chat");

    // The assistant response should appear
    await waitFor(function () {
      return findByText(app.container, "The session used the view tool");
    }, "expected assistant response to appear in chat", 5000);

    // Verify the fetch was called with /api/qa
    expect(qaFetchCalled).toBe(true);

    // Verify the [Turn 0] reference is rendered as a clickable link
    var turnRef = app.container.querySelector("span[title='Jump to Turn 0']");
    expect(turnRef).toBeTruthy();
    expect(turnRef.textContent).toBe("[Turn 0]");

    // Verify the model label is displayed
    expect(findByText(app.container, "Powered by GPT-5.4")).toBeTruthy();

    // Verify the request included the selected model
    expect(capturedBody).toBeTruthy();
    expect(capturedBody.model).toBe("gpt-5.4");

    // Verify clicking a turn reference navigates to replay view
    await click(turnRef);
    await waitFor(function () {
      // After clicking a turn ref, the view should switch to replay
      return findByText(app.container, "Replay");
    }, "expected view to switch to replay after turn click");

    await app.unmount();
  });

  it("shows an error when the server returns a failure", async function () {
    var fetchMock = vi.fn(async function (url) {
      if (String(url).includes("/api/qa")) {
        return { ok: false, status: 500 };
      }
      return { ok: false };
    });

    var parsed = parseSessionText(FIXTURE_TEXT);
    persistSessionSnapshot("fixture.jsonl", parsed.result, FIXTURE_TEXT, global.localStorage);

    var app = await renderApp(fetchMock);

    await waitFor(function () {
      return findByText(app.container, "Inbox");
    }, "expected landing inbox to render");

    await click(findExactButton(app.container, "Open in Observe"));
    await waitFor(function () {
      return findByText(app.container, "fixture.jsonl");
    }, "expected stored session to open");

    await click(findClickableText(app.container, "Q&A"));
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected Q&A view to render");

    // Submit via a suggested question button
    await click(findExactButton(app.container, "What tools were used most frequently?"));

    // Should show the user message
    await waitFor(function () {
      return findByText(app.container, "What tools were used most frequently?");
    }, "expected user message to appear");

    // Should show an error message
    await waitFor(function () {
      return findByText(app.container, "Server error: 500");
    }, "expected error message to appear", 5000);

    await app.unmount();
  });

  it("clears the conversation when the Clear button is clicked", async function () {
    var fetchMock = vi.fn(async function (url) {
      if (String(url).includes("/api/qa")) {
        return {
          ok: true,
          json: async function () {
            return { answer: "Here is your answer.", references: [] };
          },
        };
      }
      return { ok: false };
    });

    var parsed = parseSessionText(FIXTURE_TEXT);
    persistSessionSnapshot("fixture.jsonl", parsed.result, FIXTURE_TEXT, global.localStorage);

    var app = await renderApp(fetchMock);

    await waitFor(function () {
      return findByText(app.container, "Inbox");
    }, "expected landing inbox to render");

    await click(findExactButton(app.container, "Open in Observe"));
    await waitFor(function () {
      return findByText(app.container, "fixture.jsonl");
    }, "expected session to open");

    await click(findClickableText(app.container, "Q&A"));
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected Q&A view to render");

    // Ask a question
    var input = app.container.querySelector("input[placeholder*='Ask a question']");
    await changeInput(input, "Hello?");
    await click(findExactButton(app.container, "Send"));

    // Wait for response
    await waitFor(function () {
      return findByText(app.container, "Here is your answer.");
    }, "expected response to appear", 5000);

    // Session Q&A header with Clear button should now be visible
    expect(findByText(app.container, "Session Q&A")).toBeTruthy();
    var clearBtn = app.container.querySelector("button[title='Clear conversation']");
    expect(clearBtn).toBeTruthy();

    // Click Clear
    await click(clearBtn);

    // Should return to the empty state with suggested questions
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected empty state to return after clearing");

    // The old messages should be gone
    expect(findByText(app.container, "Hello?")).toBeFalsy();
    expect(findByText(app.container, "Here is your answer.")).toBeFalsy();

    await app.unmount();
  });

  it("does not crash when rendering any theme styles", async function () {
    // This test specifically catches the theme.spacing vs theme.space bug
    var parsed = parseSessionText(FIXTURE_TEXT);
    persistSessionSnapshot("fixture.jsonl", parsed.result, FIXTURE_TEXT, global.localStorage);

    var app = await renderApp();

    await waitFor(function () {
      return findByText(app.container, "Inbox");
    }, "expected inbox to render");

    await click(findExactButton(app.container, "Open in Observe"));
    await waitFor(function () {
      return findByText(app.container, "fixture.jsonl");
    }, "expected session to open");

    // Switch to Q&A - this should NOT throw
    await click(findClickableText(app.container, "Q&A"));

    // If we get here without a crash, the theme tokens are valid
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected Q&A to render without crashing");

    // Verify inline styles are applied (not undefined/NaN)
    var input = app.container.querySelector("input[placeholder*='Ask a question']");
    expect(input).toBeTruthy();
    expect(input.style.fontSize).not.toBe("");
    expect(input.style.borderRadius).not.toBe("");

    await app.unmount();
  });

  it("persists the model choice across tab switches", async function () {
    var parsed = parseSessionText(FIXTURE_TEXT);
    persistSessionSnapshot("fixture.jsonl", parsed.result, FIXTURE_TEXT, global.localStorage);

    var app = await renderApp();

    await waitFor(function () {
      return findByText(app.container, "Inbox");
    }, "expected inbox to render");

    await click(findExactButton(app.container, "Open in Observe"));
    await waitFor(function () {
      return findByText(app.container, "fixture.jsonl");
    }, "expected session to open");

    // Go to Q&A
    await click(findClickableText(app.container, "Q&A"));
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected Q&A to render");

    // Change model to claude-sonnet-4
    var modelSelect = app.container.querySelector("select[title='Choose model']");
    expect(modelSelect).toBeTruthy();
    await act(async function () {
      var descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(modelSelect), "value");
      descriptor.set.call(modelSelect, "claude-sonnet-4");
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(modelSelect.value).toBe("claude-sonnet-4");

    // Switch to Stats tab
    await click(findClickableText(app.container, "Stats"));
    await waitFor(function () {
      return findByText(app.container, "Session Overview");
    }, "expected stats view to render");

    // Switch back to Q&A
    await click(findClickableText(app.container, "Q&A"));
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected Q&A to render again");

    // Model should still be claude-sonnet-4
    var modelSelectAfter = app.container.querySelector("select[title='Choose model']");
    expect(modelSelectAfter.value).toBe("claude-sonnet-4");

    await app.unmount();
  });

  it("shows a fresh Q&A when switching to a new session", async function () {
    var callCount = 0;
    var fetchMock = vi.fn(async function (url) {
      if (String(url).includes("/api/qa")) {
        callCount++;
        return {
          ok: true,
          json: async function () {
            return { answer: "Answer " + callCount + ".", references: [] };
          },
        };
      }
      return { ok: false };
    });

    var parsed = parseSessionText(FIXTURE_TEXT);
    persistSessionSnapshot("session-a.jsonl", parsed.result, FIXTURE_TEXT, global.localStorage);
    persistSessionSnapshot("session-b.jsonl", parsed.result, FIXTURE_TEXT, global.localStorage);

    var app = await renderApp(fetchMock);

    await waitFor(function () {
      return findByText(app.container, "Inbox");
    }, "expected inbox to render");

    // Open first session
    var openButtons = Array.from(app.container.querySelectorAll("button"))
      .filter(function (b) { return b.textContent.trim() === "Open in Observe"; });
    await click(openButtons[0]);
    await waitFor(function () {
      return findClickableText(app.container, "Replay");
    }, "expected session to open");

    // Go to Q&A and ask a question
    await click(findClickableText(app.container, "Q&A"));
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected Q&A to render");

    var input = app.container.querySelector("input[placeholder*='Ask a question']");
    await changeInput(input, "Question for session A");
    await click(findExactButton(app.container, "Send"));

    await waitFor(function () {
      return findByText(app.container, "Answer 1.");
    }, "expected response", 5000);

    // Go back to inbox
    var resetBtn = app.container.querySelector("button[title='Back to Inbox']");
    if (!resetBtn) { await app.unmount(); return; }
    await click(resetBtn);
    await waitFor(function () {
      return findByText(app.container, "Inbox");
    }, "expected inbox after reset");

    // Open the other session
    var openBtns2 = Array.from(app.container.querySelectorAll("button"))
      .filter(function (b) { return b.textContent.trim() === "Open in Observe"; });
    await click(openBtns2.length > 1 ? openBtns2[1] : openBtns2[0]);
    await waitFor(function () {
      return findClickableText(app.container, "Replay");
    }, "expected second session to open");

    // Q&A should show empty state (no conversation from session A)
    await click(findClickableText(app.container, "Q&A"));
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected fresh Q&A for new session");

    expect(findByText(app.container, "Question for session A")).toBeFalsy();
    expect(findByText(app.container, "Answer 1.")).toBeFalsy();

    await app.unmount();
  });

  it("restores Q&A conversation when returning to a previous session", async function () {
    var callCount = 0;
    var fetchMock = vi.fn(async function (url) {
      if (String(url).includes("/api/qa")) {
        callCount++;
        return {
          ok: true,
          json: async function () {
            return { answer: "Answer " + callCount + ".", references: [] };
          },
        };
      }
      return { ok: false };
    });

    var parsed = parseSessionText(FIXTURE_TEXT);
    persistSessionSnapshot("session-a.jsonl", parsed.result, FIXTURE_TEXT, global.localStorage);
    persistSessionSnapshot("session-b.jsonl", parsed.result, FIXTURE_TEXT, global.localStorage);

    var app = await renderApp(fetchMock);

    await waitFor(function () {
      return findByText(app.container, "Inbox");
    }, "expected inbox");

    // Open session A and ask a question
    var openButtons = Array.from(app.container.querySelectorAll("button"))
      .filter(function (b) { return b.textContent.trim() === "Open in Observe"; });
    await click(openButtons[0]);
    await waitFor(function () {
      return findClickableText(app.container, "Replay");
    }, "expected session A to open");

    await click(findClickableText(app.container, "Q&A"));
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected Q&A");

    var input = app.container.querySelector("input[placeholder*='Ask a question']");
    await changeInput(input, "Question for A");
    await click(findExactButton(app.container, "Send"));
    await waitFor(function () {
      return findByText(app.container, "Answer 1.");
    }, "expected answer for A", 5000);

    // Go to session B
    var resetBtn = app.container.querySelector("button[title='Back to Inbox']");
    if (!resetBtn) { await app.unmount(); return; }
    await click(resetBtn);
    await waitFor(function () {
      return findByText(app.container, "Inbox");
    }, "expected inbox");

    var openBtns2 = Array.from(app.container.querySelectorAll("button"))
      .filter(function (b) { return b.textContent.trim() === "Open in Observe"; });
    await click(openBtns2.length > 1 ? openBtns2[1] : openBtns2[0]);
    await waitFor(function () {
      return findClickableText(app.container, "Replay");
    }, "expected session B to open");

    // Ask a question in session B
    await click(findClickableText(app.container, "Q&A"));
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected fresh Q&A for B");

    input = app.container.querySelector("input[placeholder*='Ask a question']");
    await changeInput(input, "Question for B");
    await click(findExactButton(app.container, "Send"));
    await waitFor(function () {
      return findByText(app.container, "Answer 2.");
    }, "expected answer for B", 5000);

    // Go back to session A
    resetBtn = app.container.querySelector("button[title='Back to Inbox']");
    if (!resetBtn) { await app.unmount(); return; }
    await click(resetBtn);
    await waitFor(function () {
      return findByText(app.container, "Inbox");
    }, "expected inbox again");

    var openBtns3 = Array.from(app.container.querySelectorAll("button"))
      .filter(function (b) { return b.textContent.trim() === "Open in Observe"; });
    await click(openBtns3[0]);
    await waitFor(function () {
      return findClickableText(app.container, "Replay");
    }, "expected session A to reopen");

    await click(findClickableText(app.container, "Q&A"));

    // Session A's conversation should be restored
    await waitFor(function () {
      return findByText(app.container, "Question for A");
    }, "expected session A conversation to be restored");

    expect(findByText(app.container, "Answer 1.")).toBeTruthy();
    // Session B's messages should NOT be present
    expect(findByText(app.container, "Question for B")).toBeFalsy();
    expect(findByText(app.container, "Answer 2.")).toBeFalsy();

    await app.unmount();
  });

  it("clears per-session history when Clear is clicked", async function () {
    var fetchMock = vi.fn(async function (url) {
      if (String(url).includes("/api/qa")) {
        return {
          ok: true,
          json: async function () {
            return { answer: "Some answer.", references: [] };
          },
        };
      }
      return { ok: false };
    });

    var parsed = parseSessionText(FIXTURE_TEXT);
    persistSessionSnapshot("fixture.jsonl", parsed.result, FIXTURE_TEXT, global.localStorage);

    var app = await renderApp(fetchMock);

    await waitFor(function () {
      return findByText(app.container, "Inbox");
    }, "expected inbox");

    await click(findExactButton(app.container, "Open in Observe"));
    await waitFor(function () {
      return findByText(app.container, "fixture.jsonl");
    }, "expected session to open");

    await click(findClickableText(app.container, "Q&A"));
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected Q&A");

    // Ask and get a response
    var input = app.container.querySelector("input[placeholder*='Ask a question']");
    await changeInput(input, "My question");
    await click(findExactButton(app.container, "Send"));
    await waitFor(function () {
      return findByText(app.container, "Some answer.");
    }, "expected answer", 5000);

    // Clear the conversation
    var clearBtn = app.container.querySelector("button[title='Clear conversation']");
    await click(clearBtn);

    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected empty state after clear");

    // Switch away and back -- should still be empty (clear purges saved history)
    await click(findClickableText(app.container, "Stats"));
    await waitFor(function () {
      return findByText(app.container, "Session Overview");
    }, "expected stats");

    await click(findClickableText(app.container, "Q&A"));
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected empty Q&A after returning");

    expect(findByText(app.container, "My question")).toBeFalsy();
    expect(findByText(app.container, "Some answer.")).toBeFalsy();

    await app.unmount();
  });

  it("lists all available models in the dropdown", async function () {
    var parsed = parseSessionText(FIXTURE_TEXT);
    persistSessionSnapshot("fixture.jsonl", parsed.result, FIXTURE_TEXT, global.localStorage);

    var app = await renderApp();

    await waitFor(function () {
      return findByText(app.container, "Inbox");
    }, "expected inbox to render");

    await click(findExactButton(app.container, "Open in Observe"));
    await waitFor(function () {
      return findByText(app.container, "fixture.jsonl");
    }, "expected session to open");

    await click(findClickableText(app.container, "Q&A"));
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected Q&A to render");

    var modelSelect = app.container.querySelector("select[title='Choose model']");
    var options = Array.from(modelSelect.querySelectorAll("option"));

    // Verify key models are present
    var optionLabels = options.map(function (o) { return o.textContent; });
    expect(optionLabels).toContain("GPT-5.4");
    expect(optionLabels).toContain("GPT-5.2");
    expect(optionLabels).toContain("GPT-4.1");
    expect(optionLabels).toContain("Claude Sonnet 4.5");
    expect(optionLabels).toContain("Claude Sonnet 4");
    expect(optionLabels).toContain("Claude Opus 4.6");
    expect(optionLabels).toContain("Claude Haiku 4.5");

    // Should have a substantial number of models
    expect(options.length).toBeGreaterThanOrEqual(10);

    await app.unmount();
  });

  it("persists Q&A conversations to localStorage across app restarts", async function () {
    var fetchMock = vi.fn(async function (url) {
      if (String(url).includes("/api/qa")) {
        return {
          ok: true,
          json: async function () {
            return { answer: "Persisted answer.", references: [], model: "gpt-5.4", qaSessionId: "sdk-session-123" };
          },
        };
      }
      return { ok: false };
    });

    var parsed = parseSessionText(FIXTURE_TEXT);
    persistSessionSnapshot("persist-test.jsonl", parsed.result, FIXTURE_TEXT, global.localStorage);

    // First app instance: ask a question
    var app1 = await renderApp(fetchMock);

    await waitFor(function () {
      return findByText(app1.container, "Inbox");
    }, "expected inbox");

    await click(findExactButton(app1.container, "Open in Observe"));
    await waitFor(function () {
      return findClickableText(app1.container, "Replay");
    }, "expected session to open");

    await click(findClickableText(app1.container, "Q&A"));
    await waitFor(function () {
      return findByText(app1.container, "Ask about this session");
    }, "expected Q&A");

    var input = app1.container.querySelector("input[placeholder*='Ask a question']");
    await changeInput(input, "Question that should persist");
    await click(findExactButton(app1.container, "Send"));

    await waitFor(function () {
      return findByText(app1.container, "Persisted answer.");
    }, "expected answer", 5000);

    // Verify localStorage was written
    var stored = global.localStorage.getItem("agentviz:qa-history");
    expect(stored).toBeTruthy();
    var parsed2 = JSON.parse(stored);
    var keys = Object.keys(parsed2);
    expect(keys.length).toBeGreaterThanOrEqual(1);

    // Find the entry for our session
    var entry = parsed2[keys.find(function (k) { return parsed2[k].messages && parsed2[k].messages.length > 0; })];
    expect(entry).toBeTruthy();
    expect(entry.messages.length).toBe(2); // user + assistant
    expect(entry.qaSessionId).toBe("sdk-session-123");

    await app1.unmount();

    // Second app instance: should restore the conversation from localStorage
    var app2 = await renderApp(fetchMock);

    await waitFor(function () {
      return findByText(app2.container, "Inbox");
    }, "expected inbox on second mount");

    await click(findExactButton(app2.container, "Open in Observe"));
    await waitFor(function () {
      return findClickableText(app2.container, "Replay");
    }, "expected session to reopen");

    await click(findClickableText(app2.container, "Q&A"));

    // The old conversation should be restored from localStorage
    await waitFor(function () {
      return findByText(app2.container, "Question that should persist");
    }, "expected persisted user message to be restored");

    expect(findByText(app2.container, "Persisted answer.")).toBeTruthy();

    await app2.unmount();
  });

  it("sends qaSessionId on follow-up questions for session resumption", async function () {
    var callCount = 0;
    var capturedBodies = [];
    var fetchMock = vi.fn(async function (url, opts) {
      if (String(url).includes("/api/qa")) {
        callCount++;
        if (opts && opts.body) capturedBodies.push(JSON.parse(opts.body));
        return {
          ok: true,
          json: async function () {
            return {
              answer: "Answer " + callCount + ".",
              references: [],
              model: "gpt-5.4",
              qaSessionId: "sdk-sess-456",
            };
          },
        };
      }
      return { ok: false };
    });

    var parsed = parseSessionText(FIXTURE_TEXT);
    persistSessionSnapshot("followup-test.jsonl", parsed.result, FIXTURE_TEXT, global.localStorage);

    var app = await renderApp(fetchMock);

    await waitFor(function () {
      return findByText(app.container, "Inbox");
    }, "expected inbox");

    await click(findExactButton(app.container, "Open in Observe"));
    await waitFor(function () {
      return findClickableText(app.container, "Replay");
    }, "expected session");

    await click(findClickableText(app.container, "Q&A"));
    await waitFor(function () {
      return findByText(app.container, "Ask about this session");
    }, "expected Q&A");

    // First question - no qaSessionId yet
    var input = app.container.querySelector("input[placeholder*='Ask a question']");
    await changeInput(input, "First question");
    await click(findExactButton(app.container, "Send"));

    await waitFor(function () {
      return findByText(app.container, "Answer 1.");
    }, "expected first answer", 5000);

    expect(capturedBodies[0].qaSessionId).toBeFalsy();

    // Second question - should include qaSessionId from first response
    input = app.container.querySelector("input[placeholder*='Ask a question']");
    await changeInput(input, "Follow-up question");
    await click(findExactButton(app.container, "Send"));

    await waitFor(function () {
      return findByText(app.container, "Answer 2.");
    }, "expected second answer", 5000);

    expect(capturedBodies[1].qaSessionId).toBe("sdk-sess-456");

    await app.unmount();
  });
});
