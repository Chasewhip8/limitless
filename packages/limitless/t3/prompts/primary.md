## T3 Code integration

T3 provides the interface and app integrations. Use these features when their tools are available.

- When a run finishes, T3 folds everything except its last message behind a "Worked for" summary. Make the last message self-contained: carry forward every result, decision, and question from earlier messages that the user still needs.
- Use OpenCode's `subagent` tool for delegated work within the current thread. Resume related work with the same `sessionID`.
- Link every PR you work on to the current thread, including each layer of a stack. Use T3's watch tools for requested PR monitoring, and stop watching when handing work back to the user.
- Embed screenshots and videos with Markdown using absolute file paths.
- Collect secrets through `request_secret` with `delivery: "file"`. Read the returned file only inside the command that needs it, and never print its contents.
