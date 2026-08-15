# Acceptance Evidence

Validated on 2026-08-15 without publishing npm or creating a GitHub Release.

## Support matrix

| Target | Status | Evidence |
|---|---|---|
| Windows x64, Node 20/22 | Validated | Local Windows x64 suite and GitHub Actions matrix after canonical-path regression fix. |
| macOS x64, Node 20/22 | CI configured | GitHub-hosted `macos-latest` jobs; runner availability was delayed during acceptance. |
| macOS arm64 | Not yet CI-validated | No public arm64 hosted runner was available to this repository. Support is an implementation target, not a claimed CI result. |
| Linux x64, Node 20/22 | Compatibility CI | GitHub Actions matrix; non-blocking platform target. |

## Reproducible checks

```text
npm test
# 83 tests: 79 passed, 4 Windows-inapplicable skipped

npm pack --dry-run
# clean-source prepack builds dist and includes the executable CLI

node dist/src/cli.js doctor --manifest acceptance.manifest.json --root C:\Users\ubbco\Desktop
# static configuration valid; no program executed

codex mcp get system-command --json
codex mcp list --json
# effective command, args, cwd, startup 30s, tool 300s confirmed

codex exec --json --sandbox danger-full-access --skip-git-repo-check "Use the system-command MCP tool system_environment exactly once. Return only the registered node executable path."
# real mcp_tool_call completed and returned the configured Node executable

node .scratch/dsh-mcp-smoke.mjs
# exact tools registered: system_environment, system_exec, system_output; system_environment executed

node integration/host-acceptance/.scratch/dsh-mcp-reconnect-smoke.mjs
# pid changed after die response; dispose left tools=[]
```

## Host integration

- Codex effective config: `%CODEX_HOME%\config.toml`.
- DSH Web profile patch: `%DSH_HOME%\profiles\web\cordis.patch.yml`.
- Timestamped backups were created before modification with suffix `system-command-backup-20260815-155412`.
- Working Directory Roots validate process `cwd`; they are not a filesystem sandbox.
- Native Programs use literal arguments. Windows `.cmd`/`.bat` Platform Wrappers are `cmd-reparsed` and reject unsafe arguments.

## Package audit

The dry-run tarball contains compiled runtime/MCP/CLI files, declaration files and maps, README, Host Guidance, Manifest schema/example, license, and package metadata. It excludes tests, scratch fixtures, local acceptance configuration, caches, and repository metadata.

## Deferred irreversible actions

- No `npm publish`.
- No formal GitHub Release.
