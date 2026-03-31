/**
 * FaxSource interface contract.
 *
 * Two implementations:
 *   - LocalFaxSource  (reads from --fax-dir filesystem)
 *   - SharePointFaxSource (reads from SharePoint via Graph API)
 *
 * All methods are async to support both local and remote sources.
 *
 * Interface:
 *   listBundles(skip, top)          -> { bundles: [...], totalCount, hasMore }
 *   getManifest(bundleId)           -> manifest object or null
 *   getFile(bundleId, fileName)     -> string content or null
 *   streamFile(bundleId, fileName)  -> readable stream or null
 *   getMarkdownFiles(bundleId)      -> [{ name, content }]
 *   getBundlePath(bundleId)         -> string path (local) or null (remote)
 *   getSourceType()                 -> "local" | "sharepoint"
 */

export function createFaxSource(options) {
  if (options.graphToken && options.siteId) {
    // Lazy import to avoid loading Graph code when not needed
    return import("./sharePointFaxSource.js").then(function (mod) {
      return mod.createSharePointFaxSource(options);
    });
  }
  return import("./localFaxSource.js").then(function (mod) {
    return mod.createLocalFaxSource(options);
  });
}
