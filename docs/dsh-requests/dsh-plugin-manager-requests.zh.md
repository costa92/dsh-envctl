# 插件管理的两处改进：升级即时生效，以及报告缺失的 service

两项需求都来自 dshenv（DSH 的声明式插件环境管理工具）在 npm 版 `@deepseek-ai/dsh@0.1.7-rc.2`（源码 `7dfe937257`）上的实测。二者相互独立，可以分开实现。

1. [插件管理器：升级已装插件后，不重启 DSH 就加载新版本](#需求一)
2. [插件清单：报告卡在 pending 的插件正在等待哪些注入的 service](#需求二)

## 需求一

**插件管理器：升级已装插件后，不重启 DSH 就加载新版本**

### 概述

升级一个已经安装的插件（`dsh plugin add <pkg>@<新版本>` 或 `pluginManager.installBundle`）总是需要重启 DSH，即使 `dsh-hmr` 已经启用也一样。先移除插件再重新选中它，或者让热加载监视插件的安装目录，也都不管用：运行中的 DSH 一直执行它最先导入的那份模块。

希望插件管理器在升级时，把这个包的模块从缓存中清掉再重新导入。`dsh-hmr` 的 `partialReload` 对它监视到的源文件已经这样做了。

### 实测现象（npm 版 `@deepseek-ai/dsh@0.1.7-rc.2`，源码 `7dfe937257`）

探针插件：一个 bundle，入口模块在被执行时向文件追加 `evaluate <版本> <时间戳>`，在 `apply` 运行时追加 `apply <版本>`。使用隔离的 `DSH_HOME`，`dsh web --port 13184`。

| 步骤 | 结果 |
|---|---|
| 安装 1.0.0，启动 `dsh web` | `evaluate 1.0.0 T1`、`apply 1.0.0` |
| 保持选中，执行 `dsh plugin --profile web add probe-2.0.0.tgz` | 磁盘上已是 2.0.0；没有任何重载，运行的仍是 1.0.0 |
| 从 `dsh.profile.bundles` 移除该 bundle，等待后再加回 | `apply 1.0.0 (module evaluated T1)`：重新 apply 了，但用的是缓存中的 1.0.0 模块，2.0.0 从未被读取 |
| profile 补丁 `- id: hmr`，`config.root: [<profile>/node_modules/<pkg>]`、`ignored: []`，重启后升级或直接修改已安装文件 | 没有重载 |

### 原因

- profile 以 `nodeLinker: hoisted` 安装（`packages/boot/app-boot/src/profile.ts:208`），所以一个包的每个版本都在同一个 `node_modules/<包名>` 路径下，解析到同一个文件 URL。
- Node 的 ESM 模块表从不清除，之后对该 URL 的任何 `import()` 都返回第一次加载的模块。
- `installBundle` 已经知道这一点并提前返回：`if (Object.hasOwn(before, name)) return 'restart-required'`（`packages/boot/plugin-manager/src/index.ts:561`）。
- `dsh-hmr` 能清除缓存并重新导入（`packages/boot/hmr/src/index.ts:469-485` 中的 `Map.prototype.delete.call(this.internal.loadCache, filename)` 以及对 `require.cache` 的处理），但只针对它的监视器报告的文件，而 `node_modules` 默认被忽略。

### 建议改动

当 `installBundle`（或 `dsh plugin add`）替换一个已安装的包，并且 `hmr` 服务存在时：

1. 取消选中该 bundle 的各行，让它们的 fiber 释放。
2. 清除文件位于该包目录下的所有 `loadCache` / `require.cache` 条目。
3. 执行安装，重新选中该 bundle，让加载器导入新文件。
4. 成功时报告 `application: 'applied'`；任何一步失败，就保持现在的 `'restart-required'` 结果。

可选：在 `listBundles` 或插件清单中暴露当前实际加载的包版本，方便工具确认运行的是哪个版本。

### 影响

这样，dshenv 这类工具就能把插件升级报告为已即时生效，而不必总是要求用户重启 DSH。

## 需求二

**插件清单：报告卡在 pending 的插件正在等待哪些注入的 service**

### 概述

如果一个插件的 `inject` 里有某个 service 没有任何已加载的插件提供，它会永远停在 fiber 阶段 `pending`。`pluginInventory.list` 和 `pluginManager.listPlugins` 会显示 `fiberPhase: 'pending'`，但不说明缺的是哪个 service。用户因此分不清「还在加载」和「永远加载不了」，也找不到需要安装或启用哪个插件。

希望在插件清单的每个条目里加上缺失的 service 名称。

### 实测现象（npm 版 `@deepseek-ai/dsh@0.1.7-rc.2`，源码 `7dfe937257`）

探针 bundle 的插件声明了 `export const inject = ['spikeMissingService']`，安装到隔离的 profile 中，`dsh web --port 13185`：

- `pluginManager/listPlugins` 返回的探针条目只有 `enabled: true`、`fiberPhase: 'pending'`，没有其他信息。
- 几秒后该条目仍是 `pending`，没有任何接口说明原因。

### 这些信息其实已经存在

`Fiber._refresh`（`vendor/cordis/src/fiber.ts:611-621`）逐个遍历 `Object.keys(this.inject)`，一旦发现 `this._store[name]` 缺失，就把 fiber 标记为未激活。缺失的这些名字，正是尚未解析的 service 列表。随后 `_getState`（`vendor/cordis/src/fiber.ts:574-579`）把「没有 epoch」映射为 `FiberState.PENDING`。

### 建议改动

给 `PluginInventoryEntry`（`packages/host/plugin-inventory/src/types.ts:17`）和预设行各加一个可选字段：

```ts
/** Injected services this entry's fiber is still waiting for; present only while it is pending on them. */
readonly missingServices?: readonly string[]
```

- `readPluginInventory`（`packages/host/plugin-inventory/src/index.ts`）对处于 pending 的 fiber 填充这个字段，取 `fiber.inject` 中在该 fiber 已解析的 store 里找不到的名字。
- 如果 Cordis 对可选（非必需）的注入另有记录，应把它们排除在外。
- `listPlugins` 原样透传这个字段。

### 影响

- 网页界面可以在一个始终启动不了的插件旁显示「正在等待 service X」。
- dshenv 这类工具（`dshenv runtime` 目前只能说插件「在等待它注入的 service」）可以直接指出缺失的 service，并提示应该安装哪个提供它的插件。
