// Pure search matching helpers extracted from useSearch.js.
// These are stateless functions that can be tested without a DOM.

// Returns true if an event entry matches the given lowercase query string.
export function eventMatchesQuery(entry, lowerQuery) {
  var ev = entry.event;
  return (
    (ev.text && ev.text.toLowerCase().includes(lowerQuery)) ||
    (ev.toolName && ev.toolName.toLowerCase().includes(lowerQuery)) ||
    (ev.agent && ev.agent.toLowerCase().includes(lowerQuery))
  );
}

// Filters an array of event entries to those matching query.
// Returns [] when query is empty or falsy.
export function filterEventEntries(entries, query) {
  if (!entries || !query) return [];
  var lowerQuery = query.toLowerCase();
  var matches = [];
  for (var i = 0; i < entries.length; i++) {
    if (eventMatchesQuery(entries[i], lowerQuery)) matches.push(entries[i]);
  }
  return matches;
}

// Clamps a playback time value to [0, total].
export function clampTime(time, total) {
  return Math.max(0, Math.min(total, time));
}

/**
 * Find the next or previous entry relative to the current playback time.
 * Returns the target time, or null if entries is empty.
 * Wraps around when reaching the end/start.
 */
export function findJumpTarget(entries, currentTime, direction) {
  if (!entries || entries.length === 0) return null;

  if (direction === "next") {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].event.t > currentTime + 0.1) {
        return entries[i].event.t;
      }
    }
    return entries[0].event.t;
  }

  for (var j = entries.length - 1; j >= 0; j--) {
    if (entries[j].event.t < currentTime - 0.1) {
      return entries[j].event.t;
    }
  }
  return entries[entries.length - 1].event.t;
}

/**
 * Get the next speed in a speed list, cycling back to the start.
 */
export function nextSpeed(speeds, currentSpeed) {
  var idx = speeds.indexOf(currentSpeed);
  return speeds[(idx + 1) % speeds.length];
}

/**
 * Toggle a track filter key in a filters object. Returns a new object.
 */
export function toggleFilter(filters, key) {
  var next = Object.assign({}, filters);
  if (next[key]) {
    delete next[key];
  } else {
    next[key] = true;
  }
  return next;
}

/**
 * Focus a search input ref if it's visible. Returns true if focused.
 */
export function focusSearchInput(ref) {
  var el = ref && ref.current;
  if (el && el.offsetParent !== null) {
    el.focus();
    return true;
  }
  return false;
}
