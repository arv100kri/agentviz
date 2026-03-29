/**
 * Session search index for Q&A retrieval.
 *
 * Wraps lunr.js behind an abstract search interface so it can be swapped
 * for Azure AI Search or another provider without changing retrieval logic.
 *
 * The index is built once per session during preprocessing and reused
 * for all subsequent Q&A queries against that session.
 */

import lunr from "lunr";

/**
 * Build a session search index from precomputed Q&A artifacts.
 *
 * @param {object} artifacts - The precomputed Q&A artifacts (from buildSessionQAArtifacts)
 * @returns {{ search: function, index: object, documentCount: number }}
 */
export function buildSessionSearchIndex(artifacts) {
  if (!artifacts) return null;

  var turnSummaries = Array.isArray(artifacts.turnSummaries) ? artifacts.turnSummaries : [];
  var ledger = Array.isArray(artifacts.ledger) ? artifacts.ledger : [];
  var summaryChunks = Array.isArray(artifacts.summaryChunks) ? artifacts.summaryChunks : [];

  var documents = [];

  // Index turn summaries
  for (var ti = 0; ti < turnSummaries.length; ti++) {
    var turn = turnSummaries[ti];
    var turnDoc = {
      id: "turn-" + turn.turnIndex,
      type: "turn",
      turnIndex: turn.turnIndex,
      userMessage: typeof turn.userMessage === "string" ? turn.userMessage : "",
      summary: typeof turn.summary === "string" ? turn.summary : "",
      toolContext: Array.isArray(turn.toolNames) ? turn.toolNames.join(" ") : "",
      outputPreview: typeof turn.outputPreview === "string" ? turn.outputPreview : "",
      entities: Array.isArray(turn.focusEntities) ? turn.focusEntities.join(" ") : "",
    };
    documents.push(turnDoc);
  }

  // Index tool calls from the ledger
  for (var li = 0; li < ledger.length; li++) {
    var entry = ledger[li];
    if (!entry || !entry.id) continue;
    var entities = entry.entities && typeof entry.entities === "object" ? entry.entities : {};
    var toolDoc = {
      id: entry.id,
      type: "tool",
      turnIndex: entry.turnIndex != null ? entry.turnIndex : -1,
      userMessage: typeof entry.userMessage === "string" ? entry.userMessage : "",
      summary: "",
      toolContext: [
        entry.toolName || "",
        typeof entry.inputPreview === "string" ? entry.inputPreview : "",
        typeof entry.inputText === "string" ? entry.inputText : "",
      ].filter(Boolean).join(" "),
      outputPreview: typeof entry.outputPreview === "string" ? entry.outputPreview : "",
      entities: [
        Array.isArray(entities.paths) ? entities.paths.join(" ") : "",
        Array.isArray(entities.commands) ? entities.commands.join(" ") : "",
        Array.isArray(entities.queries) ? entities.queries.join(" ") : "",
        Array.isArray(entities.urls) ? entities.urls.join(" ") : "",
        Array.isArray(entities.repos) ? entities.repos.join(" ") : "",
        Array.isArray(entities.identifiers) ? entities.identifiers.join(" ") : "",
      ].filter(Boolean).join(" "),
    };
    documents.push(toolDoc);
  }

  // Index summary chunks
  for (var ci = 0; ci < summaryChunks.length; ci++) {
    var chunk = summaryChunks[ci];
    var chunkDoc = {
      id: "chunk-" + chunk.chunkIndex,
      type: "chunk",
      turnIndex: chunk.startTurn != null ? chunk.startTurn : -1,
      userMessage: "",
      summary: typeof chunk.summary === "string" ? chunk.summary : "",
      toolContext: Array.isArray(chunk.toolNames) ? chunk.toolNames.join(" ") : "",
      outputPreview: "",
      entities: Array.isArray(chunk.focusEntities) ? chunk.focusEntities.join(" ") : "",
    };
    documents.push(chunkDoc);
  }

  if (documents.length === 0) return null;

  // Build the lunr index with field boosting
  var idx = lunr(function () {
    this.ref("id");
    this.field("userMessage", { boost: 2 });
    this.field("summary", { boost: 1.5 });
    this.field("toolContext", { boost: 1 });
    this.field("outputPreview", { boost: 1 });
    this.field("entities", { boost: 1.5 });

    // Disable stemmer for technical terms (file paths, commands)
    this.pipeline.remove(lunr.stemmer);
    this.searchPipeline.remove(lunr.stemmer);

    for (var di = 0; di < documents.length; di++) {
      this.add(documents[di]);
    }
  });

  // Build a lookup map for document metadata
  var docMap = {};
  for (var mi = 0; mi < documents.length; mi++) {
    docMap[documents[mi].id] = documents[mi];
  }

  return createSearchProvider(idx, docMap, documents.length);
}

/**
 * Create a search provider that wraps a lunr index.
 * This is the abstract interface that can be swapped for Azure AI Search.
 */
function createSearchProvider(lunrIndex, docMap, documentCount) {
  return {
    /**
     * Search the index with a query string.
     * @param {string} query - The search query
     * @param {object} [options] - Search options
     * @param {number} [options.limit] - Max results to return (default: 10)
     * @param {string} [options.type] - Filter by document type ("turn", "tool", "chunk")
     * @returns {Array<{ ref: string, score: number, turnIndex: number, type: string, matchData: object }>}
     */
    search: function (query, options) {
      if (!query || typeof query !== "string") return [];
      var opts = options && typeof options === "object" ? options : {};
      var limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : 10;
      var typeFilter = typeof opts.type === "string" ? opts.type : null;

      var results;
      try {
        results = lunrIndex.search(query);
      } catch (e) {
        // lunr throws on invalid query syntax; fall back to safe Query API
        try {
          var terms = query.split(/\s+/).filter(function (t) { return t.length > 1; });
          results = lunrIndex.query(function (q) {
            for (var ti = 0; ti < terms.length; ti++) {
              q.term(terms[ti], { usePipeline: true, wildcard: lunr.Query.wildcard.NONE });
            }
          });
        } catch (e2) {
          return [];
        }
      }

      var output = [];
      for (var ri = 0; ri < results.length && output.length < limit; ri++) {
        var result = results[ri];
        var doc = docMap[result.ref];
        if (!doc) continue;
        if (typeFilter && doc.type !== typeFilter) continue;
        output.push({
          ref: result.ref,
          score: result.score,
          turnIndex: doc.turnIndex,
          type: doc.type,
          matchData: result.matchData,
        });
      }

      return output;
    },

    /** The underlying lunr index (for debugging/inspection) */
    index: lunrIndex,

    /** Number of documents in the index */
    documentCount: documentCount,

    /** Provider name for logging */
    provider: "lunr",
  };
}

/**
 * Extract turn indices from search results for use as turn hints.
 * @param {Array} results - Search results from the search provider
 * @param {number} [limit] - Max unique turn indices to return
 * @returns {number[]} - Unique turn indices sorted by relevance
 */
export function extractSearchTurnHints(results, limit) {
  if (!Array.isArray(results) || results.length === 0) return [];
  var maxHints = typeof limit === "number" && limit > 0 ? limit : 5;
  var seen = {};
  var hints = [];

  for (var i = 0; i < results.length && hints.length < maxHints; i++) {
    var turnIndex = results[i].turnIndex;
    if (turnIndex == null || turnIndex < 0 || seen[turnIndex]) continue;
    seen[turnIndex] = true;
    hints.push(turnIndex);
  }

  return hints;
}

/**
 * Build a focused context string from search results for the model prompt.
 * @param {Array} results - Search results from the search provider
 * @param {object} artifacts - The precomputed Q&A artifacts
 * @param {number} [charBudget] - Maximum characters for the context
 * @returns {string} - Context string for the model prompt
 */
export function buildSearchResultContext(results, artifacts, charBudget) {
  if (!Array.isArray(results) || results.length === 0 || !artifacts) return "";
  var budget = typeof charBudget === "number" && charBudget > 0 ? charBudget : 4000;

  var turnSummaries = Array.isArray(artifacts.turnSummaries) ? artifacts.turnSummaries : [];
  var turnByIndex = {};
  for (var ti = 0; ti < turnSummaries.length; ti++) {
    turnByIndex[turnSummaries[ti].turnIndex] = turnSummaries[ti];
  }

  var lines = ["=== SEARCH RESULTS ==="];
  var used = lines[0].length + 1;

  for (var ri = 0; ri < results.length; ri++) {
    var result = results[ri];
    var turn = turnByIndex[result.turnIndex];
    var line = "- Turn " + result.turnIndex;
    if (result.type === "tool") line += " (tool call)";
    if (result.type === "chunk") line += " (summary chunk)";
    line += " [score: " + result.score.toFixed(2) + "]";
    if (turn && turn.summary) {
      var summaryPreview = turn.summary.substring(0, 200);
      line += ": " + summaryPreview;
    }
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }

  return lines.join("\n");
}
