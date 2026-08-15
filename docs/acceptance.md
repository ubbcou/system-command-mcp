# Acceptance

This document separates deterministic system-command acceptance from credentialed local Codex evidence. Neither category alone makes a cross-host claim.

## Deterministic CI acceptance

`npm test` remains the Node 20/22 × Windows/macOS/Linux core matrix. Every cell also runs the DSH-independent runtime check:

```text
npm run acceptance:runtime-portable
```

DSH `0.1.0-rc.6` is installed reproducibly from the tracked exact dependency graph:

```text
npm ci --prefix acceptance/dsh
```

Its host tests run only on Node 22. rc.6 uses `Promise.withResolvers`, so this is a DSH host-test constraint, **not** a change to system-command-mcp's Node `>=20` support. Node 22 matrix cells run:

```text
npm run acceptance:portable
```

Ubuntu Node 22 additionally runs `acceptance:dsh` and `acceptance:dsh-reconnect`. `acceptance:portable` creates a temporary Root, Artifact directory, and Manifest with only `node`, `artifactPolicy: "always"`, and bounded timeouts. The DSH smoke invokes the exact environment, execution, and artifact-output MCP tools for success, exit 7, timeout, and a bounded output read. It emits normalized output without paths or opaque IDs.

`DSH_CHECKOUT` may identify `acceptance/dsh`, another checkout/npx root with `node_modules`, or a locally resolvable DSH installation:

```text
DSH_CHECKOUT=acceptance/dsh npm run acceptance:dsh
```

## Credentialed local real Codex evidence

CI does not run Codex. To record a configured local observation, arrange a server manifest with the intended policy (the acceptance run requires `artifactPolicy: "always"`) and run:

```text
CODEX_ACCEPTANCE_FULL=1 npm run acceptance:codex-real-host
```

The script parses `codex mcp list/get --json`, then parses every `codex exec --json` MCP call lifecycle event by item id. Full mode requires exactly five unique, started-and-completed, error-free calls on only server `system-command`: `system_environment`, three `system_exec` calls (success, exit 7, timeout), and `system_output`; it rejects additional, failed, or incomplete calls. It asserts configured environment with exactly `node`, exit/timeout states with canonical `completedWithoutError: true`, published artifacts, and a nonempty bounded output page. It emits only redacted normalized JSON: no paths, command arguments, artifact IDs, tokens, or raw output.

Evidence records `git write-tree` as `testedTree` before staging the evidence record, and current `HEAD` as `headParent`. The tree hash identifies the tested staged content; `headParent` identifies the evidence-record commit's parent. [`acceptance-windows-x64.json`](acceptance-windows-x64.json) is one local observation, not a CI or cross-host claim.

## Package audit

```text
npm pack --dry-run
```

The package allow-list excludes `scripts/`, `acceptance/`, and local evidence.

## Status

| Target | Status | Basis |
|---|---|---|
| Node 20/22 × Windows/macOS/Linux | Core tests and runtime portable check | `npm test` plus DSH-independent `acceptance:runtime-portable`. |
| Node 22 × Windows/macOS/Linux | DSH portable host acceptance | Exact locked DSH rc.6 runtime. |
| Ubuntu Node 22 | DSH direct/reconnect acceptance | Exact locked DSH rc.6 runtime. |
| Windows x64 | Credentialed local Codex observation | Parsed and redacted real-host evidence only. |

No `npm publish` or GitHub Release is performed here.
