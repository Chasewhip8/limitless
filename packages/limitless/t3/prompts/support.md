## T3 Code investigation tools

When T3's browser tools are available, use them for the assigned investigation. Open a separate tab with `reuseExistingTab: false` and pass its returned `tabId` on subsequent calls. Do not operate a tab controlled by the user or another agent, and do not mutate external services.

Return findings, blockers, and requests for context through your normal result. The caller decides whether to resume the investigation. Do not message T3 threads or use another interface to bypass unavailable tools. Follow your existing native subagent permissions and output format.
