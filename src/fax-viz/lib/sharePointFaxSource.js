/**
 * SharePointFaxSource — reads fax bundles from SharePoint via Microsoft Graph API.
 * Implements the FaxSource interface for on-demand remote access.
 *
 * Requires: --graph-token and --site-id CLI args.
 * Uses Node 18+ built-in fetch() — no new dependencies.
 */

var GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function graphHeaders(token) {
  return { Authorization: "Bearer " + token, "Content-Type": "application/json" };
}

async function graphGet(token, urlPath) {
  var res = await fetch(GRAPH_BASE + urlPath, { headers: graphHeaders(token) });
  if (res.status === 401) throw Object.assign(new Error("Graph token expired"), { code: "TOKEN_EXPIRED" });
  if (!res.ok) throw new Error("Graph API error: " + res.status + " " + res.statusText);
  return res.json();
}

async function graphGetRaw(token, urlPath) {
  var res = await fetch(GRAPH_BASE + urlPath, { headers: graphHeaders(token) });
  if (res.status === 401) throw Object.assign(new Error("Graph token expired"), { code: "TOKEN_EXPIRED" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Graph API error: " + res.status);
  return res.text();
}

async function graphGetStream(token, urlPath) {
  var res = await fetch(GRAPH_BASE + urlPath, { headers: graphHeaders(token) });
  if (res.status === 401) throw Object.assign(new Error("Graph token expired"), { code: "TOKEN_EXPIRED" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Graph API error: " + res.status);
  return res.body;
}

export function createSharePointFaxSource(options) {
  var siteId = options.siteId;
  var drivePath = options.drivePath || "/Fax";
  var token = options.graphToken;
  if (!siteId || !token) throw new Error("SharePointFaxSource requires siteId and graphToken");

  // Drive item cache: bundleId -> { driveItemId, children: { fileName -> itemId } }
  var driveItemCache = {};
  var rootDriveItemId = null;

  function updateToken(newToken) {
    token = newToken;
  }

  async function ensureRootDriveItemId() {
    if (rootDriveItemId) return rootDriveItemId;
    var encodedPath = encodeURIComponent(drivePath.replace(/^\//, "")).replace(/%2F/g, "/");
    var data = await graphGet(token, "/sites/" + siteId + "/drive/root:/" + encodedPath);
    rootDriveItemId = data.id;
    return rootDriveItemId;
  }

  async function listChildFolders(skip, top) {
    var rootId = await ensureRootDriveItemId();
    var url = "/sites/" + siteId + "/drive/items/" + rootId + "/children" +
      "?$filter=folder ne null" +
      "&$orderby=lastModifiedDateTime desc" +
      "&$top=" + top +
      "&$skip=" + skip +
      "&$select=id,name,lastModifiedDateTime,folder";
    var data = await graphGet(token, url);
    return {
      items: data.value || [],
      nextLink: data["@odata.nextLink"] || null,
      count: data["@odata.count"] || null,
    };
  }

  async function getFileItemId(bundleId, fileName) {
    var cache = driveItemCache[bundleId];
    if (cache && cache.children && cache.children[fileName]) {
      return cache.children[fileName];
    }
    // Resolve via path
    var rootId = await ensureRootDriveItemId();
    var encodedPath = encodeURIComponent(bundleId + "/" + fileName);
    try {
      var data = await graphGet(token, "/sites/" + siteId + "/drive/items/" + rootId + ":/" + encodedPath);
      if (!driveItemCache[bundleId]) driveItemCache[bundleId] = { children: {} };
      driveItemCache[bundleId].children[fileName] = data.id;
      return data.id;
    } catch (_) {
      return null;
    }
  }

  async function fetchManifestForBundle(bundleId) {
    var content = await graphGetRaw(token,
      "/sites/" + siteId + "/drive/root:/" +
      encodeURIComponent(drivePath.replace(/^\//, "")).replace(/%2F/g, "/") +
      "/" + encodeURIComponent(bundleId) + "/manifest.json:/content"
    );
    if (!content) return null;
    try { return JSON.parse(content); } catch (_) { return null; }
  }

  // Batch-fetch manifests for up to 20 bundles at once
  async function batchFetchManifests(folderItems) {
    var manifests = {};
    // Graph $batch supports max 20 requests
    var batchSize = 20;
    for (var start = 0; start < folderItems.length; start += batchSize) {
      var chunk = folderItems.slice(start, start + batchSize);
      var requests = chunk.map(function (item, idx) {
        var encodedPath = encodeURIComponent(drivePath.replace(/^\//, "")).replace(/%2F/g, "/") +
          "/" + encodeURIComponent(item.name) + "/manifest.json:/content";
        return {
          id: String(start + idx),
          method: "GET",
          url: "/sites/" + siteId + "/drive/root:/" + encodedPath,
        };
      });

      try {
        var batchRes = await fetch(GRAPH_BASE + "/$batch", {
          method: "POST",
          headers: graphHeaders(token),
          body: JSON.stringify({ requests: requests }),
        });
        if (!batchRes.ok) {
          // Batch failed — fall back to individual requests
          for (var fi = 0; fi < chunk.length; fi++) {
            manifests[chunk[fi].name] = await fetchManifestForBundle(chunk[fi].name);
          }
          continue;
        }
        var batchData = await batchRes.json();
        var responses = batchData.responses || [];
        for (var ri = 0; ri < responses.length; ri++) {
          var resp = responses[ri];
          var itemIdx = parseInt(resp.id, 10);
          var folderItem = folderItems[itemIdx];
          if (folderItem && resp.status === 200 && resp.body) {
            try {
              manifests[folderItem.name] = typeof resp.body === "string" ? JSON.parse(resp.body) : resp.body;
            } catch (_) {
              manifests[folderItem.name] = null;
            }
          }
        }
      } catch (_) {
        // Batch request itself failed — individual fallback
        for (var fbi = 0; fbi < chunk.length; fbi++) {
          manifests[chunk[fbi].name] = await fetchManifestForBundle(chunk[fbi].name);
        }
      }
    }
    return manifests;
  }

  return {
    getSourceType: function () { return "sharepoint"; },
    updateToken: updateToken,

    listBundles: async function (skip, top) {
      var safeSkip = Math.max(0, skip || 0);
      var safeTop = Math.max(1, Math.min(top || 10, 100));
      var result = await listChildFolders(safeSkip, safeTop);
      var folders = result.items;

      // Batch-fetch manifests for all returned folders
      var manifests = await batchFetchManifests(folders);

      var bundles = [];
      for (var i = 0; i < folders.length; i++) {
        var folder = folders[i];
        var manifest = manifests[folder.name];
        if (!manifest) continue;

        var label = manifest.bundleLabel || folder.name.replace(/^fax-context-/, "").replace(/-\d{8}-\d{6}$/, "") || folder.name;
        var sharedArtifacts = Array.isArray(manifest.sharedArtifacts) ? manifest.sharedArtifacts : [];
        var artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];

        bundles.push({
          id: folder.name,
          folderName: folder.name,
          label: label,
          sender: manifest.sender || { alias: "Unknown", email: "", program: "", sessionId: "" },
          importance: manifest.importance || "normal",
          threadId: manifest.threadId || "",
          createdUtc: manifest.createdUtc || folder.lastModifiedDateTime || "",
          hasEvents: true, // Assume true for remote; confirmed on open
          artifactCount: artifacts.length,
          sharedArtifactCount: sharedArtifacts.length,
          git: manifest.git || null,
          progress: manifest.progress || null,
          bundlePath: null, // No local path for remote bundles
          sourceRoot: manifest.sourceRoot || null,
          driveItemId: folder.id,
        });
      }

      // Estimate total count from @odata.count or hasMore
      var totalCount = result.count || (result.nextLink ? safeSkip + safeTop + 1 : safeSkip + folders.length);
      return {
        bundles: bundles,
        totalCount: totalCount,
        hasMore: Boolean(result.nextLink) || folders.length === safeTop,
      };
    },

    getManifest: async function (bundleId) {
      return fetchManifestForBundle(bundleId);
    },

    getFile: async function (bundleId, fileName) {
      return graphGetRaw(token,
        "/sites/" + siteId + "/drive/root:/" +
        encodeURIComponent(drivePath.replace(/^\//, "")).replace(/%2F/g, "/") +
        "/" + encodeURIComponent(bundleId) + "/" + encodeURIComponent(fileName) + ":/content"
      );
    },

    streamFile: async function (bundleId, fileName) {
      return graphGetStream(token,
        "/sites/" + siteId + "/drive/root:/" +
        encodeURIComponent(drivePath.replace(/^\//, "")).replace(/%2F/g, "/") +
        "/" + encodeURIComponent(bundleId) + "/" + encodeURIComponent(fileName) + ":/content"
      );
    },

    getMarkdownFiles: async function (bundleId) {
      var fileNames = ["handoff.md", "analysis.md", "decisions.md", "collab.md", "bootstrap-prompt.txt"];
      var results = [];
      for (var i = 0; i < fileNames.length; i++) {
        try {
          var content = await graphGetRaw(token,
            "/sites/" + siteId + "/drive/root:/" +
            encodeURIComponent(drivePath.replace(/^\//, "")).replace(/%2F/g, "/") +
            "/" + encodeURIComponent(bundleId) + "/" + encodeURIComponent(fileNames[i]) + ":/content"
          );
          if (content) results.push({ name: fileNames[i], content: content });
        } catch (_) {}
      }
      return results;
    },

    getBundlePath: function () { return null; },
    getFaxDir: function () { return null; },
  };
}
