# Host Guidance

- Use `system_exec` for one direct registered program with literal arguments.
- Use the host shell when work needs pipelines, redirects, expansion, composition, or shell syntax.
- Use host filesystem tools for reading, writing, listing, and editing files.
- Working Directory Roots validate a process `cwd`; they are **not** a filesystem sandbox and do not restrict what a launched program can access.
