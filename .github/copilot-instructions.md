# AGENTVIZ

Session replay visualizer for AI agent workflows (Claude Code, Copilot CLI).

## Stack
- React 18 + Vite 6, inline styles only, JetBrains Mono font
- Mixed JS/TS: components and hooks are plain JSX, parsers and data libs are TypeScript
- Design tokens in `src/lib/theme.js`

## Commands
```bash
npm run dev          # Dev server
npm run build        # Production build to dist/
npm test             # Run unit tests via Vitest
npm run test:watch   # Watch mode for unit tests
npm run test:e2e     # Run Playwright E2E tests
npm run typecheck    # tsc --noEmit
```

Before running `npm run test:e2e` for the first time, install Playwright browsers with `npx playwright install chromium`.

## Rules
- Search existing code before writing new abstractions.
- Run tests after every non-trivial change.
- After any UI change, run `npm run test:e2e` to verify views and interactions.
- Prefer editing existing files over creating new ones.
- Never silently apply config changes -- surface drafts first.
- Product name is always AGENTVIZ (all caps, no spaces). Never "AgentViz" or "Agentviz".
- All UI changes must conform to `docs/ui-ux-style-guide.md`. Review the checklist at the bottom of that file before approving any PR that touches components, styles, or visual behavior.

## Four-Artifact Sync Rule
Every UI change must update ALL FOUR of these before committing. Never let them drift:
1. `README.md` — feature descriptions, architecture section, file tree
2. `docs/ui-ux-style-guide.md` — token values, patterns, rules
3. `docs/screenshots/` — all 8 screenshots (see Screenshots section below)
4. Repo memory — store any new conventions with `store_memory`

## Screenshots
The README references 8 screenshot files in `docs/screenshots/`. All must be kept in sync.

**Files:** `landing.svg`, `session-hero.svg`, `replay-view.svg`, `tracks-view.svg`, `waterfall-view.svg`, `graph-view.svg`, `stats-view.svg`, `coach-view.svg`

**Workflow (using Playwright MCP tools):**
1. Start dev server: `npm run dev`
2. Navigate to `http://127.0.0.1:3000`, resize to **1400x860**
3. Capture `landing.png` from the landing page (before loading a session)
4. Click **"load a demo session"**, then click each tab and capture: replay, tracks, waterfall, graph, stats
5. For **Coach**: click the tab, hide the error banner with JS before capturing:
   ```js
   document.querySelectorAll('*').forEach(el => {
     if (el.children.length === 0 && el.textContent.trim().startsWith('AI analysis failed')) {
       let n = el;
       for (let i = 0; i < 6; i++) {
         if (n.parentElement?.textContent.trim().startsWith('AI analysis failed')) n = n.parentElement;
         else break;
       }
       n.style.display = 'none';
     }
   });
   ```
6. Copy `replay-view.png` → `session-hero.png` (hero reuses replay image)
7. Encode each PNG as base64 and wrap in SVG:
   ```bash
   b64=$(base64 -i file.png)
   echo "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" width=\"1400\" height=\"860\"><image href=\"data:image/png;base64,${b64}\" width=\"1400\" height=\"860\"/></svg>" > file.svg
   ```

**Note:** `session-hero.svg` is the hero image at the top of the README. It must always be regenerated alongside `replay-view.svg` — they use the same source image.

## MCP vs Dev Server
The MCP `launch_agentviz` tool serves the **production build** from `dist/` — NOT the dev server. Changes to source code are not reflected in MCP until `npm run build` is run. Always run `npm run build` before testing via MCP, and after any code change that the user will view via `open agentviz`.

## UX Testing

After any UI change, run `npm run test:e2e` to verify views load and interactions work. For deeper evaluation, invoke the appropriate skills:
- **ux-check** -- Functionality and ease-of-use evaluation (dynamic view discovery, interaction testing, UX quality reasoning)
- **a11y-check** -- Accessibility audit (axe-core, keyboard navigation, ARIA, contrast, focus rings)
- **perf-check** -- Performance profiling (load times, render speed, DOM size, memory usage)

The Playwright MCP server is configured in `.github/copilot/mcp.json` for agent-driven browser testing.

## Code Review Instructions

When reviewing pull requests, enforce these rules:

### Four-Artifact Sync Rule
If the PR adds or modifies files in `src/components/` or `src/lib/theme.js`:
- **New component or view**: `README.md` must document it (architecture section, file tree). If it is a new view/tab, `docs/screenshots/` must include a screenshot.
- **Theme changes**: `docs/ui-ux-style-guide.md` must reflect the new or changed tokens, patterns, or rules.
- **Modified component**: Only flag if the change alters user-visible behavior that the README describes incorrectly.

### Style and Convention Checks
- All styles must be inline (no CSS files). Colors must reference `src/lib/theme.js` tokens, not hardcoded hex values.
- Product name must be AGENTVIZ (all caps, no spaces). Flag any occurrence of "AgentViz", "Agentviz", or "Agent Viz".
- No em dashes in any content or comments.
- Components must receive data as props with no global state management.

### Test Coverage
- New utility functions in `src/lib/` should have corresponding tests in `src/__tests__/`.
- New views or significant UI changes should be covered by E2E tests in `e2e/` or at minimum verified by the existing dynamic tab discovery test.

## Document Authoring Autonomy

When working on long-form documents (markdown specs, design docs, research reports), you are authorized to make the following decisions WITHOUT asking for confirmation:

- **Move or re-order sections**: If a section logically belongs in an appendix, a different chapter, or a new file, move it and note the change in your summary.
- **Add external references**: When a claim references a known URL (GitHub pages, docs, marketplace), fetch the URL with `web_search` or `web_fetch`, extract the relevant fact, and inline the citation. Do not pause to ask "should I add a reference here?"
- **Propose then immediately draft**: When the human says "propose if X is a requirement" or "what do you think about Y?", write your recommendation AND a complete draft of the resulting section in the same turn. Do not stop at the proposal.
- **Create parallel sections**: If the human asks to "create a similar stream for X" (e.g. MCP server deploy stream), write the full new section modeled on the existing one without asking for a template or outline first.
- **Explore and summarize URLs proactively**: When the human provides URLs to investigate (e.g. `github.com/mcp`, `github.com/marketplace?category=ai-assisted`, `github.com/copilot/agents`), fetch and summarize ALL provided URLs in a single turn before writing any document section. Do not stop after the first URL.
