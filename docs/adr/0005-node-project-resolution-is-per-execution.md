# Node project resolution is per execution

When optional `nodeResolution` is enabled, startup snapshots valid installed Node variants and each `node` Execution Request re-reads the nearest project declaration within its authorized Working Directory Root. This avoids global Node-manager mutation and allows concurrent projects to select independently. `npm` remains its configured wrapper; only the selected Node directory is prepended to a dynamically selected `node` child PATH.
