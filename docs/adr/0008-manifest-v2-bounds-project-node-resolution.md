# Manifest v2 bounds project Node resolution

## Context

ADR 0007 introduced per-execution Node selection through `nodeResolution` in Manifest v1. That field changed the meaning of an already published Manifest version and left important boundaries implicit: whether ranges or manager defaults could select Node, whether repository or package-workspace structure stopped declaration lookup, and whether per-request declaration reads amounted to live configuration watching.

Project-aware selection is useful, but it is a deliberate exception to the otherwise static Configured Mode contract. The exception must not let a project install software, access the network, mutate global manager state, or select an executable that was not accepted at startup.

## Decision

Manifest v1 is frozen as the transition contract. It continues to permit the existing optional `nodeResolution` field, including platform override, and rejects `projectNode`. Its behavior remains available for compatibility, but new manifests use v2.

Manifest v2 removes `nodeResolution` and introduces optional `projectNode`. The object requires non-empty `enabledRoots` and `installationRoots` arrays plus an exact `defaultVersion`. `projectNode` is a full platform-overridable field: when present under the active platform it replaces the top-level object rather than merging individual properties. Unknown fields remain invalid at the Manifest top level and in every platform override.

Each `projectNode.enabledRoots` entry must resolve at startup to a directory inside Host Authorization. It is then a Project Node Boundary and the sole upper lookup boundary for requests inside it. Declaration lookup walks from canonical cwd through that enabled Root, inclusive. It does not stop at `.git`, another VCS marker, `package.json` workspace declarations, a package-manager workspace, or any inferred repository or monorepo root. Requests outside all enabled Roots use the Registered Program's static fallback and do not perform Project Node Resolution.

Startup discovers Node Program Variants only from recognized manager layouts beneath configured installation roots. Each accepted Variant has an exact semver identity from recognized manager metadata, a canonical native Node executable, and optional canonical paired npm/npx CLI files. Discovery never executes a discovered binary or manager, reads a manager default/alias, installs a missing version, accesses the network, or mutates global state. The immutable Program Variant Set is the complete universe available to Project Node Resolution until restart. `defaultVersion` must be an exact version in that Set; it is a Manifest default, not a manager default.

For each eligible `node`, `npm`, or `npx` Execution Request, the runtime re-reads supported ordinary, non-symlink Project Node Declarations. This is request input evaluation, not Manifest watching, PATH watching, installation-root watching, or dynamic Program registration. Manifest, PATH, manager installations, and the Program Variant Set remain startup snapshots; adding or removing a Node installation requires restart.

Exact-selection declarations are `package.json#devEngines.runtime` for Node, `package.json#volta.node`, `.nvmrc`, and `.node-version`. Each must be an exact semver pin; ranges and aliases such as `default`, `node`, `stable`, and `lts/*` are invalid. The nearest directory containing any exact-selection declaration wins. If that directory contains multiple exact declarations, all must normalize to the same version or the request fails with a declaration-conflict error. A pin absent from the startup Program Variant Set fails statically.

`package.json#engines.node` is a compatibility constraint, not an exact selector or a precedence fallback. Every `engines.node` found from cwd through the enabled Root must be a valid semver range. The selected exact project version, or `defaultVersion` when no exact declaration exists, must satisfy every such range; otherwise the request fails. Thus an exact pin cannot silently override incompatible engines metadata, and engines alone cannot choose the highest installed Node.

A project-selected or Manifest-default `node` runs the selected native executable with that Variant's directory first on the child PATH. Registered logical `npm` and `npx` are paired to the same selected Variant and run its canonical `node_modules/npm/bin/npm-cli.js` or `npx-cli.js` through that Variant's Node executable. A missing paired CLI fails the request. npm and npx never mix a project-selected Node with the Manifest's static wrapper. Other package managers are not redirected by this decision.

## Consequences

Manifest version now communicates the project-selection contract unambiguously: v1 remains compatible and v2 opts into the bounded exception. Project declaration edits can affect the next eligible request, while installation and environment changes cannot. Selection stays deterministic, concurrent requests do not interfere, and enabled Roots avoid hidden VCS/workspace heuristics.

The schema can enforce version-specific fields and strict platform shapes, while Root authorization and engines compatibility remain runtime decisions because they depend on Host Authorization and request declarations.

## Alternatives rejected

- Continue extending `nodeResolution` in v1: changes an existing version's meaning and cannot make old/new behavior machine-distinguishable.
- Let project ranges select the highest installed Node: makes selection drift when a new installation appears and weakens exact project pins.
- Use a manager default or alias: depends on mutable global manager state outside the Manifest.
- Stop at a VCS or package-workspace boundary: introduces undeclared repository heuristics and makes the same cwd resolve differently after unrelated metadata changes.
- Watch project files, PATH, or installation roots: changes the registered environment during one Server lifetime and requires dynamic tool-change semantics.
- Let precedence hide contradictory exact declarations or incompatible engines: creates false confidence across Node tooling.
- Use the static npm/npx wrapper with a selected Node: permits cross-version pairing and restores Windows wrapper reparse ambiguity.