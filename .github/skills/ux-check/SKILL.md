---
name: ux-check
description: "Evaluate the FAX-VIZ web application for functionality and ease of use. Use when performing UX audits, testing UI interactions, or assessing discoverability and visual quality. Keywords: UX, usability, UI testing, accessibility, screenshots."
compatibility: "Requires Vite dev server on localhost:3001 and Playwright MCP browser tools"
---

# UX Check

Perform a UX evaluation of the FAX-VIZ web application, assessing both **functionality** (does everything work?) and **ease of use** (is it intuitive and discoverable?).

## Prerequisites

- The Vite dev server must be running on `http://localhost:3001` (start with `npm run dev` if not already running)
- You have access to Playwright MCP browser tools

## Evaluation Workflow

### Step 1: Load the App
1. Navigate to `http://localhost:3001`
2. Take a screenshot of the inbox page
3. Verify the inbox page renders correctly: brand visible, fax list or empty state present

### Step 2: Test Inbox Interactions
1. Check for search input, sort controls, and importance filter
2. Test search filtering if fax bundles are present
3. Test sort order switching
4. Test importance filter dropdown

### Step 3: Discover and Test All Views
If fax bundles are available:
1. Click a fax to open the observe view
2. Find all navigation tab buttons in the header (they use class `av-btn`)
3. For EACH discovered tab:
   a. Click the tab
   b. Wait for the view to render (500ms)
   c. Take a screenshot
   d. Check for visible error messages or empty states
   e. Note what content is shown and whether it appears functional

### Step 4: Test Key Interactions
For each applicable view, test:
- **Search** (views: Replay, Tracks): Type in the search input, verify results filter
- **Play/Pause**: Click the play button, verify it toggles
- **Timeline**: Click on the timeline bar to seek to a different position
- **Inspector**: In Replay view, click on an event entry to see if a detail panel opens
- **Back navigation**: Press Escape to return to inbox

### Step 5: UX Quality Assessment
Evaluate the following dimensions:
- **Discoverability**: Can a new user figure out what to do without instructions?
- **Visual hierarchy**: Is the most important content prominent?
- **Feedback**: Does the UI provide clear feedback for actions (loading states, active tabs, hover states)?
- **Consistency**: Do similar elements behave consistently across views?
- **Error handling**: Are error states communicated clearly?
- **Navigation flow**: Is it easy to switch between views and find information?

## Output Format

Provide a structured report with:
1. **Screenshots**: One per view discovered
2. **Functionality**: Pass/fail for each interaction tested
3. **UX Assessment**: Rating (good/needs-improvement/poor) for each quality dimension
4. **Issues Found**: List of specific problems with severity (critical/moderate/minor)
5. **Recommendations**: Actionable suggestions for improvement
