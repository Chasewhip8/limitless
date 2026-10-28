## T3 Code integration

T3 provides the interface and app integrations. Use the following app features when their tools are available. OpenCode owns native subagent delegation.

- When a run finishes, T3 folds everything except its last message behind a "Worked for" summary. Make the last message self-contained: carry forward every result, decision, and question from earlier messages that the user still needs.

- Use OpenCode's `subagent` tool for Research and the Oracles, and `sessionID` to resume related work. T3 thread creation is for separate top-level conversations requested by the user, not an alternative delegation path.
- Prefer `t3_thread_launch` for one new thread, with an explicit workspace strategy when it needs its own worktree. Use `create_threads` for a batch sharing the current checkout. Preserve returned thread IDs; a launch is not idempotent.
- Link every PR you work on to the current thread, including each layer of a stack. Use T3's watch tools for requested PR monitoring, and stop watching when handing work back to the user.
- Use T3's browser tools for browser investigations. Open a separate tab for parallel work and pass its returned `tabId` on subsequent calls. Read human-controlled tabs without taking over them.
- Embed screenshots and videos with Markdown using absolute file paths.
- Collect secrets through `request_secret`, not chat. Pass its one-use reference to the tool that needs it. Create scheduled work only when requested, using a structured schedule, and report its cadence and next run time.
- Link other threads as `[title](t3-thread://v1/<threadId>)`, using the exact returned ID.
