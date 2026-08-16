# Active Manager Selection observes explicit links

## Context

Manifest v2 originally used a fixed Project Node Default when an eligible project had no exact selector. Users of nvm-windows commonly choose a machine-wide active Node with `nvm use`, represented by the manager-owned `NVM_SYMLINK`. Requiring every project to add metadata does not match that workflow, while invoking a manager or mutating its link would reintroduce shared-state and privilege hazards.

## Decision

Manifest v2 may set `projectNode.whenNoSelector` to `active-manager` and provide exactly one explicit `activeManagerLinks` entry. The array shape permits platform replacement configuration, not runtime fallback ordering. The default remains `default-version` for compatibility. Project exact selectors retain priority.

For each eligible Node, npm, or npx request without an exact selector, the configured link is authoritative. It must be a filesystem symlink, Windows junction, or other reparse link whose canonical target exactly matches a version directory or Node executable in the immutable startup Program Variant Set. Missing, broken, ordinary directories/files, and unmatched state immediately fail with `PROJECT_NODE_ACTIVE_VERSION_UNAVAILABLE`; no alternative link or fixed default is consulted. Project `engines.node` constraints still apply.

The Runtime never invokes nvm or another manager, changes the link, installs a version, or expands the startup catalog. A manager switch to an already-snapshotted version takes effect on the next request without Server restart. A newly installed version is unavailable until restart. Paired npm and npx continue to use the selected Variant's trusted CLI.

No active link is guessed on any platform. Windows deployments commonly configure `C:\Program Files\nodejs`; Unix deployments may configure an explicit manager-owned current link when available.

## Alternatives rejected

* Require a Project Node Declaration in every repository: does not support the confirmed active-manager workflow.
* Read PATH or execute `node --version`: Host launch environments differ and discovery would execute code.
* Invoke `nvm use`, `fnm use`, or mutate manager state: makes concurrent requests interfere and requires privileges.
* Fall back to the Project Node Default when the active link is invalid: hides broken or unexpected manager state.
