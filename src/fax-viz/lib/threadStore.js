/**
 * Thread store helpers for fax-viz.
 * Reads/watches/updates threads.json (managed by the dev-fax plugin).
 * Uses atomic rename for safe concurrent writes.
 */

import fs from "fs";
import path from "path";

/**
 * Create a thread store manager.
 * @param {string} threadsFilePath - absolute path to threads.json
 * @returns thread store API
 */
export function createThreadStore(threadsFilePath) {
  if (!threadsFilePath) return null;

  var filePath = path.resolve(threadsFilePath);
  var cached = readFromDisk();
  var watchCleanup = null;

  function readFromDisk() {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (_) {
      return { threads: {} };
    }
  }

  function atomicWrite(data) {
    var dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    var tmpPath = filePath + "." + Date.now() + ".tmp";
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
    cached = data;
  }

  // Start watching for external changes
  function startWatching() {
    try {
      fs.watchFile(filePath, { interval: 2000 }, function () {
        cached = readFromDisk();
      });
      watchCleanup = function () { fs.unwatchFile(filePath); };
    } catch (_) {}
  }

  startWatching();

  return {
    /** Get cached thread data (hot-reloaded via watchFile) */
    getData: function () { return cached; },

    /** Reload from disk immediately */
    reload: function () { cached = readFromDisk(); return cached; },

    /** Read-merge-write with atomic rename */
    update: function (mutator) {
      var current = readFromDisk();
      mutator(current);
      atomicWrite(current);
    },

    /** Find thread containing a bundleId */
    findThreadByBundle: function (bundleId) {
      var threads = cached && cached.threads ? cached.threads : {};
      var threadIds = Object.keys(threads);
      for (var i = 0; i < threadIds.length; i++) {
        var thread = threads[threadIds[i]];
        var entries = Array.isArray(thread.entries) ? thread.entries : [];
        for (var j = 0; j < entries.length; j++) {
          if (entries[j].bundleId === bundleId) {
            return { threadId: threadIds[i], thread: thread, entryIndex: j };
          }
        }
      }
      return null;
    },

    /** Get all external bundle locations (outside faxDir) */
    getExternalBundles: function (faxDir) {
      var external = [];
      var threads = cached && cached.threads ? cached.threads : {};
      var threadIds = Object.keys(threads);
      for (var i = 0; i < threadIds.length; i++) {
        var thread = threads[threadIds[i]];
        var entries = Array.isArray(thread.entries) ? thread.entries : [];
        for (var j = 0; j < entries.length; j++) {
          var entry = entries[j];
          if (entry.location) {
            var resolved = path.resolve(entry.location);
            if (!faxDir || !resolved.startsWith(faxDir)) {
              external.push({
                bundleId: entry.bundleId,
                location: resolved,
                threadId: threadIds[i],
                entry: entry,
              });
            }
          }
        }
      }
      return external;
    },

    /** Build a bundleId -> resolvedPath map from threads.json */
    buildLocationMap: function () {
      var map = {};
      var threads = cached && cached.threads ? cached.threads : {};
      var threadIds = Object.keys(threads);
      for (var i = 0; i < threadIds.length; i++) {
        var entries = threads[threadIds[i]].entries || [];
        for (var j = 0; j < entries.length; j++) {
          if (entries[j].location && entries[j].bundleId) {
            map[entries[j].bundleId] = path.resolve(entries[j].location);
          }
        }
      }
      return map;
    },

    /** Augment a fax list entry with thread metadata */
    augmentFax: function (fax) {
      var match = this.findThreadByBundle(fax.id || fax.folderName);
      if (!match) return fax;
      var thread = match.thread;
      var entry = thread.entries[match.entryIndex];
      fax.threadId = fax.threadId || match.threadId;
      fax.threadEntryCount = thread.entries.length;
      fax.threadSubject = thread.subject || fax.label || "";
      fax.direction = entry ? entry.direction || null : null;
      fax.threadPickedUp = Boolean(thread.pickedUp);
      fax.threadReplied = Boolean(thread.replied);
      return fax;
    },

    /** Stop watching */
    close: function () {
      if (watchCleanup) watchCleanup();
    },
  };
}
