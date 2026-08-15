# Node project resolution is per execution

## Context

Configured execution makes the Program Manifest and startup Execution Environment authoritative (ADR 0002). A single machine can nevertheless contain several Node installations, while adjacent projects legitimately declare different compatible versions. Resolving a project declaration by mutating an nvm/fnm/Volta global selection would make concurrent requests interfere and would make the Server's behavior depend on mutable manager state.

## Decision

When the optional `nodeResolution` configuration is enabled, startup scans only recognized Node-manager directory layouts under configured or default manager roots. A **Program Variant** is an existing canonical `node` executable whose semver version comes solely from a recognized ancestor directory name. The resulting immutable **Program Variant Set** is attached to the registered `node` static fallback in the startup Execution Environment.

Discovery never executes a discovered binary, invokes a manager, installs anything, accesses the network, or changes a global Node selection. It verifies the canonical, non-symlink version directory and its native `node` executable, plus their filesystem identities; each dynamic execution revalidates those identities. Paired `npm` and `npx` CLI scripts, when present, are likewise canonical, non-symlink files inside that variant. The static fallback still comes from the manifest's Declared Candidate; a dynamically selected variant has no Declared Candidate. Pathname-based spawn retains a residual platform race after validation; there is no universal atomic execute-by-file-handle API.

For each `node` Execution Request, after canonical cwd/root authorization, the runtime re-reads ordinary, non-symlink regular declaration files while walking from cwd to that root. Precedence at each directory and across the nearest directory is: `package.json#devEngines.runtime` for Node, `package.json#volta.node`, `.nvmrc`, `.node-version`, then `package.json#engines.node`. The first declaration found wins. Valid semver ranges select the highest matching Program Variant; prereleases participate only when the range admits one. `lts/*`, `node`, and `stable` are invalid requirements. A missing matching Variant yields `NODE_VERSION_UNAVAILABLE: <declaration kind>` and an invalid requirement yields `NODE_VERSION_REQUIREMENT_INVALID: <declaration kind>`; these stable errors avoid exposing project paths or raw requirements.

The Variant Set is a startup snapshot, while the declaration is intentionally re-read per request. Therefore a newly installed version requires a Server restart; editing a project's declaration affects only later requests. Each request produces a **Program Selection** recording its selected executable and, for a dynamic selection, version, requirement, and declaration kind. The requirement is returned as requested project metadata for user diagnostics, but is not included in error messages.

Requests select independently and do not mutate shared process or manager state, so normal runtime concurrency limits remain sufficient. The selected Node directory is prepended only to that child's environment. For a dynamically selected project, registered `npm` and `npx` run the selected native Node executable with the trusted canonical paired CLI script inside that variant; if the relevant paired CLI is absent, the request fails with `PROJECT_NPM_UNAVAILABLE`. This avoids Windows `.cmd` manager wrappers and their cmd-reparsed argument semantics while keeping `npm` and `npx` registered Logical Programs.

This refines rather than weakens ADR 0002: the authoritative startup Execution Environment now explicitly includes a static fallback and any immutable Program Variant Set. The only per-request input is an authorized project's declaration, and it can choose only a member of that snapshot.

## Alternatives rejected

* Execute each discovered binary with `--version`: unsafe startup execution of untrusted manager layouts.
* Scan arbitrary directory trees and infer a version from any ancestor: accepts accidental or attacker-controlled layouts.
* Invoke Node managers, use global switches, install missing versions, or fetch versions: introduces mutable shared state, network behavior, and non-deterministic startup.
* Snapshot project declarations at startup: prevents legitimate project declaration edits from taking effect without restart.
* Invoke a manager wrapper or switch its global selection for package management: this reintroduces mutable shared state and, on Windows, `.cmd` wrapper semantics. This does not reject the paired canonical CLI approach above.
