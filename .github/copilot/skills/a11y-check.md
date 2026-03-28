# Accessibility Check -- WCAG Compliance Audit

You are performing an accessibility audit of the AGENTVIZ web application. Your goal is to identify accessibility barriers following WCAG 2.1 AA guidelines.

## Prerequisites

- The Vite dev server must be running on `http://localhost:3000` (start with `npm run dev` if not already running)
- You have access to Playwright MCP browser tools

## Evaluation Workflow

### Step 1: Automated Audit with axe-core
For each view in the app (load demo session first, then click each tab):

1. Inject and run axe-core by executing this in the browser console:
   ```javascript
   await (async () => {
     const script = document.createElement('script');
     script.src = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.0/axe.min.js';
     document.head.appendChild(script);
     await new Promise(r => script.onload = r);
     const results = await axe.run();
     return JSON.stringify({
       violations: results.violations.map(v => ({
         id: v.id,
         impact: v.impact,
         description: v.description,
         help: v.help,
         helpUrl: v.helpUrl,
         nodes: v.nodes.length
       })),
       passes: results.passes.length,
       incomplete: results.incomplete.length
     }, null, 2);
   })();
   ```
2. Record all violations with their severity (critical, serious, moderate, minor)

### Step 2: Keyboard Navigation Test
1. Start from the top of the page (landing or loaded session)
2. Press Tab repeatedly and observe:
   - Can you reach ALL interactive elements (buttons, inputs, links)?
   - Is the focus order logical (top-to-bottom, left-to-right)?
   - Is the focus indicator visible on every focused element?
   - Can you activate buttons with Enter/Space?
3. Test view-specific keyboard shortcuts:
   - Number keys 1-5 for view switching
   - `/` for search focus
   - `?` for shortcuts modal
   - `Cmd+K` / `Ctrl+K` for command palette
   - `Space` for play/pause
   - `Escape` to close modals/overlays

### Step 3: ARIA and Semantic HTML
Check for:
- All buttons have accessible names (text content or `aria-label`)
- All images/icons have alt text or `aria-hidden="true"`
- All form inputs have associated labels
- Landmarks are used appropriately (`<main>`, `<nav>`, `<header>`)
- Live regions for dynamic content updates (e.g., search results count)
- Modal dialogs trap focus correctly

### Step 4: Color and Contrast
1. Check text contrast ratios against WCAG AA minimums:
   - Normal text: 4.5:1 minimum
   - Large text (18px+ or 14px+ bold): 3:1 minimum
2. Verify information is not conveyed by color alone
   - Track types should have labels, not just colors
   - Error states should have icons/text, not just red
3. Test with the app's existing color tokens from `src/lib/theme.js`:
   - Primary text (#f0f0f2) on base bg (#000000): check ratio
   - Secondary text (#a1a1a8) on surface bg (#0f0f16): check ratio
   - Muted text (#717178) on surface bg (#0f0f16): check ratio

### Step 5: Reduced Motion
1. Check if the app respects `prefers-reduced-motion`:
   - The CSS in `index.html` has a `@media (prefers-reduced-motion)` query
   - Verify animations are disabled when this preference is set

## Output Format

Provide a structured report with:
1. **axe-core Results**: Violations per view, grouped by severity
2. **Keyboard Navigation**: Pass/fail with specific elements that are unreachable or have broken tab order
3. **ARIA Issues**: Missing labels, roles, or landmarks
4. **Contrast Issues**: Specific color pairs that fail WCAG AA
5. **Overall Score**: Percentage of checks passed
6. **Priority Fixes**: Ordered list of the most impactful issues to fix
