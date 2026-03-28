import { CopilotClient, defineTool, approveAll } from "@github/copilot-sdk";

function buildDigestTool(handlers) {
  return defineTool("submit_digest_sections", {
    description:
      "Submit the synthesized digest sections exactly once after analyzing the provided evidence. Do not invent facts that are not present in the evidence payload.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "A concise 2-4 sentence summary of how the session unfolded.",
        },
        hypotheses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              hypothesis: { type: "string" },
              outcome: { type: "string", enum: ["confirmed", "abandoned", "open"] },
              evidence: { type: "string" },
            },
            required: ["hypothesis", "outcome", "evidence"],
          },
        },
        decisions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              decision: { type: "string" },
              rationale: { type: "string" },
              evidence: { type: "string" },
            },
            required: ["decision", "rationale", "evidence"],
          },
        },
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              answer: { type: "string" },
              evidence: { type: "string" },
            },
            required: ["question", "answer", "evidence"],
          },
        },
      },
      required: ["summary", "hypotheses", "decisions", "questions"],
    },
    skipPermission: true,
    handler: handlers.submit_digest_sections,
  });
}

function normalizeArray(items, mapItem) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 8).map(mapItem).filter(Boolean);
}

export function normalizeDigestSections(args) {
  return {
    summary: String((args && args.summary) || "").trim(),
    hypotheses: normalizeArray(args && args.hypotheses, function (item) {
      if (!item || typeof item !== "object") return null;
      return {
        hypothesis: String(item.hypothesis || "").trim(),
        outcome: item.outcome === "confirmed" || item.outcome === "abandoned" ? item.outcome : "open",
        evidence: String(item.evidence || "").trim(),
      };
    }),
    decisions: normalizeArray(args && args.decisions, function (item) {
      if (!item || typeof item !== "object") return null;
      return {
        decision: String(item.decision || "").trim(),
        rationale: String(item.rationale || "").trim(),
        evidence: String(item.evidence || "").trim(),
      };
    }),
    questions: normalizeArray(args && args.questions, function (item) {
      if (!item || typeof item !== "object") return null;
      return {
        question: String(item.question || "").trim(),
        answer: String(item.answer || "").trim(),
        evidence: String(item.evidence || "").trim(),
      };
    }),
  };
}

function buildSystemPrompt() {
  return [
    "You are an AI session analyst for AGENTVIZ.",
    "Your job is to synthesize higher-order digest sections from a structured evidence payload.",
    "",
    "Rules:",
    "- Use ONLY the provided evidence payload.",
    "- Do NOT invent commands, files, errors, decisions, outcomes, or questions.",
    "- Cite concrete evidence in every synthesized item. Mention turn numbers, tool names, or exact observed failures when possible.",
    "- Do NOT write markdown. Submit structured data via submit_digest_sections exactly once.",
    "- Keep the summary concise and the synthesized sections high signal.",
  ].join("\n");
}

export function buildDigestPrompt(payload) {
  return [
    "Create digest sections for this AGENTVIZ session.",
    "Return your synthesis by calling submit_digest_sections exactly once.",
    "",
    "Requirements:",
    "1. summary: 2-4 sentences.",
    "2. hypotheses: 2-6 items with outcome set to confirmed, abandoned, or open.",
    "3. decisions: 2-6 items with rationale and evidence.",
    "4. questions: 3-8 reviewer questions with concise answers and evidence.",
    "5. Prefer the evidence arrays and per-turn digests over generic advice.",
    "",
    "Evidence JSON:",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

export async function runSessionDigestAgent(payload, opts, _attempt) {
  var signal = opts && opts.signal;
  var onStep = opts && opts.onStep;
  var attempt = _attempt || 1;
  var sections = null;
  var steps = [];
  var client = new CopilotClient();
  var session;

  function emit(step) {
    steps.push(step);
    if (onStep) onStep(step);
  }

  var tool = buildDigestTool({
    submit_digest_sections: async function (args) {
      sections = normalizeDigestSections(args);
      emit({ type: "submit", label: "Digest sections ready" });
      return "Digest sections recorded.";
    },
  });

  try {
    await client.start();
    emit({ type: "start", label: attempt > 1 ? "Copilot digest agent started (retry " + attempt + ")" : "Copilot digest agent started" });

    session = await client.createSession({
      tools: [tool],
      onPermissionRequest: approveAll,
      systemMessage: {
        mode: "replace",
        content: buildSystemPrompt(),
      },
    });

    if (signal) {
      signal.addEventListener("abort", function () {
        if (session) {
          session.abort().catch(function () {});
        }
      }, { once: true });
    }

    emit({ type: "analyze", label: "Synthesizing digest sections..." });

    await new Promise(function (resolve, reject) {
      var done = false;
      var unsubscribe = session.on(function (event) {
        if (done) return;
        if (event.type === "session.idle") {
          done = true;
          unsubscribe();
          resolve();
        } else if (event.type === "session.error") {
          done = true;
          unsubscribe();
          reject(new Error(event.data && event.data.message ? event.data.message : "Session error"));
        }
      });

      session.send({ prompt: buildDigestPrompt(payload) }).catch(function (error) {
        if (!done) {
          done = true;
          unsubscribe();
          reject(error);
        }
      });
    });

    await session.disconnect();

    if (signal && signal.aborted) {
      throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    }

    if (!sections) {
      throw new Error("Agent did not submit digest sections. Try again.");
    }

    emit({ type: "done", label: "Digest sections generated" });

    return {
      sections,
      model: "copilot-sdk",
      usage: null,
      steps,
    };
  } catch (error) {
    if (error && error.name !== "AbortError" && attempt < 3 && /Timeout|timeout/.test(error.message)) {
      emit({ type: "retry", label: "Model timed out, retrying..." });
      await client.stop().catch(function () {});
      return runSessionDigestAgent(payload, opts, attempt + 1);
    }
    throw error;
  } finally {
    if (session) await session.disconnect().catch(function () {});
    await client.stop().catch(function () {});
  }
}
