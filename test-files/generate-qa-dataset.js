/**
 * Golden Q&A dataset generator for AGENTVIZ.
 * Reads session profiles and generates 300 question-answer pairs
 * across 5 difficulty tiers and 2 scopes.
 *
 * Usage: node --experimental-strip-types test-files/generate-qa-dataset.js
 * Input: test-files/session-profiles.json
 * Output: test-files/qa-golden-dataset.json
 */

import fs from "node:fs";
import path from "node:path";

var profiles = JSON.parse(fs.readFileSync(path.join("test-files", "session-profiles.json"), "utf8"));
var validProfiles = profiles.filter(function (p) { return !p.error && p.turnCount > 0; });

function truncate(value, maxLen) {
  if (!value || typeof value !== "string") return "";
  return value.length <= maxLen ? value : value.substring(0, maxLen - 3) + "...";
}

function pluralize(count, singular, plural) {
  return count + " " + (count === 1 ? singular : (plural || singular + "s"));
}

function formatDuration(seconds) {
  var s = Math.round(seconds);
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60);
  var rem = s % 60;
  if (m < 60) return rem > 0 ? m + "m " + rem + "s" : m + "m";
  var h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}

function pickRandom(arr, count) {
  var shuffled = arr.slice().sort(function () { return Math.random() - 0.5; });
  return shuffled.slice(0, count);
}

var questions = [];
var nextId = 1;

function addQuestion(q) {
  q.id = "q" + String(nextId++).padStart(3, "0");
  questions.push(q);
}

// ==================== GENERAL QUESTIONS (applicable to any session) ====================

var GENERAL_TRIVIAL = [
  { q: "How many turns are in this session?", family: "metric", rubric: "exact-count", answerFn: function (p) { return "The session has " + pluralize(p.turnCount, "turn") + ". Turn indices are zero-based (0 through " + (p.turnCount - 1) + ")."; } },
  { q: "How many tool calls were made?", family: "metric", rubric: "exact-count", answerFn: function (p) { return "The session made " + pluralize(p.toolCallCount, "tool call") + "."; } },
  { q: "How many errors occurred?", family: "metric", rubric: "exact-count", answerFn: function (p) { return "The session recorded " + pluralize(p.errorCount, "error") + "."; } },
  { q: "How long did the session last?", family: "metric", rubric: "exact-value", answerFn: function (p) { return "The session lasted " + formatDuration(p.duration) + "."; } },
  { q: "What model was used?", family: "metric", rubric: "exact-value", answerFn: function (p) { return p.primaryModel ? "The primary model used in this session was " + p.primaryModel + "." : "No model information is available."; } },
  { q: "What is the session format?", family: "metric", rubric: "exact-value", answerFn: function (p) { return "The session format is " + (p.format || "unknown") + "."; } },
  { q: "How many events are in this session?", family: "metric", rubric: "exact-count", answerFn: function (p) { return "The session has " + pluralize(p.eventCount, "event") + "."; } },
];

var GENERAL_EASY = [
  { q: "What tools were used?", family: "tool-lookup", rubric: "contains-list", answerFn: function (p) { return "The session used " + pluralize(p.topTools.length, "tool") + ": " + p.topTools.map(function (t) { return t[0]; }).join(", ") + "."; } },
  { q: "What was the most used tool?", family: "metric", rubric: "exact-value", answerFn: function (p) { return p.topTools.length > 0 ? "The most-used tool was " + p.topTools[0][0] + " with " + pluralize(p.topTools[0][1], "call") + "." : "No tools were used."; } },
  { q: "Which files were modified?", family: "file-lookup", rubric: "contains-list", answerFn: function (p) { return p.topFiles.length > 0 ? "The session referenced " + pluralize(p.topFiles.length, "file") + " including: " + p.topFiles.slice(0, 5).map(function (f) { return f[0]; }).join(", ") + "." : "No file references found."; } },
  { q: "What errors occurred?", family: "error-diagnosis", rubric: "contains-key-facts", answerFn: function (p) { return p.errorCount > 0 ? "The session had " + pluralize(p.errorCount, "error") + " in turns: " + p.errorTurns.join(", ") + "." : "No errors were recorded in this session."; } },
  { q: "What commands were run?", family: "command-query-lookup", rubric: "contains-list", answerFn: function (p) { return p.sampleCommands.length > 0 ? "The session ran commands including: " + p.sampleCommands.slice(0, 5).join("; ") + "." : "No commands were recorded."; } },
  { q: "What happened in the first turn?", family: "turn-lookup", rubric: "contains-key-facts", answerFn: function (p) { var first = p.earlyUserMessages[0]; return first ? "Turn 0: " + first.message : "Turn 0 data not available."; } },
  { q: "What happened in the last turn?", family: "turn-lookup", rubric: "contains-key-facts", answerFn: function (p) { var last = p.lateUserMessages[p.lateUserMessages.length - 1]; return last ? "Turn " + last.turnIndex + ": " + last.message : "Last turn data not available."; } },
];

// Generate general trivial and easy questions for 3 different sessions
var generalSessions = pickRandom(validProfiles.filter(function (p) { return p.sizeLabel !== "small"; }), 3);

GENERAL_TRIVIAL.forEach(function (template) {
  generalSessions.forEach(function (session) {
    addQuestion({
      question: template.q,
      scope: "general",
      difficulty: "trivial",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: template.family,
      expectedLatency: "instant",
      goldenAnswer: {
        text: template.answerFn(session),
        turnReferences: [],
        rubric: template.rubric,
      },
    });
  });
});

GENERAL_EASY.forEach(function (template) {
  generalSessions.forEach(function (session) {
    addQuestion({
      question: template.q,
      scope: "general",
      difficulty: "easy",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: template.family,
      expectedLatency: "instant",
      goldenAnswer: {
        text: template.answerFn(session),
        turnReferences: [],
        rubric: template.rubric,
      },
    });
  });
});

// ==================== SESSION-SPECIFIC QUESTIONS ====================

validProfiles.forEach(function (session) {
  var turnCount = session.turnCount;
  var lastTurn = turnCount - 1;
  var midTurn = Math.floor(turnCount / 2);
  var thirdTurn = Math.floor(turnCount / 3);
  var twoThirdTurn = Math.floor(2 * turnCount / 3);

  // Trivial: specific turn lookups
  addQuestion({
    question: "What happened in turn 0?",
    scope: "session-specific",
    difficulty: "trivial",
    sessionId: session.fullId,
    sessionLabel: session.label,
    expectedFamily: "turn-lookup",
    expectedLatency: "instant",
    goldenAnswer: {
      text: "Turn 0: " + (session.earlyUserMessages[0] ? session.earlyUserMessages[0].message : "session start"),
      turnReferences: [0],
      rubric: "contains-key-facts",
    },
  });

  // Out-of-range turn
  addQuestion({
    question: "What happened in turn " + (turnCount + 10) + "?",
    scope: "session-specific",
    difficulty: "trivial",
    sessionId: session.fullId,
    sessionLabel: session.label,
    expectedFamily: "turn-lookup",
    expectedLatency: "instant",
    goldenAnswer: {
      text: "Turn " + (turnCount + 10) + " is out of range. Valid turns are 0 through " + lastTurn + ".",
      turnReferences: [],
      rubric: "contains-key-facts",
    },
  });

  // Easy: mid-session turn lookup
  if (midTurn > 0) {
    var midMsg = session.middleUserMessages[0];
    addQuestion({
      question: "What happened in turn " + midTurn + "?",
      scope: "session-specific",
      difficulty: "easy",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: "turn-lookup",
      expectedLatency: "instant",
      goldenAnswer: {
        text: midMsg ? "Turn " + midTurn + ": " + midMsg.message : "Turn " + midTurn + " summary",
        turnReferences: [midTurn],
        rubric: "contains-key-facts",
      },
    });
  }

  // Easy: late-session turn lookup
  if (lastTurn > 2) {
    var lateMsg = session.lateUserMessages[session.lateUserMessages.length - 1];
    addQuestion({
      question: "What happened in turn " + lastTurn + "?",
      scope: "session-specific",
      difficulty: "easy",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: "turn-lookup",
      expectedLatency: "instant",
      goldenAnswer: {
        text: lateMsg ? "Turn " + lastTurn + ": " + lateMsg.message : "Turn " + lastTurn + " summary",
        turnReferences: [lastTurn],
        rubric: "contains-key-facts",
      },
    });
  }

  // Easy: tool-specific question
  if (session.topTools.length > 0) {
    var topTool = session.topTools[0];
    addQuestion({
      question: "How was " + topTool[0] + " used in this session?",
      scope: "session-specific",
      difficulty: "easy",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: "tool-lookup",
      expectedLatency: "instant",
      goldenAnswer: {
        text: topTool[0] + " was used " + pluralize(topTool[1], "time") + " in this session.",
        turnReferences: [],
        rubric: "contains-key-facts",
      },
    });
  }

  // Medium: error analysis (if session has errors)
  if (session.errorCount > 0 && session.errorTurns.length > 0) {
    addQuestion({
      question: "What went wrong in turn " + session.errorTurns[0] + "?",
      scope: "session-specific",
      difficulty: "medium",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: "turn-lookup",
      expectedLatency: "instant",
      goldenAnswer: {
        text: "Turn " + session.errorTurns[0] + " had errors.",
        turnReferences: [session.errorTurns[0]],
        rubric: "contains-key-facts",
      },
    });

    // Were the errors eventually resolved?
    addQuestion({
      question: "Were the errors in this session eventually resolved?",
      scope: "session-specific",
      difficulty: "hard",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: "session-summary",
      expectedLatency: "model",
      goldenAnswer: {
        text: "The session had " + pluralize(session.errorCount, "error") + " across turns " + session.errorTurns.join(", ") + ". Resolution status requires analysis of subsequent turns.",
        turnReferences: session.errorTurns,
        rubric: "reasonable-synthesis",
      },
    });
  }

  // Medium: file-specific questions
  if (session.topFiles.length > 0) {
    var topFile = session.topFiles[0];
    addQuestion({
      question: "What changes were made to " + topFile[0] + "?",
      scope: "session-specific",
      difficulty: "medium",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: "file-lookup",
      expectedLatency: "fast",
      goldenAnswer: {
        text: topFile[0] + " was referenced " + pluralize(topFile[1], "time") + ".",
        turnReferences: [],
        rubric: "contains-key-facts",
      },
    });
  }

  // Hard: what happened in the second half
  addQuestion({
    question: "What happened in the second half of this session?",
    scope: "session-specific",
    difficulty: "hard",
    sessionId: session.fullId,
    sessionLabel: session.label,
    expectedFamily: "session-summary",
    expectedLatency: "model",
    goldenAnswer: {
      text: "The second half of the session (turns " + midTurn + "-" + lastTurn + ") involved: " + (session.lateUserMessages.length > 0 ? session.lateUserMessages.map(function (m) { return m.message; }).join("; ") : "continued work"),
      turnReferences: session.lateUserMessages.map(function (m) { return m.turnIndex; }),
      rubric: "reasonable-synthesis",
    },
  });

  // Hard: what was the final outcome
  addQuestion({
    question: "What was the final outcome of this session?",
    scope: "session-specific",
    difficulty: "hard",
    sessionId: session.fullId,
    sessionLabel: session.label,
    expectedFamily: "session-summary",
    expectedLatency: "model",
    goldenAnswer: {
      text: "The session '" + session.label + "' concluded at turn " + lastTurn + ".",
      turnReferences: [lastTurn],
      rubric: "reasonable-synthesis",
    },
  });

  // Very hard: domain-specific "why" questions based on user messages
  if (session.middleUserMessages.length > 0) {
    var midMessage = session.middleUserMessages[0];
    var firstWords = midMessage.message.split(/\s+/).slice(0, 6).join(" ");
    addQuestion({
      question: "Why did the agent " + firstWords.toLowerCase().replace(/^(fix|run|try|add|create|update|check|build|test|implement|set up|configure|debug|analyze|explore|investigate)/, "$1") + "?",
      scope: "session-specific",
      difficulty: "very-hard",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: "broad-synthesis",
      expectedLatency: "model",
      goldenAnswer: {
        text: "The agent performed this action around turn " + midMessage.turnIndex + " because of prior context in the session.",
        turnReferences: [midMessage.turnIndex],
        rubric: "reasonable-synthesis",
      },
    });
  }

  // Very hard: overall approach
  addQuestion({
    question: "What was the overall strategy used in this session?",
    scope: "session-specific",
    difficulty: "very-hard",
    sessionId: session.fullId,
    sessionLabel: session.label,
    expectedFamily: "session-summary",
    expectedLatency: "model",
    goldenAnswer: {
      text: "The session '" + session.label + "' spanned " + pluralize(turnCount, "turn") + " with " + pluralize(session.toolCallCount, "tool call") + ". Key phases included the work described in early turns and the developments in later turns.",
      turnReferences: [],
      rubric: "reasonable-synthesis",
    },
  });

  // Very hard: what could have been done differently
  addQuestion({
    question: "What could the agent have done more efficiently in this session?",
    scope: "session-specific",
    difficulty: "very-hard",
    sessionId: session.fullId,
    sessionLabel: session.label,
    expectedFamily: "broad-synthesis",
    expectedLatency: "model",
    goldenAnswer: {
      text: "With " + pluralize(session.errorCount, "error") + " and " + pluralize(turnCount, "turn") + ", potential efficiency improvements could include reducing error-retry cycles and consolidating tool calls.",
      turnReferences: [],
      rubric: "reasonable-synthesis",
    },
  });

  // Medium: command-specific questions
  if (session.sampleCommands.length > 0) {
    addQuestion({
      question: "What was the output of the " + truncate(session.sampleCommands[0], 40) + " command?",
      scope: "session-specific",
      difficulty: "medium",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: "exact-raw-evidence",
      expectedLatency: "fast",
      goldenAnswer: {
        text: "The command '" + truncate(session.sampleCommands[0], 60) + "' was executed during the session.",
        turnReferences: [],
        rubric: "contains-key-facts",
      },
    });
  }

  // Medium: tool usage in a specific turn range
  if (turnCount > 5) {
    addQuestion({
      question: "What tools were used in the last 5 turns?",
      scope: "session-specific",
      difficulty: "medium",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: "session-summary",
      expectedLatency: "model",
      goldenAnswer: {
        text: "In turns " + Math.max(0, lastTurn - 4) + "-" + lastTurn + ", the agent used various tools.",
        turnReferences: Array.from({length: Math.min(5, turnCount)}, function(_, i) { return lastTurn - i; }),
        rubric: "contains-key-facts",
      },
    });
  }

  // Medium: longest tool call analysis
  if (session.longestToolCall) {
    addQuestion({
      question: "What was the slowest operation in this session and why did it take so long?",
      scope: "session-specific",
      difficulty: "medium",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: "metric",
      expectedLatency: "fast",
      goldenAnswer: {
        text: "The longest tool call was " + session.longestToolCall.toolName + " lasting " + formatDuration(session.longestToolCall.duration) + " in turn " + session.longestToolCall.turnIndex + ".",
        turnReferences: [session.longestToolCall.turnIndex],
        rubric: "contains-key-facts",
      },
    });
  }

  // Medium: specific file interaction
  if (session.topFiles.length > 1) {
    var secondFile = session.topFiles[1];
    addQuestion({
      question: "How many times was " + secondFile[0] + " accessed?",
      scope: "session-specific",
      difficulty: "medium",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: "file-lookup",
      expectedLatency: "instant",
      goldenAnswer: {
        text: secondFile[0] + " was accessed " + pluralize(secondFile[1], "time") + ".",
        turnReferences: [],
        rubric: "exact-count",
      },
    });
  }

  // Very hard: causal chain reasoning
  if (session.errorTurns.length > 0 && session.lateUserMessages.length > 0) {
    addQuestion({
      question: "How did the errors in turn " + session.errorTurns[0] + " affect the rest of the session?",
      scope: "session-specific",
      difficulty: "very-hard",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: "broad-synthesis",
      expectedLatency: "model",
      goldenAnswer: {
        text: "The error in turn " + session.errorTurns[0] + " led to subsequent actions in the session.",
        turnReferences: [session.errorTurns[0]],
        rubric: "reasonable-synthesis",
      },
    });
  }

  // Very hard: compare beginning vs end
  addQuestion({
    question: "How did the agent's approach change between the beginning and end of this session?",
    scope: "session-specific",
    difficulty: "very-hard",
    sessionId: session.fullId,
    sessionLabel: session.label,
    expectedFamily: "session-summary",
    expectedLatency: "model",
    goldenAnswer: {
      text: "Early turns focused on initial exploration while later turns shifted to implementation or resolution.",
      turnReferences: [0, lastTurn],
      rubric: "reasonable-synthesis",
    },
  });
});

// ==================== FILL REMAINING QUOTA ====================

// Ensure we have enough questions to hit ~300
// Add more general medium/hard questions
var mediumGeneralTemplates = [
  { q: "What was the longest tool call in this session?", family: "metric", difficulty: "medium", rubric: "exact-value", answerFn: function (p) { return p.longestToolCall ? "The longest tool call was " + p.longestToolCall.toolName + " lasting " + formatDuration(p.longestToolCall.duration) + " in turn " + p.longestToolCall.turnIndex + "." : "No tool calls recorded."; } },
  { q: "Which turns had errors?", family: "error-diagnosis", difficulty: "medium", rubric: "contains-list", answerFn: function (p) { return p.errorCount > 0 ? "Errors occurred in turns: " + p.errorTurns.join(", ") + "." : "No errors."; } },
  { q: "How many distinct files were accessed?", family: "file-lookup", difficulty: "easy", rubric: "exact-count", answerFn: function (p) { return "The session accessed " + pluralize(p.topFiles.length, "distinct file") + "."; } },
];

mediumGeneralTemplates.forEach(function (template) {
  pickRandom(validProfiles, 3).forEach(function (session) {
    addQuestion({
      question: template.q,
      scope: "general",
      difficulty: template.difficulty,
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: template.family,
      expectedLatency: template.difficulty === "easy" ? "instant" : "fast",
      goldenAnswer: {
        text: template.answerFn(session),
        turnReferences: [],
        rubric: template.rubric,
      },
    });
  });
});

// Add broad summary questions for variety
var summaryQuestions = [
  "Summarize this session in a few sentences.",
  "What was the main goal of this session?",
  "Did the session accomplish what it set out to do?",
  "Walk me through the key decisions made in this session.",
  "What were the most important turning points?",
];

summaryQuestions.forEach(function (q) {
  pickRandom(validProfiles.filter(function (p) { return p.turnCount > 10; }), 2).forEach(function (session) {
    addQuestion({
      question: q,
      scope: "session-specific",
      difficulty: "hard",
      sessionId: session.fullId,
      sessionLabel: session.label,
      expectedFamily: "session-summary",
      expectedLatency: "model",
      goldenAnswer: {
        text: "The session '" + session.label + "' covered " + pluralize(session.turnCount, "turn") + " of work.",
        turnReferences: [],
        rubric: "reasonable-synthesis",
      },
    });
  });
});

// ==================== ASSEMBLE DATASET ====================

var dataset = {
  version: 1,
  generatedAt: new Date().toISOString(),
  stats: {
    totalQuestions: questions.length,
    byDifficulty: {},
    byScope: {},
    byLatency: {},
    byFamily: {},
  },
  sessions: validProfiles.map(function (p) {
    return {
      id: p.fullId,
      label: p.label,
      sizeBytes: p.sizeBytes,
      sizeLabel: p.sizeLabel,
      turnCount: p.turnCount,
      eventCount: p.eventCount,
      errorCount: p.errorCount,
    };
  }),
  questions: questions,
};

// Compute stats
questions.forEach(function (q) {
  dataset.stats.byDifficulty[q.difficulty] = (dataset.stats.byDifficulty[q.difficulty] || 0) + 1;
  dataset.stats.byScope[q.scope] = (dataset.stats.byScope[q.scope] || 0) + 1;
  dataset.stats.byLatency[q.expectedLatency] = (dataset.stats.byLatency[q.expectedLatency] || 0) + 1;
  dataset.stats.byFamily[q.expectedFamily] = (dataset.stats.byFamily[q.expectedFamily] || 0) + 1;
});

var outputPath = path.join("test-files", "qa-golden-dataset.json");
fs.writeFileSync(outputPath, JSON.stringify(dataset, null, 2));
console.log("Generated " + questions.length + " questions");
console.log("By difficulty:", JSON.stringify(dataset.stats.byDifficulty));
console.log("By scope:", JSON.stringify(dataset.stats.byScope));
console.log("By latency:", JSON.stringify(dataset.stats.byLatency));
console.log("By family:", JSON.stringify(dataset.stats.byFamily));
console.log("Wrote to " + outputPath);
