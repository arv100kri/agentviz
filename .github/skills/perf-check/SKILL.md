---
name: perf-check
description: "Measure load times, rendering performance, memory usage, and bundle size of the AGENTVIZ web application. Use when profiling page load, diagnosing rendering bottlenecks, checking for memory leaks, or auditing bundle size. Keywords: performance, FCP, load time, memory, bundle size, DOM complexity."
compatibility: "Requires Vite dev server on localhost:3000 and Playwright MCP browser tools"
---

# Performance Check

Measure load times, rendering performance, and memory usage of the AGENTVIZ web application to identify bottlenecks.

## Prerequisites

- The Vite dev server must be running on `http://localhost:3000` (start with `npm run dev` if not already running)
- You have access to Playwright MCP browser tools

## Evaluation Workflow

### Step 1: Initial Page Load
1. Navigate to `http://localhost:3000`
2. Measure page load using the Performance API:
   ```javascript
   (() => {
     const nav = performance.getEntriesByType('navigation')[0];
     const paint = performance.getEntriesByType('paint');
     return JSON.stringify({
       domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
       loadComplete: Math.round(nav.loadEventEnd - nav.startTime),
       firstPaint: paint.find(p => p.name === 'first-paint')?.startTime,
       firstContentfulPaint: paint.find(p => p.name === 'first-contentful-paint')?.startTime,
       transferSize: Math.round(nav.transferSize / 1024) + 'KB',
     }, null, 2);
   })();
   ```
3. **Thresholds**: FCP < 1.5s (good), < 2.5s (acceptable), > 2.5s (poor)

### Step 2: Demo Session Load Performance
1. Mark the start time before clicking "load a demo session"
2. Click the button and measure time until tabs become visible:
   ```javascript
   performance.mark('session-load-start');
   // ... after session loads:
   performance.mark('session-load-end');
   performance.measure('session-load', 'session-load-start', 'session-load-end');
   const measure = performance.getEntriesByName('session-load')[0];
   measure.duration; // in ms
   ```
3. **Thresholds**: < 500ms (good), < 1s (acceptable), > 1s (poor)

### Step 3: View Switching Performance
For each view tab, measure the time to switch:
1. Mark before clicking the tab
2. Wait for the view content to render
3. Mark after
4. Record the duration
5. **Thresholds**: < 100ms (good), < 300ms (acceptable), > 300ms (poor)

Special attention to:
- **Graph view**: Uses ELKjs for DAG layout, may be slow on large sessions
- **Waterfall view**: Has virtualized rendering, should be fast

### Step 4: DOM Size Analysis
Check the DOM complexity for each view:
```javascript
(() => {
  return JSON.stringify({
    totalElements: document.querySelectorAll('*').length,
    maxDepth: (function getDepth(el) {
      if (!el.children.length) return 0;
      return 1 + Math.max(...Array.from(el.children).map(getDepth));
    })(document.documentElement),
    totalTextNodes: document.createTreeWalker(
      document.body, NodeFilter.SHOW_TEXT
    ).nextNode() ? 'present' : 'none',
  }, null, 2);
})();
```
- **Thresholds**: < 1500 elements (good), < 3000 (acceptable), > 3000 (needs virtualization review)

### Step 5: Memory Usage
1. If available, check JavaScript heap size:
   ```javascript
   (() => {
     if (performance.memory) {
       return JSON.stringify({
         usedJSHeapSize: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024) + 'MB',
         totalJSHeapSize: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024) + 'MB',
         jsHeapSizeLimit: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024) + 'MB',
       }, null, 2);
     }
     return 'performance.memory not available (non-Chromium or secure context)';
   })();
   ```
2. Navigate between views multiple times and check if memory grows (potential leak)
3. **Thresholds**: < 50MB (good), < 100MB (acceptable), > 100MB (investigate)

### Step 6: Bundle Size Check
Examine the built assets:
1. Look at the network resources loaded:
   ```javascript
   (() => {
     const resources = performance.getEntriesByType('resource');
     const scripts = resources.filter(r => r.name.endsWith('.js') || r.name.includes('.js?'));
     const styles = resources.filter(r => r.name.endsWith('.css'));
     return JSON.stringify({
       totalResources: resources.length,
       scripts: scripts.map(s => ({
         name: s.name.split('/').pop(),
         size: Math.round(s.transferSize / 1024) + 'KB',
         duration: Math.round(s.duration) + 'ms',
       })),
       totalScriptSize: Math.round(scripts.reduce((a, s) => a + s.transferSize, 0) / 1024) + 'KB',
       styles: styles.length,
     }, null, 2);
   })();
   ```

## Output Format

Provide a structured report with:
1. **Load Metrics**: FCP, DOMContentLoaded, full load time with pass/fail
2. **Session Load**: Time to parse and render the demo session
3. **View Transitions**: Time per view switch, sorted slowest-first
4. **DOM Complexity**: Element count per view, flagging any over threshold
5. **Memory**: Heap size, any evidence of leaks
6. **Bundle Size**: Total JS/CSS transfer size
7. **Performance Score**: Overall rating (good/acceptable/poor)
8. **Bottlenecks**: Ranked list of performance issues to address
