# Configured execution environment is authoritative

Stable Codex and DSH deployments use one explicit, versioned Program Manifest to construct the Program Configuration and Execution Environment. Program discovery and child processes use that same environment, inherited PATH is disabled by default, and an invalid explicit Manifest prevents startup rather than silently falling back to Automatic Discovery Mode; this trades some setup work for reproducible behavior across terminal and GUI hosts on Windows and macOS.
