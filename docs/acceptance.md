# Acceptance

This document separates reproducible checks from one local host observation. It does not claim that all platform acceptance is complete.

## Reproducible checks

Build first, then run the portable orchestrator. It creates `$ROOT` and `$MANIFEST` under the native temporary directory, configures `node` as `process.execPath`, runs `doctor`, and verifies the DSH MCP tools and `system_environment` call.

```text
npm test
npm run acceptance:portable
npm pack --dry-run
```

The DSH scripts need either `DSH_CHECKOUT` pointing at a DSH checkout/npx root or a resolvable `dsh` executable whose npx root contains its packages. They print a clear `SKIP`/usage error when neither is available.

```text
# $MANIFEST must use native absolute paths; $ROOT is an authorized absolute root.
DSH_CHECKOUT=/path/to/dsh npm run acceptance:dsh
SYSTEM_COMMAND_MANIFEST=$MANIFEST SYSTEM_COMMAND_ROOT=$ROOT npm run acceptance:dsh
DSH_CHECKOUT=/path/to/dsh npm run acceptance:dsh-reconnect
```

`acceptance:dsh` defaults to `process.execPath` and the built CLI, and accepts an MCP executable plus its leading arguments after `--`; it obtains the manifest and root from `SYSTEM_COMMAND_MANIFEST` and `SYSTEM_COMMAND_ROOT`. `acceptance:dsh-reconnect` uses only the repository fixture in `scripts/integration/pid-die-server.mjs`.

## Local host evidence

[`acceptance-windows-x64.json`](acceptance-windows-x64.json) is redacted Windows x64 evidence: host versions, the exact MCP tool names, successful Codex and DSH tool calls, reconnect PID-change boolean, empty disposal state, and result shapes. It intentionally omits usernames, absolute paths, and process IDs. Local evidence is not a substitute for reproducible acceptance.

## Platform status

| Target | Status | Basis |
|---|---|---|
| Windows x64 | Local host evidence | Structured evidence plus the reproducible scripts above. |
| macOS x64 | Not accepted here | Run the same reproducible checks on that host. |
| macOS arm64 | **Unresolved external acceptance blocker** | This repository has no available external macOS arm64 host/runner for acceptance. |
| Linux x64 | Not accepted here | Run the same reproducible checks on that host. |

## Package audit

`npm pack --dry-run` is the package check. `package.json` publishes only the declared runtime/docs/schema files; the integration scripts and local acceptance evidence are explicitly excluded.

## Deferred actions

- No `npm publish`.
- No GitHub Release.
