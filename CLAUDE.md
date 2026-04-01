# FAX-VIZ

Fax context bundle viewer for AI agent workflows. Browse, review, and pick up fax context bundles shared between agent sessions, with full session replay, tracks, stats, and AI-powered Q&A.

## Stack
- React 18 + Vite 6, inline styles only, JetBrains Mono font
- Mixed JS/TS: components and hooks are plain JSX, parsers and data libs are TypeScript
- Design tokens in `src/lib/theme.js`

## Architecture
```
src/
  fax-viz/
    FaxApp.jsx             # Main app with inbox and observe views
    main.jsx               # React entry point with error boundary
    components/
      FaxInboxView.jsx     # Fax bundle inbox with Pick Up buttons
      FaxObserveShell.jsx  # Observe view with header and session replay
      FaxQADrawer.jsx      # Q&A sidebar for fax context
      PickUpModal.jsx      # Pick Up modal with tool selector and session picker
    hooks/
      useFaxDiscovery.js   # Polls /api/faxes for bundle list
      useFaxReadStatus.js  # Read/unread status tracking
    lib/
      faxConstants.js      # Port, importance colors, sort options
      faxReplyIntent.js    # Reply intent file read/write
      faxTypes.ts          # TypeScript types for fax manifests
      threadStore.js       # Thread metadata store
  hooks/
    usePlayback.js         # Playback state: time, playing, speed, seek, playPause
    useSearch.js           # Debounced search with matchSet/matchedEntries
    useKeyboardShortcuts.js # Centralized keyboard handler (ref-based, stable listener)
    usePersistentState.js  # localStorage-backed useState with debounced writes
    useSessionQA.js        # Session Q&A conversation state, persistence, and streaming
  lib/
    theme.js               # Design token system, TRACK_TYPES, AGENT_COLORS
    parseSession.ts        # Auto-detect format router: detectFormat() + parseSession()
    parser.ts              # parseClaudeCodeJSONL() - Claude Code JSONL parser
    copilotCliParser.ts    # parseCopilotCliJSONL() - Copilot CLI JSONL parser
    session.ts             # Pure helpers: getSessionTotal, buildFilteredEventEntries, buildTurnStartMap
    sessionTypes.ts        # TypeScript type definitions for session data
    sessionParsing.ts      # Session parsing utilities and types
    replayLayout.js        # Estimated layout + binary search windowing for virtualized replay
    diffUtils.js           # Diff detection (isFileEditEvent) + Myers line diff algorithm
    pricing.js             # Claude model pricing table and cost estimation
    dataInspector.js       # Payload summary and preview helpers for inspector panels
    formatTime.js          # Duration and date formatting utilities
    playbackUtils.js       # Playback state helpers
    qaClassifier.js        # Question classification for Q&A routing
    autonomyMetrics.js     # Session autonomy scoring
    sessionQA.js           # Session Q&A helpers: context building, routing, chunk scoring
    sessionQAServer.js     # Q&A server utilities (precompute, cache, history)
    sessionQAPipeline.js   # Shared Q&A pipeline for fax-viz-server.js
    sessionQAEndpoints.js  # Q&A endpoint handlers: readBody, cache, SSE
    sessionQAFactStore.js  # SQLite fact store for deterministic Q&A lookups
    sessionSearchIndex.js  # lunr.js full-text search index for Q&A retrieval
  components/
    ReplayView.jsx         # Windowed event stream + resizable inspector sidebar
    TracksView.jsx         # DAW-style multi-track lanes with solo/mute
    StatsView.jsx          # Aggregate metrics, tool ranking, turn summary
    QAView.jsx             # AI-powered Session Q&A panel with suggested questions
    Timeline.jsx           # Scrubable playback bar with event markers, turn boundaries
    DiffViewer.jsx         # Inline unified diff view for file-editing tool calls
    DataInspector.jsx      # Readable payload inspector with summaries and copy support
    SyntaxHighlight.jsx    # Lightweight code syntax coloring for raw data
    ResizablePanel.jsx     # Drag-to-resize split panel utility
    ErrorBoundary.jsx      # React error boundary with resetKey for recovery
    Icon.jsx               # Lucide icon wrapper
    ui/
      ToolbarButton.jsx    # Toolbar button component
bin/
  fax-viz.js               # CLI entry point: starts server, opens browser
fax-viz-server.js          # HTTP server: fax discovery, session events, Q&A
esbuild.fax-viz.mjs        # Bundle builder for standalone distribution
```

## Key data types

Normalized event (output of parser, consumed by all views):
```
{ t, agent, track, text, duration, intensity, toolName?, toolInput?, raw, turnIndex, isError, model?, tokenUsage? }
```

Turn (groups events by user-initiated conversation rounds):
```
{ index, startTime, endTime, eventIndices, userMessage, toolCount, hasError }
```

Session metadata (aggregate stats):
```
{ totalEvents, totalTurns, totalToolCalls, errorCount, duration, models, primaryModel, tokenUsage }
```

Parser returns: `{ events, turns, metadata }` or null

Track types: reasoning, tool_call, context, output
Agent types: user, assistant, system

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

For full functionality in dev mode, run BOTH `node bin/fax-viz.js --fax-dir <path>` and `npm run dev`.
Vite proxies `/api/*` to the backend automatically.

## Rules
- Search existing code before writing new abstractions.
- Run tests after every non-trivial change.
- After any UI change, run `npm run test:e2e` to verify views and interactions.
- Prefer editing existing files over creating new ones.
- Never silently apply config changes -- surface drafts first.
- Product name is always FAX-VIZ (hyphenated, all caps). Never "FaxViz" or "Fax Viz".
- All UI changes must conform to `docs/ui-ux-style-guide.md`. Review the checklist at the bottom of that file before approving any PR that touches components, styles, or visual behavior.

## Conventions
- No em dashes in any content or comments
- All styles are inline (no CSS files), all colors reference theme.js tokens
- Unicode characters used directly or as escape sequences in JS
- Components receive data as props, no global state management
- Design tokens defined in src/lib/theme.js
- UI/UX design system: see docs/ui-ux-style-guide.md -- all UI changes must conform to it

## Document Authoring Autonomy

When working on long-form documents (markdown specs, design docs, research reports), you are authorized to make the following decisions WITHOUT asking for confirmation:

- **Move or re-order sections**: If a section logically belongs in an appendix, a different chapter, or a new file, move it and note the change in your summary.
- **Add external references**: When a claim references a known URL (GitHub pages, docs, marketplace), fetch the URL with `web_search` or `web_fetch`, extract the relevant fact, and inline the citation. Do not pause to ask "should I add a reference here?"
- **Propose then immediately draft**: When the human says "propose if X is a requirement" or "what do you think about Y?", write your recommendation AND a complete draft of the resulting section in the same turn. Do not stop at the proposal.
- **Create parallel sections**: If the human asks to "create a similar stream for X", write the full new section modeled on the existing one without asking for a template or outline first.
- **Explore and summarize URLs proactively**: When the human provides URLs to investigate, fetch and summarize ALL provided URLs in a single turn before writing any document section. Do not stop after the first URL.
