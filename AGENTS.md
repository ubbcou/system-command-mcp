# Host Guidance

- Use `system_exec` for one direct Registered Program with literal arguments.
- Use the host shell when work needs pipelines, redirects, expansion, composition, or shell syntax.
- Use host filesystem tools for reading, writing, listing, and editing files.
- Working Directory Roots validate a process `cwd`; they are **not** a filesystem sandbox and do not restrict what a launched program can access.
- The MCP lifecycle is finite and non-interactive: no TTY, background jobs, or shell command strings. Nonzero exits are structured Execution Results, not tool errors.
- Large output may have an Execution Artifact; use `system_output` with its opaque identity rather than host filesystem reads.
