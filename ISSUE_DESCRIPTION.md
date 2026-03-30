# Improve Session Q&A: instant answers, persistent history, better context

## Problem

The Session Q&A drawer (shipped in #27) has 9 instant answer patterns with Copilot SDK model fallback. Users report:
- Slow responses (30s timeout too aggressive, domain questions often fail)
- No answer persistence (Q&A history lost on navigation)
- No progress feedback during model calls (blank spinner)
- Limited instant coverage (most questions fall through to the model)
- Model answers lack session-specific detail for large sessions

## Proposed improvements

### Performance
- Expand instant classifier from 9 to 20 patterns (files, commands, turn ranges, tool details, etc.)
- Question-aware context windowing (send relevant data, not generic top-20)
- Paraphrase-aware answer caching (rephrased questions get cached answers)
- Precomputed session index with tool index + chunk summaries for full-session context
- Domain keyword search across all tool calls for targeted evidence
- 60s timeout (up from 30s)

### UX
- Answer timing display (instant/cached/model with elapsed time)
- Persistent Q&A history (localStorage, survives navigation)
- Green animated thinking bubble while waiting for model
- Streaming word-by-word (split full responses into progressive tokens)
- Stop button to abort mid-stream
- Markdown rendering (lists, tables, headers, bold, code, turn links)
- Keyboard polish (up-arrow recalls last question)
- Graceful truncation on timeout (keep partial answer with note)

### Answer quality
- Improved system prompt (cite turns, markdown format, no speculation)
- Clean tool input extraction (actual query text, not raw JSON)
- Readable model context format (human-readable evidence lines)
- Prioritize relevant events over timeline summaries in prompt
- Session rotation with recap after 6 model questions

## Constraints
- Zero new npm dependencies
- No changes to drawer UI form factor
