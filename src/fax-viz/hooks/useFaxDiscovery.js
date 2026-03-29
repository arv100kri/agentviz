import { useState, useEffect, useCallback } from "react";

/**
 * Poll /api/faxes for the list of fax bundles.
 * Returns { faxes, loading, error, refresh }.
 */
export default function useFaxDiscovery() {
  var _state = useState([]);
  var faxes = _state[0];
  var setFaxes = _state[1];

  var _loading = useState(true);
  var loading = _loading[0];
  var setLoading = _loading[1];

  var _error = useState(null);
  var error = _error[0];
  var setError = _error[1];

  var fetchFaxes = useCallback(function () {
    setLoading(true);
    fetch("/api/faxes")
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to fetch faxes: " + res.status);
        return res.json();
      })
      .then(function (data) {
        setFaxes(Array.isArray(data.faxes) ? data.faxes : []);
        setError(null);
      })
      .catch(function (err) {
        setError(err.message || String(err));
      })
      .finally(function () {
        setLoading(false);
      });
  }, []);

  useEffect(function () {
    fetchFaxes();
    // Poll every 30 seconds for new faxes
    var interval = setInterval(fetchFaxes, 30000);
    return function () { clearInterval(interval); };
  }, [fetchFaxes]);

  return { faxes: faxes, loading: loading, error: error, refresh: fetchFaxes };
}
