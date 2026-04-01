/**
 * Shared Q&A pipeline for AGENTVIZ.
 * Extracts the core Q&A flow from server.js so both the main server
 * and fax-viz-server can reuse the same logic.
 */

import fs from "fs";
import os from "os";
import {
  buildQAContext,
  buildQAPrompt,
  buildSessionQAArtifacts,
  compileSessionQAQueryProgram,
  buildSessionQAProgramCacheKey,
  describeSessionQAQueryProgram,
  routeSessionQAQuestion,
  buildRawJsonlRecordIndex,
  scanRawJsonlQuestionMatches,
} from "./sessionQA.js";
import {
  ensureSessionQAFactStore,
  querySessionQAFactStore,
} from "./sessionQAFactStore.js";
import {
  ensureSessionQAPrecomputed,
  buildQADonePayload,
  buildQASessionConfig,
  buildQAProgressPayload,
  getQAEventText,
  getQAToolName,
} from "./sessionQAServer.js";

function cloneJsonValue(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value));
}

function readRawText(entry) {
  if (entry && typeof entry.rawText === "string") return entry.rawText;
  if (!entry || !entry.sessionFilePath) return "";
  try {
    return fs.readFileSync(entry.sessionFilePath, "utf8");
  } catch (error) {
    return "";
  }
}

function describeQAContextPreparation(events, turns, metadata) {
  var safeMetadata = metadata && typeof metadata === "object" ? metadata : {};
  var eventCount = safeMetadata.totalEvents != null ? safeMetadata.totalEvents : (Array.isArray(events) ? events.length : 0);
  var turnCount = safeMetadata.totalTurns != null ? safeMetadata.totalTurns : (Array.isArray(turns) ? turns.length : 0);
  var eventLabel = eventCount != null ? eventCount.toLocaleString() + " " + (eventCount === 1 ? "event" : "events") : null;
  var turnLabel = turnCount != null ? turnCount.toLocaleString() + " " + (turnCount === 1 ? "turn" : "turns") : null;
  if (eventLabel && turnLabel) return "Reviewing " + eventLabel + " across " + turnLabel + ".";
  if (eventLabel) return "Reviewing " + eventLabel + ".";
  if (turnLabel) return "Reviewing " + turnLabel + ".";
  return "Reviewing the loaded session.";
}

function describeQAContextRetrieval(resolvedSession) {
  if (!resolvedSession || typeof resolvedSession !== "object") return null;
  var source = resolvedSession.source === "cache"
    ? "Using the cached session snapshot."
    : "Using the session data from this request.";
  if (!resolvedSession.sessionFilePath) return source;
  return source + " Raw session file access is available if the model needs exact output.";
}

function describeSessionQAProgramCompilation(queryProgram) {
  if (!queryProgram) return "Compiling the question into a structured session query.";
  var family = describeSessionQAQueryProgram(queryProgram);
  if (queryProgram.deterministic && !queryProgram.needsModel) {
    return "Compiled the question into the " + family + " family so AGENTVIZ can avoid the model if possible.";
  }
  return "Compiled the question into the " + family + " family before choosing the fastest route.";
}

function describeSessionQAFactStoreLookup(queryProgram, factStore) {
  var family = describeSessionQAQueryProgram(queryProgram);
  if (factStore && factStore.storage === "sidecar") {
    return "Querying the SQLite fact-store sidecar for the " + family + " family.";
  }
  return "Querying the SQLite fact store for the " + family + " family.";
}

function shouldLaunchSessionQARace(queryProgram) {
  return Boolean(queryProgram && queryProgram.raceEligible && queryProgram.canAnswerFromFactStore);
}

function buildSessionQARoutePlan(question, events, turns, metadata, qaArtifacts, options) {
  var opts = options && typeof options === "object" ? options : {};
  var route = routeSessionQAQuestion(question, qaArtifacts, {
    rawText: opts.rawText,
    rawIndex: opts.rawIndex,
    sessionFilePath: opts.sessionFilePath,
    queryProgram: opts.queryProgram,
    questionProfile: opts.queryProgram && opts.queryProgram.questionProfile
      ? opts.queryProgram.questionProfile
      : null,
  });
  var rawIndex = opts.rawIndex || null;

  if (route && route.kind === "raw-full" && rawIndex) {
    route.rawMatches = scanRawJsonlQuestionMatches(rawIndex, question, {
      questionProfile: route.profile,
      artifacts: qaArtifacts,
    });
  } else if (route && route.kind === "raw-full" && opts.rawText) {
    rawIndex = buildRawJsonlRecordIndex(opts.rawText);
    if (qaArtifacts && !qaArtifacts.rawIndex) qaArtifacts.rawIndex = rawIndex;
    route.rawMatches = scanRawJsonlQuestionMatches(rawIndex, question, {
      questionProfile: route.profile,
      artifacts: qaArtifacts,
    });
  }

  var context = "";
  if (route && route.kind !== "metric") {
    context = buildQAContext(events, turns, metadata, {
      question: question,
      artifacts: qaArtifacts,
      route: route,
    });
  }

  return {
    route: route,
    context: context,
    rawIndex: rawIndex,
  };
}

/**
 * handleSessionQA -- runs the full Q&A pipeline.
 *
 * @param {object} options
 * @param {string} options.question - the user's question
 * @param {object} options.resolvedSession - { events, turns, metadata, sessionFilePath, programCache }
 * @param {string} [options.requestedModel] - model to use
 * @param {string} [options.qaSessionId] - existing session ID for resumption
 * @param {function} [options.contextExtender] - function(context, question, route) => extendedContext
 * @param {function} options.sseSend - function(data) to send SSE events
 * @param {string} [options.homeDir] - for fact store path (defaults to os.homedir())
 * @param {object} [options.modelAnswerCache] - { get(fp, family, ctx, model), set(fp, family, ctx, answer, refs, model) }
 * @param {function} [options.onProgress] - function(phase, opts) for progress events
 * @param {string} [options.requestKind] - "detail-fetch" or null
 * @param {number} options.qaRequestStartedAt - timestamp
 * @param {function} [options.onAbort] - function(abortFn) called with abort callback for client disconnect
 */
export async function handleSessionQA(options) {
  var question = options.question;
  var resolvedSession = options.resolvedSession;
  var requestedModel = options.requestedModel || null;
  var qaSessionId = options.qaSessionId || null;
  var contextExtender = options.contextExtender || null;
  var sseSend = options.sseSend;
  var homeDir = options.homeDir || os.homedir();
  var modelAnswerCache = options.modelAnswerCache || null;
  var requestKind = options.requestKind || null;
  var qaRequestStartedAt = options.qaRequestStartedAt || Date.now();
  var speculativeOptimizations = options.speculativeOptimizations !== false;

  var events = resolvedSession.events;
  var turns = resolvedSession.turns;
  var metadata = resolvedSession.metadata;
  var sessionFilePath = resolvedSession.sessionFilePath || null;
  var precomputed = ensureSessionQAPrecomputed(resolvedSession);
  var qaArtifacts = precomputed && precomputed.artifacts
    ? precomputed.artifacts
    : buildSessionQAArtifacts(events, turns, metadata);
  var rawText = precomputed && typeof precomputed.rawText === "string"
    ? precomputed.rawText
    : readRawText(resolvedSession);
  var rawIndex = qaArtifacts && qaArtifacts.rawIndex
    ? qaArtifacts.rawIndex
    : null;
  if (qaArtifacts && qaArtifacts.rawLookup && rawText && !qaArtifacts.rawLookup.rawText) {
    qaArtifacts.rawLookup.rawText = rawText;
  }

  // Progress heartbeat
  var currentProgress = null;
  var lastProgressSignature = "";
  var lastProgressSentAt = 0;
  var progressHeartbeat = setInterval(function () {
    if (!currentProgress || currentProgress.phase === "streaming-answer") return;
    if (Date.now() - lastProgressSentAt < 2000) return;
    lastProgressSentAt = Date.now();
    sseSend(buildQAProgressPayload(currentProgress.phase, {
      status: currentProgress.status,
      detail: currentProgress.detail,
      elapsedMs: Date.now() - qaRequestStartedAt,
      heartbeat: true,
    }));
  }, 1500);

  var stopProgressHeartbeat = function () {
    if (!progressHeartbeat) return;
    clearInterval(progressHeartbeat);
    progressHeartbeat = null;
  };

  function sendProgress(phase, progressOpts) {
    var o = progressOpts && typeof progressOpts === "object" ? progressOpts : {};
    var payload = buildQAProgressPayload(phase, {
      status: o.status,
      detail: o.detail,
      toolName: o.toolName,
      elapsedMs: o.elapsedMs != null ? o.elapsedMs : (Date.now() - qaRequestStartedAt),
      heartbeat: o.heartbeat,
    });
    currentProgress = {
      phase: payload.phase || phase || null,
      status: payload.status,
      detail: payload.detail || null,
    };
    var signature = [currentProgress.phase || "", currentProgress.status || "", currentProgress.detail || ""].join("|");
    if (!o.force && signature === lastProgressSignature) return;
    lastProgressSignature = signature;
    lastProgressSentAt = Date.now();
    sseSend(payload);
  }

  // Declare programCacheKey at the top so it is available after the if/else
  var programCacheKey = null;

  try {
    sendProgress("precomputing-session", {
      detail: precomputed && precomputed.reused
        ? "Using the precomputed metrics, indexes, and summary chunks for this session."
        : "Building precomputed metrics, indexes, and summary chunks for this session.",
      force: true,
    });

    var context = "";
    var prompt = null;
    var route = null;
    var queryProgram = null;
    var sdkImportPromise;

    if (requestKind === "detail-fetch") {
      sendProgress("detail-fetch", {
        detail: "Pulling the exact tool output referenced in the draft answer.",
        force: true,
      });
      context = buildQAContext(events, turns, metadata, {
        question: question,
        artifacts: qaArtifacts,
      });
      prompt = buildQAPrompt(question, context, { sessionFilePath: null });
    } else {
      queryProgram = compileSessionQAQueryProgram(question, qaArtifacts);
      programCacheKey = buildSessionQAProgramCacheKey(queryProgram, {
        fingerprint: precomputed ? precomputed.fingerprint : null,
      });
      var cachedProgramPlan = speculativeOptimizations && programCacheKey && resolvedSession.programCache
        ? resolvedSession.programCache[programCacheKey]
        : null;

      sendProgress("compiling-query-program", {
        detail: describeSessionQAProgramCompilation(queryProgram),
        force: true,
      });

      sendProgress("checking-paraphrase-cache", {
        detail: cachedProgramPlan && cachedProgramPlan.fingerprint === (precomputed && precomputed.fingerprint)
          ? "Found a paraphrase-aware cache hit for this question family."
          : "No paraphrase-aware cache hit yet, so AGENTVIZ will evaluate the live session facts.",
        force: true,
      });

      if (cachedProgramPlan && cachedProgramPlan.fingerprint === (precomputed && precomputed.fingerprint) &&
          !(queryProgram.deterministic && !queryProgram.needsModel)) {
        if (cachedProgramPlan.directAnswer) {
          sendProgress("using-cached-program-answer", {
            detail: "Reusing the cached " + describeSessionQAQueryProgram(queryProgram) + " answer.",
            force: true,
          });
          stopProgressHeartbeat();
          sseSend(buildQADonePayload(
            cachedProgramPlan.directAnswer,
            cachedProgramPlan.references || [],
            cachedProgramPlan.model || "AGENTVIZ cached program answer",
            qaSessionId,
            qaRequestStartedAt,
            Date.now()
          ));
          return;
        }
        route = cachedProgramPlan.route || null;
        context = cachedProgramPlan.context || "";
      }

      if (!route && queryProgram.family === "metric") {
        var metricPlan = buildSessionQARoutePlan(question, events, turns, metadata, qaArtifacts, {
          rawText: rawText,
          rawIndex: rawIndex,
          sessionFilePath: sessionFilePath,
          queryProgram: queryProgram,
        });
        route = metricPlan.route;
        context = metricPlan.context || "";
        rawIndex = metricPlan.rawIndex || rawIndex;
      }

      var fallbackPlanPromise = null;
      if (!route && speculativeOptimizations && shouldLaunchSessionQARace(queryProgram)) {
        sendProgress("launching-fallback-route", {
          detail: "Launching the existing router in parallel while AGENTVIZ checks the SQLite fact store.",
          force: true,
        });
        fallbackPlanPromise = Promise.resolve().then(function () {
          return buildSessionQARoutePlan(question, events, turns, metadata, qaArtifacts, {
            rawText: rawText,
            rawIndex: rawIndex,
            sessionFilePath: sessionFilePath,
            queryProgram: queryProgram,
          });
        });
        fallbackPlanPromise.catch(function () {});
      }

      if (!route && speculativeOptimizations && queryProgram.canAnswerFromFactStore) {
        var factStore = await ensureSessionQAFactStore(resolvedSession, precomputed, { homeDir: homeDir });
        if (factStore && factStore.path) {
          sendProgress("querying-fact-store", {
            detail: describeSessionQAFactStoreLookup(queryProgram, factStore),
            force: true,
          });
          var factStoreResult = await querySessionQAFactStore(queryProgram, factStore, { rawText: rawText });
          if (factStoreResult && typeof factStoreResult.answer === "string" && factStoreResult.answer.trim()) {
            if (programCacheKey && resolvedSession.programCache) {
              resolvedSession.programCache[programCacheKey] = {
                fingerprint: precomputed ? precomputed.fingerprint : null,
                directAnswer: factStoreResult.answer,
                references: factStoreResult.references || [],
                model: factStoreResult.model || "AGENTVIZ SQLite fact store",
              };
            }
            if (fallbackPlanPromise) {
              sendProgress("canceling-slower-route", {
                detail: "The fact-store route answered the question, so AGENTVIZ skipped the slower fallback path.",
                force: true,
              });
            }
            stopProgressHeartbeat();
            sseSend(buildQADonePayload(
              factStoreResult.answer,
              factStoreResult.references || [],
              factStoreResult.model || "AGENTVIZ SQLite fact store",
              qaSessionId,
              qaRequestStartedAt,
              Date.now()
            ));
            return;
          }
          if (factStoreResult && typeof factStoreResult.context === "string" && factStoreResult.context.trim()) {
            route = {
              kind: "fact-store",
              phase: "querying-fact-store",
              status: "Using SQLite fact store...",
              detail: factStoreResult.detail || describeSessionQAFactStoreLookup(queryProgram, factStore),
              profile: queryProgram.questionProfile,
              queryProgram: queryProgram,
            };
            context = factStoreResult.context;
            if (programCacheKey && resolvedSession.programCache) {
              resolvedSession.programCache[programCacheKey] = {
                fingerprint: precomputed ? precomputed.fingerprint : null,
                route: cloneJsonValue(route),
                context: context,
              };
            }
            if (fallbackPlanPromise) {
              sendProgress("canceling-slower-route", {
                detail: "The fact-store route produced enough context, so AGENTVIZ skipped the slower fallback path.",
                force: true,
              });
            }
          }
        }
      }

      if (!route) {
        var preparedPlan = fallbackPlanPromise
          ? await fallbackPlanPromise
          : buildSessionQARoutePlan(question, events, turns, metadata, qaArtifacts, {
            rawText: rawText,
            rawIndex: rawIndex,
            sessionFilePath: sessionFilePath,
            queryProgram: queryProgram,
          });
        route = preparedPlan.route;
        context = preparedPlan.context || "";
        rawIndex = preparedPlan.rawIndex || rawIndex;
        if (programCacheKey && route && resolvedSession.programCache) {
          resolvedSession.programCache[programCacheKey] = {
            fingerprint: precomputed ? precomputed.fingerprint : null,
            route: cloneJsonValue(route),
            context: context || "",
          };
        }
      }

      if (route) {
        sendProgress(route.phase, {
          status: route.status,
          detail: route.detail,
          force: true,
        });
      }

      if (route && route.kind === "metric") {
        if (programCacheKey && resolvedSession.programCache) {
          resolvedSession.programCache[programCacheKey] = {
            fingerprint: precomputed ? precomputed.fingerprint : null,
            directAnswer: route.directAnswer,
            references: route.references || [],
            model: "AGENTVIZ precomputed metrics",
          };
        }
        stopProgressHeartbeat();
        sseSend(buildQADonePayload(
          route.directAnswer,
          route.references || [],
          "AGENTVIZ precomputed metrics",
          qaSessionId,
          qaRequestStartedAt,
          Date.now()
        ));
        return;
      }

      if (!route || route.kind === "model") {
        sendProgress("preparing-context", {
          detail: describeQAContextPreparation(events, turns, metadata),
          force: true,
        });
      }

      var promptSessionFilePath = null;
      if (route && (route.kind === "raw-full" || route.kind === "raw-targeted")) {
        promptSessionFilePath = sessionFilePath;
      }
      sdkImportPromise = import("@github/copilot-sdk");
      prompt = buildQAPrompt(question, context, { sessionFilePath: promptSessionFilePath });
      sendProgress("retrieving-context", {
        detail: route && route.kind !== "model"
          ? route.detail + " " + describeQAContextRetrieval(resolvedSession)
          : describeQAContextRetrieval(resolvedSession),
      });
    }

    // Apply contextExtender if provided (e.g. prepend fax markdown context)
    if (contextExtender && typeof contextExtender === "function") {
      context = contextExtender(context, question, route);
      var extPromptFilePath = null;
      if (route && (route.kind === "raw-full" || route.kind === "raw-targeted")) {
        extPromptFilePath = sessionFilePath;
      }
      prompt = buildQAPrompt(question, context, { sessionFilePath: extPromptFilePath });
    }

    // Check context-based model answer cache before calling the model
    var contextFingerprint = precomputed ? precomputed.fingerprint : null;
    var contextFamily = queryProgram ? queryProgram.family : "unknown";
    var cachedModelAnswer = null;
    if (speculativeOptimizations && context && modelAnswerCache && typeof modelAnswerCache.get === "function") {
      cachedModelAnswer = modelAnswerCache.get(contextFingerprint, contextFamily, context, requestedModel || "default", question);
    }
    if (cachedModelAnswer && cachedModelAnswer.answer) {
      sendProgress("using-cached-program-answer", {
        detail: "Reusing a cached model answer for similar context.",
        force: true,
      });
      stopProgressHeartbeat();
      sseSend(buildQADonePayload(
        cachedModelAnswer.answer,
        cachedModelAnswer.references || [],
        cachedModelAnswer.model || "AGENTVIZ cached model answer",
        qaSessionId,
        qaRequestStartedAt,
        Date.now()
      ));
      return;
    }

    // Import SDK (reuse the promise if already started above, or start fresh)
    var sdkModule;
    try {
      sdkModule = sdkImportPromise
        ? await sdkImportPromise
        : await import("@github/copilot-sdk");
    } catch (sdkErr) {
      stopProgressHeartbeat();
      sseSend({ error: "Copilot SDK not available: " + (sdkErr.message || String(sdkErr)) });
      return;
    }

    var CopilotClient = sdkModule.CopilotClient;
    var approveAll = sdkModule.approveAll;
    var client = new CopilotClient();
    var answer = "";
    var returnedSessionId = qaSessionId;

    try {
      await client.start();

      var session;
      if (qaSessionId) {
        sendProgress("resuming-session", {
          detail: "Continuing the previous Q&A conversation with the loaded session.",
        });
        try {
          session = await client.resumeSession(
            qaSessionId,
            buildQASessionConfig(prompt.system, approveAll)
          );
        } catch (resumeErr) {
          session = null;
        }
      }

      if (!session) {
        sendProgress("starting-session", {
          detail: requestedModel
            ? "Launching a fresh " + requestedModel + " Q&A session."
            : "Launching a fresh Q&A session.",
        });
        var sessionOpts = buildQASessionConfig(prompt.system, approveAll);
        if (requestedModel) sessionOpts.model = requestedModel;
        session = await client.createSession(sessionOpts);
        returnedSessionId = session.sessionId;
      }

      // Allow caller to abort on disconnect
      if (options.onAbort && typeof options.onAbort === "function") {
        options.onAbort(function () {
          stopProgressHeartbeat();
          session && session.abort && session.abort().catch(function () {});
        });
      }

      // Send the question and stream deltas back via SSE
      await new Promise(function (resolve, reject) {
        var done = false;
        var sawDelta = false;
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
          } else if (event.type === "tool.execution_start") {
            sendProgress("tool-running", {
              toolName: getQAToolName(event.data),
            });
          } else if (event.type === "tool.execution_complete" && !sawDelta) {
            sendProgress("tool-finished", {
              toolName: getQAToolName(event.data),
            });
          } else if (event.type === "assistant.reasoning_delta" && !sawDelta) {
            sendProgress("thinking", {
              detail: "Synthesizing an answer from the session timeline.",
            });
          } else if (event.type === "assistant.message_delta" || event.type === "assistant.message.delta") {
            var delta = getQAEventText(event.data, true);
            if (delta) {
              sawDelta = true;
              answer += delta;
              sendProgress("streaming-answer", {
                detail: "Composing the final answer.",
              });
              sseSend({ delta: delta });
            }
          } else if (event.type === "assistant.message") {
            var text = getQAEventText(event.data, false);
            if (text) {
              answer = text;
              if (!sawDelta) {
                sendProgress("streaming-answer", {
                  detail: "Composing the final answer.",
                });
                sseSend({ delta: text });
              }
            }
          }
        });
        sendProgress("waiting-for-model", {
          detail: requestKind === "detail-fetch"
            ? "Prompt sent. Fetching the exact tool output referenced in the draft answer."
            : sessionFilePath
              ? "Prompt sent. Raw session file access is available if the model needs exact output."
              : "Prompt sent. Waiting for the first model response.",
          force: true,
        });
        session.send({ prompt: "[AGENTVIZ-QA] " + prompt.user }).catch(function (err) {
          if (!done) { done = true; unsubscribe(); reject(err); }
        });
      });

      await session.disconnect();
    } finally {
      stopProgressHeartbeat();
      await client.stop().catch(function () {});
    }

    // Extract turn references from the answer
    var references = [];
    var refRegex = /\[Turn (\d+)\]/g;
    var refMatch;
    while ((refMatch = refRegex.exec(answer)) !== null) {
      var turnIdx = parseInt(refMatch[1], 10);
      if (!references.some(function (r) { return r.turnIndex === turnIdx; })) {
        references.push({ turnIndex: turnIdx });
      }
    }

    // Cache the model answer for paraphrase reuse on future similar questions
    if (programCacheKey && answer && resolvedSession.programCache) {
      resolvedSession.programCache[programCacheKey] = {
        fingerprint: precomputed ? precomputed.fingerprint : null,
        directAnswer: answer,
        references: references,
        model: requestedModel || "default",
        context: context || "",
      };
    }

    // Also cache by context hash for cross-phrasing reuse
    if (context && answer && modelAnswerCache && typeof modelAnswerCache.set === "function") {
      modelAnswerCache.set(
        precomputed ? precomputed.fingerprint : null,
        queryProgram ? queryProgram.family : "unknown",
        context,
        answer,
        references,
        requestedModel || "default",
        question
      );
    }

    var modelLabel = requestedModel || "default";
    sseSend(buildQADonePayload(
      answer,
      references,
      modelLabel,
      returnedSessionId,
      qaRequestStartedAt,
      Date.now()
    ));
  } finally {
    stopProgressHeartbeat();
  }
}
