---
name: perf-check
description: "Measure load times, rendering performance, memory usage, and bundle size of the FAX-VIZ web application. Use when profiling page load, diagnosing rendering bottlenecks, checking for memory leaks, or auditing bundle size. Keywords: performance, FCP, load time, memory, bundle size, DOM complexity."
compatibility: "Requires Vite dev server on localhost:3001 and Playwright MCP browser tools"
---

# Performance Check

Measure load times, rendering performance, and memory usage of the FAX-VIZ web application to identify bottlenecks.

## Prerequisites

- The Vite dev server must be running on `http://localhost:3001` (start with `npm run dev` if not already running)
- You have access to Playwright MCP browser tools

## Evaluation Workflow

### Step 1: Initial Page Load
1. Navigate to `http://localhost:3001`
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

### Step 2: View Switching Performance
For each view tab in the observe shell, measure the time to switch:
1. Mark before clicking the tab
2. Wait for the view content to render
3. Mark after
4. Record the duration
5. **Thresholds**: < 100ms (good), < 300ms (acceptable), > 300ms (poor)

### Step 3: DOM Size Analysis
Check the DOM complexity for each view:
```javascript
(() => {
  return JSON.stringify({
    totalElements: document.querySelectorAll('*').length,
    maxDepth: (function getDepth(el) {
      if (!el.children.length) return 0;
      return 1 + Math.max(...Array.from(el.children).map(getDepth));
    })(document.documentElement),
  }, null, 2);
})();
```
- **Thresholds**: < 1500 elements (good), < 3000 (acceptable), > 3000 (needs virtualization review)

### Step 4: Memory Usage
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

### Step 5: Bundle Size Check
Examine the built assets:
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
2. **View Transitions**: Time per view switch, sorted slowest-first
3. **DOM Complexity**: Element count per view, flagging any over threshold
4. **Memory**: Heap size, any evidence of leaks
5. **Bundle Size**: Total JS/CSS transfer size
6. **Performance Score**: Overall rating (good/acceptable/poor)
7. **Bottlenecks**: Ranked list of performance issues to address
