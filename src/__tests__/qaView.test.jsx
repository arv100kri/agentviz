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

    // Verify send button
    expect(findExactButton(app.container, "Send")).toBeTruthy();

    // Verify model status bar
    expect(findByText(app.container, "Powered by Copilot SDK")).toBeTruthy();

    await app.unmount();
  });

  it("shows a user message in the chat when a question is submitted", async function () {
    // Mock fetch to return a Q&A answer
    var qaFetchCalled = false;
    var fetchMock = vi.fn(async function (url, opts) {
      if (String(url).includes("/api/qa")) {
        qaFetchCalled = true;
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
});
