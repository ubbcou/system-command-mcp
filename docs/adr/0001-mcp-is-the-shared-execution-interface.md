# MCP is the shared execution interface

Codex and DSH will use the same MCP Server as the primary system-program execution interface on Windows and macOS. This favors one cross-host execution contract and implementation over a DSH-specific adapter; host-native shells remain available only for genuine shell semantics, and a native DSH adapter will be reconsidered only if MCP cannot express required DSH-specific behavior.
