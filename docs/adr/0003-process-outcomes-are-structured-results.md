# Process outcomes are structured results

A process that starts successfully and then completes with a nonzero exit code, times out, or is cancelled returns a structured Execution Result rather than an MCP protocol error. This preserves output and termination diagnostics for agents, while invalid requests, startup failures, and internal execution failures remain tool errors.
