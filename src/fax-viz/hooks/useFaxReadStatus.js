import { useState, useEffect, useCallback } from "react";

/**
 * Track read/unread status for fax bundles.
 * Persists via /api/fax-read-status server endpoint.
 */
export default function useFaxReadStatus() {
  var _state = useState({});
  var readStatus = _state[0];
  var setReadStatus = _state[1];

  useEffect(function () {
    fetch("/api/fax-read-status")
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data && typeof data === "object") setReadStatus(data);
      })
      .catch(function () {});
  }, []);

  var markRead = useCallback(function (folderName) {
    var now = new Date().toISOString();
    setReadStatus(function (prev) {
      var next = Object.assign({}, prev);
      next[folderName] = now;
      return next;
    });
    fetch("/api/fax-read-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderName: folderName, readAt: now }),
    }).catch(function () {});
  }, []);

  var isRead = useCallback(function (folderName) {
    return Boolean(readStatus[folderName]);
  }, [readStatus]);

  return { readStatus: readStatus, markRead: markRead, isRead: isRead };
}
