# FAX-VIZ

Fax context bundle viewer for AI agent workflows (Claude Code, Copilot CLI).

## Stack
- React 18 + Vite 6, inline styles only, JetBrains Mono font
- Mixed JS/TS: components and hooks are plain JSX, parsers and data libs are TypeScript
- Design tokens in `src/lib/theme.js`

## Commands
```bash
npm run dev          # Dev server on port 3001
npm run build        # Production build to dist-fax-viz/
npm run build:bundle # Standalone distributable bundle
npm test             # Run tests via Vitest
npm run test:watch   # Watch mode
npm run test:e2e     # Run Playwright E2E tests
npm run typecheck    # tsc --noEmit
```

## Rules
- Search existing code before writing new abstractions.
- Run tests after every non-trivial change.
- After any UI change, run `npm run test:e2e` to verify views and interactions.
- Prefer editing existing files over creating new ones.
- Never silently apply config changes -- surface drafts first.
- Product name is always FAX-VIZ (hyphenated, all caps). Never "FaxViz" or "Fax Viz".
- All UI changes must conform to `docs/ui-ux-style-guide.md`. Review the checklist at the bottom of that file before approving any PR that touches components, styles, or visual behavior.

## UX Testing

After any UI change, run `npm run test:e2e` to verify views load and interactions work. For deeper evaluation, invoke the appropriate skills:
- **ux-check** -- Functionality and ease-of-use evaluation (dynamic view discovery, interaction testing, UX quality reasoning)
- **a11y-check** -- Accessibility audit (axe-core, keyboard navigation, ARIA, contrast, focus rings)
- **perf-check** -- Performance profiling (load times, render speed, DOM size, memory usage)

The Playwright MCP server is configured in `.vscode/mcp.json` for agent-driven browser testing.

## Document Authoring Autonomy

When working on long-form documents (markdown specs, design docs, research reports), you are authorized to make the following decisions WITHOUT asking for confirmation:

- **Move or re-order sections**: If a section logically belongs in an appendix, a different chapter, or a new file, move it and note the change in your summary.
- **Add external references**: When a claim references a known URL (GitHub pages, docs, marketplace), fetch the URL with `web_search` or `web_fetch`, extract the relevant fact, and inline the citation. Do not pause to ask "should I add a reference here?"
- **Propose then immediately draft**: When the human says "propose if X is a requirement" or "what do you think about Y?", write your recommendation AND a complete draft of the resulting section in the same turn. Do not stop at the proposal.
- **Create parallel sections**: If the human asks to "create a similar stream for X", write the full new section modeled on the existing one without asking for a template or outline first.
- **Explore and summarize URLs proactively**: When the human provides URLs to investigate, fetch and summarize ALL provided URLs in a single turn before writing any document section. Do not stop after the first URL.
