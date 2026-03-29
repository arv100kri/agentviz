import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReplyIntent,
  readReplyIntent,
  writeReplyIntent,
} from "../fax-viz/lib/faxReplyIntent.js";

describe("faxReplyIntent", function () {
  describe("buildReplyIntent", function () {
    it("builds intent from a valid manifest", function () {
      var manifest = {
        threadId: "thread-42",
        sender: { alias: "alice", email: "alice@example.com" },
      };
      var intent = buildReplyIntent(manifest, "fax-context-demo-20260401-100000");

      expect(intent.threadId).toBe("thread-42");
      expect(intent.parentFax).toBe("fax-context-demo-20260401-100000");
      expect(intent.parentSender).toBe("alice");
      expect(intent.pickedUpAt).toBeTruthy();
      // pickedUpAt should be a valid ISO date
      expect(new Date(intent.pickedUpAt).toISOString()).toBe(intent.pickedUpAt);
    });

    it("handles null manifest gracefully", function () {
      var intent = buildReplyIntent(null, "some-folder");

      expect(intent.threadId).toBe(null);
      expect(intent.parentFax).toBe("some-folder");
      expect(intent.parentSender).toBe(null);
      expect(intent.pickedUpAt).toBeTruthy();
    });

    it("handles empty manifest (no threadId, no sender)", function () {
      var intent = buildReplyIntent({}, null);

      expect(intent.threadId).toBe(null);
      expect(intent.parentFax).toBe(null);
      expect(intent.parentSender).toBe(null);
      expect(intent.pickedUpAt).toBeTruthy();
    });

    it("handles manifest with sender but no alias", function () {
      var manifest = {
        threadId: "t-99",
        sender: { email: "bob@example.com" },
      };
      var intent = buildReplyIntent(manifest, "fax-folder");

      expect(intent.threadId).toBe("t-99");
      expect(intent.parentSender).toBe(null);
    });
  });

  describe("writeReplyIntent / readReplyIntent roundtrip", function () {
    var tmpDir;

    it("writes and reads back the intent file", function () {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fax-reply-intent-test-"));
      var intent = {
        threadId: "thread-roundtrip",
        parentFax: "fax-context-test",
        parentSender: "charlie",
        pickedUpAt: new Date().toISOString(),
      };

      var written = writeReplyIntent(tmpDir, intent);
      expect(written).toEqual(intent);

      // Verify file exists
      var filePath = path.join(tmpDir, ".fax-reply-intent.json");
      expect(fs.existsSync(filePath)).toBe(true);

      // Read back
      var read = readReplyIntent(tmpDir);
      expect(read).toEqual(intent);

      // Clean up
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("readReplyIntent returns null when file does not exist", function () {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fax-reply-intent-empty-"));
      var result = readReplyIntent(tmpDir);
      expect(result).toBe(null);

      // Clean up
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
