# Two plugin-management improvements: live plugin updates and reporting missing services

Both requests come from real runs of dshenv (a declarative plugin environment manager for DSH) against npm `@deepseek-ai/dsh@0.1.7-rc.2` (source `7dfe937257`). They are independent and can be implemented separately.

1. [Plugin manager: load the new version of an updated plugin without restarting DSH](#request-1)
2. [Plugin inventory: report which injected services a pending plugin is waiting for](#request-2)

## Request 1

**Plugin manager: load the new version of an updated plugin without restarting DSH**

### Summary

Updating a plugin that is already installed (`dsh plugin add <pkg>@<new>` or `pluginManager.installBundle`) always needs a DSH restart, even when `dsh-hmr` is active. Removing a plugin, re-selecting it, or pointing HMR at its install directory does not help either: the running DSH keeps executing the module it imported first. Please let the plugin manager evict the updated package's modules and re-import them, the way `dsh-hmr`'s `partialReload` already does for watched source files.

### Observed behaviour (npm `@deepseek-ai/dsh@0.1.7-rc.2`, source `7dfe937257`)

Probe plugin: a bundle whose entry module appends `evaluate <version> <timestamp>` to a file when the module is evaluated and `apply <version>` when `apply` runs. Isolated `DSH_HOME`, `dsh web --port 13184`.

| Step | Result |
|---|---|
| Install 1.0.0, start `dsh web` | `evaluate 1.0.0 T1`, `apply 1.0.0` |
| `dsh plugin --profile web add probe-2.0.0.tgz` while selected | disk now holds 2.0.0; nothing is reloaded; 1.0.0 keeps running |
| Remove the bundle from `dsh.profile.bundles`, wait, add it back | `apply 1.0.0 (module evaluated T1)` — re-applied, but from the cached 1.0.0 module; 2.0.0 is never read |
| Profile patch `- id: hmr` with `config.root: [<profile>/node_modules/<pkg>]`, `ignored: []`, restart, then update or edit the installed file | no reload |

### Why

- Profiles install with `nodeLinker: hoisted` (`packages/boot/app-boot/src/profile.ts:208`), so every version of a package lives at the same `node_modules/<name>` path and resolves to the same file URL.
- Node's ESM module map never evicts, so any later `import()` of that URL returns the first module.
- `installBundle` already knows this and returns early: `if (Object.hasOwn(before, name)) return 'restart-required'` (`packages/boot/plugin-manager/src/index.ts:561`).
- `dsh-hmr` can evict and re-import (`Map.prototype.delete.call(this.internal.loadCache, filename)` and the `require.cache` handling in `packages/boot/hmr/src/index.ts:469-485`), but only for files its watcher reports, and `node_modules` is ignored by default.

### Proposed change

When `installBundle` (or `dsh plugin add`) replaces an installed package and the `hmr` service is present:

1. Deselect the bundle's rows so their fibers dispose.
2. Evict every `loadCache` / `require.cache` entry whose file lies under the package directory.
3. Run the install, re-select the bundle, and let the loader import the new files.
4. Report `application: 'applied'` on success. If any step fails, keep today's `'restart-required'` result.

Optionally, expose the evicted and re-imported package version in `listBundles` or the plugin inventory, so tools can confirm which version is running.

### Impact

Tools such as dshenv could then report plugin updates as applied live, instead of always asking users to restart DSH.

## Request 2

**Plugin inventory: report which injected services a pending plugin is waiting for**

### Summary

A plugin whose `inject` names a service that no loaded plugin provides stays in fiber phase `pending` forever. `pluginInventory.list` and `pluginManager.listPlugins` show `fiberPhase: 'pending'`, but not which service is missing. Users can't tell "still loading" apart from "will never load", or find the plugin they need to install or enable. Please add the missing service names to each inventory entry.

### Observed behaviour (npm `@deepseek-ai/dsh@0.1.7-rc.2`, source `7dfe937257`)

Probe bundle whose plugin declares `export const inject = ['spikeMissingService']`, installed into an isolated profile, `dsh web --port 13185`:

- `pluginManager/listPlugins` returns the probe entry with `enabled: true`, `fiberPhase: 'pending'` and nothing else.
- The entry is still `pending` after several seconds. No endpoint reports why.

### Why the information already exists

`Fiber._refresh` (`vendor/cordis/src/fiber.ts:611-621`) walks `Object.keys(this.inject)` and marks the fiber inactive as soon as `this._store[name]` is missing. That is exactly the list of unresolved services. `_getState` (`vendor/cordis/src/fiber.ts:574-579`) then maps "no epoch" to `FiberState.PENDING`.

### Proposed change

Add an optional field to `PluginInventoryEntry` (`packages/host/plugin-inventory/src/types.ts:17`) and to the preset rows:

```ts
/** Injected services this entry's fiber is still waiting for; present only while it is pending on them. */
readonly missingServices?: readonly string[]
```

`readPluginInventory` (`packages/host/plugin-inventory/src/index.ts`) would fill it for a pending fiber from the names in `fiber.inject` that have no entry in the fiber's resolved store. Optional (non-required) injections should be excluded if Cordis tracks them separately. `listPlugins` passes the field through unchanged.

### Impact

- The web UI could show "waiting for service X" next to a plugin that never starts.
- Tools like dshenv (`dshenv runtime`, which today can only say a plugin "is waiting for services it injects") could name the missing service and suggest the plugin that provides it.
