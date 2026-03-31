/**
 * FaxCache — local cache for remote fax source files.
 * Wraps a FaxSource and caches fetched files to os.tmpdir()/fax-viz-cache/.
 * Used with SharePointFaxSource to avoid re-downloading on repeat access.
 */

import fs from "fs";
import os from "os";
import path from "path";

var CACHE_DIR = path.join(os.tmpdir(), "fax-viz-cache");

function ensureCacheDir(bundleId) {
  var dir = path.join(CACHE_DIR, bundleId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getCachedFilePath(bundleId, fileName) {
  return path.join(CACHE_DIR, bundleId, fileName.replace(/[/\\]/g, "_"));
}

function readCached(bundleId, fileName) {
  var fp = getCachedFilePath(bundleId, fileName);
  try { return fs.readFileSync(fp, "utf8"); } catch (_) { return null; }
}

function writeCached(bundleId, fileName, content) {
  if (!content) return;
  ensureCacheDir(bundleId);
  var fp = getCachedFilePath(bundleId, fileName);
  try { fs.writeFileSync(fp, content, "utf8"); } catch (_) {}
}

export function createCachedFaxSource(innerSource) {
  if (!innerSource || innerSource.getSourceType() === "local") {
    return innerSource; // No caching needed for local sources
  }

  return {
    getSourceType: function () { return innerSource.getSourceType(); },
    updateToken: innerSource.updateToken || function () {},

    listBundles: function (skip, top) {
      return innerSource.listBundles(skip, top);
    },

    getManifest: async function (bundleId) {
      var cached = readCached(bundleId, "manifest.json");
      if (cached) {
        try { return JSON.parse(cached); } catch (_) {}
      }
      var manifest = await innerSource.getManifest(bundleId);
      if (manifest) writeCached(bundleId, "manifest.json", JSON.stringify(manifest));
      return manifest;
    },

    getFile: async function (bundleId, fileName) {
      var cached = readCached(bundleId, fileName);
      if (cached) return cached;
      var content = await innerSource.getFile(bundleId, fileName);
      if (content) writeCached(bundleId, fileName, content);
      return content;
    },

    streamFile: async function (bundleId, fileName) {
      // Check cache first — if cached, return a readable stream from disk
      var fp = getCachedFilePath(bundleId, fileName);
      try {
        fs.accessSync(fp);
        return fs.createReadStream(fp, { encoding: "utf8" });
      } catch (_) {}

      // Fetch from remote and tee to cache
      var stream = await innerSource.streamFile(bundleId, fileName);
      if (!stream) return null;

      // Write to cache while streaming
      ensureCacheDir(bundleId);
      var writeStream = fs.createWriteStream(fp, { encoding: "utf8" });
      var { Readable } = await import("stream");

      // For web ReadableStream (from fetch), convert to Node stream
      if (stream instanceof Readable) {
        stream.pipe(writeStream);
        return stream;
      }
      // Web ReadableStream — need to tee
      if (stream.tee) {
        var teed = stream.tee();
        // One branch goes to cache
        var cacheReader = teed[1].getReader();
        (async function () {
          try {
            while (true) {
              var result = await cacheReader.read();
              if (result.done) break;
              var chunk = typeof result.value === "string" ? result.value : new TextDecoder().decode(result.value);
              writeStream.write(chunk);
            }
            writeStream.end();
          } catch (_) { writeStream.end(); }
        })();
        // Other branch returned to caller as Node Readable
        return Readable.fromWeb(teed[0]);
      }

      return stream;
    },

    getMarkdownFiles: async function (bundleId) {
      var fileNames = ["handoff.md", "analysis.md", "decisions.md", "collab.md", "bootstrap-prompt.txt"];
      var results = [];
      for (var i = 0; i < fileNames.length; i++) {
        var content = await this.getFile(bundleId, fileNames[i]);
        if (content) results.push({ name: fileNames[i], content: content });
      }
      return results;
    },

    getBundlePath: function () { return null; },
    getFaxDir: function () { return null; },
  };
}
