/**
 * LocalFaxSource — reads fax bundles from a local directory (--fax-dir).
 * Implements the FaxSource interface for filesystem-backed fax bundles.
 */

import fs from "fs";
import path from "path";

var MARKDOWN_FILES = ["handoff.md", "analysis.md", "decisions.md", "collab.md"];
var TEXT_FILES = ["bootstrap-prompt.txt"];

function parseManifest(bundlePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(bundlePath, "manifest.json"), "utf8"));
  } catch (_) {
    return null;
  }
}

function buildBundleEntry(folderName, bundlePath, manifest) {
  var hasEvents = false;
  try { fs.accessSync(path.join(bundlePath, "events.jsonl")); hasEvents = true; } catch (_) {}

  var label = manifest.bundleLabel || folderName.replace(/^fax-context-/, "").replace(/-\d{8}-\d{6}$/, "") || folderName;
  var sharedArtifacts = Array.isArray(manifest.sharedArtifacts) ? manifest.sharedArtifacts : [];
  var artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];

  return {
    id: folderName,
    folderName: folderName,
    label: label,
    sender: manifest.sender || { alias: "Unknown", email: "", program: "", sessionId: "" },
    importance: manifest.importance || "normal",
    threadId: manifest.threadId || "",
    createdUtc: manifest.createdUtc || "",
    hasEvents: hasEvents,
    artifactCount: artifacts.length,
    sharedArtifactCount: sharedArtifacts.length,
    git: manifest.git || null,
    progress: manifest.progress || null,
    bundlePath: bundlePath,
    sourceRoot: manifest.sourceRoot || null,
  };
}

export function createLocalFaxSource(options) {
  var faxDir = options.faxDir;
  if (!faxDir) throw new Error("LocalFaxSource requires faxDir");

  // Cache the full bundle list (refreshed on each listBundles call)
  var cachedBundles = null;

  function discoverAll() {
    var results = [];
    var entries;
    try { entries = fs.readdirSync(faxDir, { withFileTypes: true }); } catch (_) { return results; }

    for (var i = 0; i < entries.length; i++) {
      if (!entries[i].isDirectory()) continue;
      var folderName = entries[i].name;
      var bundlePath = path.join(faxDir, folderName);
      var manifest = parseManifest(bundlePath);
      if (!manifest) continue;
      results.push(buildBundleEntry(folderName, bundlePath, manifest));
    }

    results.sort(function (a, b) {
      return (b.createdUtc || "").localeCompare(a.createdUtc || "");
    });
    return results;
  }

  function resolveBundlePath(bundleId) {
    var resolved = path.join(faxDir, bundleId);
    if (!resolved.startsWith(faxDir)) return null;
    return resolved;
  }

  return {
    getSourceType: function () { return "local"; },

    listBundles: async function (skip, top) {
      cachedBundles = discoverAll();
      var total = cachedBundles.length;
      var safeSkip = Math.max(0, skip || 0);
      var safeTop = Math.max(1, Math.min(top || 10, 100));
      var page = cachedBundles.slice(safeSkip, safeSkip + safeTop);
      return { bundles: page, totalCount: total, hasMore: safeSkip + safeTop < total };
    },

    getManifest: async function (bundleId) {
      var bp = resolveBundlePath(bundleId);
      if (!bp) return null;
      return parseManifest(bp);
    },

    getFile: async function (bundleId, fileName) {
      var bp = resolveBundlePath(bundleId);
      if (!bp) return null;
      var filePath = path.join(bp, fileName);
      if (!filePath.startsWith(bp)) return null;
      try { return fs.readFileSync(filePath, "utf8"); } catch (_) { return null; }
    },

    streamFile: async function (bundleId, fileName) {
      var bp = resolveBundlePath(bundleId);
      if (!bp) return null;
      var filePath = path.join(bp, fileName);
      if (!filePath.startsWith(bp)) return null;
      try { fs.accessSync(filePath); } catch (_) { return null; }
      return fs.createReadStream(filePath, { encoding: "utf8" });
    },

    getMarkdownFiles: async function (bundleId) {
      var bp = resolveBundlePath(bundleId);
      if (!bp) return [];
      var result = [];
      var allFiles = MARKDOWN_FILES.concat(TEXT_FILES);
      for (var i = 0; i < allFiles.length; i++) {
        try {
          var content = fs.readFileSync(path.join(bp, allFiles[i]), "utf8");
          result.push({ name: allFiles[i], content: content });
        } catch (_) {}
      }
      return result;
    },

    getBundlePath: function (bundleId) {
      return resolveBundlePath(bundleId);
    },

    getFaxDir: function () { return faxDir; },
  };
}
