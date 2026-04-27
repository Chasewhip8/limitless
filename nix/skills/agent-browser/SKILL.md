---
name: agent-browser
description: Browser automation via the agent-browser CLI. Navigate pages, interact with elements, take screenshots, and extract content from live browser sessions. Use for web verification, scraping, form filling, and end-to-end testing.
---

# Agent Browser

Use this skill when automating browser interactions via the `agent-browser` CLI.

## When to Use

- Navigating to URLs and verifying page content
- Clicking, filling forms, selecting options, uploading files
- Taking screenshots or generating PDFs
- Extracting text, attributes, or accessibility snapshots from pages
- Running multi-step browser workflows (batch mode)
- Streaming or recording browser sessions

## Required Workflow

1. Open a page with `agent-browser open <url>`.
2. Inspect the page with `snapshot` or `get` before interacting.
3. Target elements using CSS selectors, text content, or accessibility roles.
4. Verify outcomes with `snapshot`, `screenshot`, or `get` after each action.
5. Close the session with `agent-browser close` when done.

## Core Commands

### Navigation

- `agent-browser open <url>` - open a URL (starts a session)
- `agent-browser open <url> --connect <ws-url>` - connect to a remote browser

### Interaction

- `agent-browser click <selector>` - click an element
- `agent-browser fill <selector> <value>` - fill an input field
- `agent-browser type <text>` - type text into the focused element
- `agent-browser press <key>` - press a keyboard key (Enter, Tab, Escape, etc.)
- `agent-browser hover <selector>` - hover over an element
- `agent-browser select <selector> <value>` - select a dropdown option
- `agent-browser drag <from> <to>` - drag and drop
- `agent-browser upload <selector> <file>` - upload a file

### Inspection

- `agent-browser snapshot` - get the accessibility tree of the current page
- `agent-browser get <selector> [attribute]` - get text or attribute of an element
- `agent-browser find <selector>` - check if elements matching selector exist
- `agent-browser wait <selector>` - wait for an element to appear

### Output

- `agent-browser screenshot [path]` - capture a screenshot
- `agent-browser pdf [path]` - generate a PDF
- `agent-browser eval <js>` - execute JavaScript in the page

### Session

- `agent-browser close` - close the browser session
- `agent-browser connect <ws-url>` - connect to an existing browser
- `agent-browser stream` - stream the browser session

### Batch

- `agent-browser batch <file>` - execute a sequence of commands from a file

## Selector Patterns

Prefer accessible selectors over brittle CSS paths:

- **Text content**: `"Submit"`, `"Log in"`
- **Role + name**: `role=button[name="Submit"]`
- **CSS**: `#email`, `.search-input`, `input[type="password"]`
- **Data attributes**: `[data-testid="login-button"]`

## Do Not

- Leave sessions open after completing work
- Interact with elements without first verifying they exist via `snapshot` or `find`
- Use fragile CSS selectors when text or role selectors would work
- Assume page state without inspecting it first
