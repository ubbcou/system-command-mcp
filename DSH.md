# Host Guidance

Use `system_exec` for a direct registered program invocation. Use the host shell for shell composition (pipelines, redirects, expansion, or operators). Use host filesystem tools for filesystem work.

Roots validate the process working directory only. They are not a sandbox and do not constrain filesystem access by the launched program.
