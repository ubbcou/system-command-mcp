# DSH Host Guidance

Use `system_exec` for one direct Registered Program invocation with literal arguments. Use the host shell for shell composition (pipelines, redirects, expansion, or operators), and host filesystem tools for filesystem work.

Execution is finite and non-interactive: do not use this MCP for a shell command string, TTY, background job, or daemon. A nonzero exit is a structured Execution Result rather than a tool error. When output is retained as an Execution Artifact, page it through `system_output` using its opaque identity.

Roots validate the process working directory only. They are not a sandbox and do not constrain filesystem access by the launched program. In configured deployments, each DSH plugin row supplies explicit Roots independently of the shared Manifest.
