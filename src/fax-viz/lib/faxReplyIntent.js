/**
 * Read/write helpers for .fax-reply-intent.json.
 * Written to the SharePoint fax folder root (parent of fax-context-* bundles).
 */

import fs from "fs";
import path from "path";

export function buildReplyIntent(manifest, faxFolderName) {
  return {
    threadId: manifest && manifest.threadId ? String(manifest.threadId) : null,
    parentFax: faxFolderName || null,
    parentSender: manifest && manifest.sender && manifest.sender.alias ? String(manifest.sender.alias) : null,
    pickedUpAt: new Date().toISOString(),
  };
}

export function readReplyIntent(faxDirRoot) {
  // faxDirRoot is the SharePoint fax folder (parent of fax-context-* folders)
  var filePath = path.join(faxDirRoot, ".fax-reply-intent.json");
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    return null;
  }
}

export function writeReplyIntent(faxDirRoot, intent) {
  var filePath = path.join(faxDirRoot, ".fax-reply-intent.json");
  fs.writeFileSync(filePath, JSON.stringify(intent, null, 2), "utf8");
  return intent;
}
