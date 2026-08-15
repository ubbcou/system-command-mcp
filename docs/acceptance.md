# Acceptance

This document separates deterministic transport/runtime acceptance from credentialed local real-host evidence. Neither category alone makes a cross-host claim.

## Deterministic CI acceptance

`npm test` runs in the existing Node 20/22 × Windows/macOS/Linux matrix. Every matrix entry then installs the pinned DSH runtime without changing the lockfile and runs portable acceptance; Ubuntu Node 22 additionally runs the standalone smoke and reconnect checks:

```text
npm install --no-save --package-lock=false @deepseek-ai/dsh@0.1.0-rc.6
npm run acceptance:portable
npm run acceptance:dsh-reconnect
```

`acceptance:portable` creates a native-temp Root, Artifact directory, and Manifest. The Manifest registers only `node` at `process.execPath`, requires it, sets `artifactPolicy: "always"`, and bounds its timeout. It runs `doctor`, then the DSH MCP smoke. The smoke executes the exact registered tools: `system_environment`; successful `system_exec`; nonzero `system_exec` (exit 7); timed-out `system_exec`; and a bounded `system_output` Artifact read. It asserts structured, non-tool-error canonical fields and prints redacted normalized JSON: platform, arch, mode, program names, terminal state, output accounting, Artifact published boolean, and bounded page data—never paths or opaque IDs.

`acceptance:dsh` is independently usable: absent `SYSTEM_COMMAND_MANIFEST`, it creates the same temporary manifest/root/artifact directory itself. To use a supplied configuration, pass native absolute paths:

```text
DSH_CHECKOUT=/path/to/dsh npm run acceptance:dsh
SYSTEM_COMMAND_MANIFEST=/absolute/manifest.json SYSTEM_COMMAND_ROOT=/absolute/root SYSTEM_COMMAND_ARTIFACT_DIR=/absolute/artifacts npm run acceptance:dsh
DSH_CHECKOUT=/path/to/dsh npm run acceptance:dsh-reconnect
```

The DSH scripts need `DSH_CHECKOUT` pointing at a checkout/npx root containing DSH packages, or a resolvable `dsh` executable with those packages.

## Credentialed local real Codex evidence

CI does **not** run real Codex: it has no credential/configuration assumption. [`acceptance-windows-x64.json`](acceptance-windows-x64.json) records a redacted local observation tied to the tested commit, command list, Codex/DSH versions, registration checks, completed tool-call boolean, and normalized configured environment. It intentionally excludes paths, users, credentials, process IDs, command arguments, and Artifact IDs.

Reproduce registration only without changing Codex configuration:

```text
GIT_COMMIT_TESTED=$(git rev-parse HEAD) npm run acceptance:codex-real-host
```

The script checks `codex --version`, `codex mcp list --json`, and `codex mcp get system-command --json`. It only attempts `codex exec` when the operator has explicitly arranged credential/configuration and sets `CODEX_ACCEPTANCE=1`; it never mutates Codex configuration. Record the resulting structured JSON only as local real-host evidence.

## Package audit

```text
npm pack --dry-run
```

The package publishes only declared runtime/docs/schema files; integration scripts and local evidence remain excluded.

## Status

| Target | Status | Basis |
|---|---|---|
| CI OS/Node matrix | Deterministic DSH portable transport/runtime acceptance | Pinned rc.6 portable smoke after unit tests; Ubuntu Node 22 also runs standalone smoke and reconnect. |
| Windows x64 | Credentialed local real-host observation | Redacted structured evidence, not a cross-host claim. |
| macOS/Linux real Codex | Not accepted here | Run the same local reproduction on that host. |

No `npm publish` or GitHub Release is performed here.
