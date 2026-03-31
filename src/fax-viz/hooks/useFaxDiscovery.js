import { useState, useEffect, useCallback, useRef } from "react";

/**
 * Poll /api/faxes for the list of fax bundles with pagination.
 * Returns { faxes, loading, error, refresh, loadMore, hasMore, totalCount }.
 */
export default function useFaxDiscovery() {
  var _faxes = useState([]);
  var faxes = _faxes[0];
  var setFaxes = _faxes[1];

  var _loading = useState(true);
  var loading = _loading[0];
  var setLoading = _loading[1];

  var _error = useState(null);
  var error = _error[0];
  var setError = _error[1];

  var _hasMore = useState(false);
  var hasMore = _hasMore[0];
  var setHasMore = _hasMore[1];

  var _totalCount = useState(0);
  var totalCount = _totalCount[0];
  var setTotalCount = _totalCount[1];

  var pageRef = useRef(1);
  var PAGE_SIZE = 50;

  var fetchPage = useCallback(function (page, append) {
    setLoading(true);
    fetch("/api/faxes?page=" + page + "&pageSize=" + PAGE_SIZE)
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to fetch faxes: " + res.status);
        return res.json();
      })
      .then(function (data) {
        var newFaxes = Array.isArray(data.faxes) ? data.faxes : [];
        if (append) {
          setFaxes(function (prev) { return prev.concat(newFaxes); });
        } else {
          setFaxes(newFaxes);
        }
        if (data.pagination) {
          setHasMore(Boolean(data.pagination.hasMore));
          setTotalCount(data.pagination.totalCount || 0);
        }
        setError(null);
      })
      .catch(function (err) {
        setError(err.message || String(err));
      })
      .finally(function () {
        setLoading(false);
      });
  }, []);

  var refresh = useCallback(function () {
    pageRef.current = 1;
    fetchPage(1, false);
  }, [fetchPage]);

  var loadMore = useCallback(function () {
    if (!hasMore || loading) return;
    pageRef.current += 1;
    fetchPage(pageRef.current, true);
  }, [hasMore, loading, fetchPage]);

  useEffect(function () {
    fetchPage(1, false);
    var interval = setInterval(function () { fetchPage(1, false); }, 30000);
    return function () { clearInterval(interval); };
  }, [fetchPage]);

  return { faxes: faxes, loading: loading, error: error, refresh: refresh, loadMore: loadMore, hasMore: hasMore, totalCount: totalCount };
}
