## Motivation

升级一个已经安装的插件（`dsh plugin add <pkg>@<新版本>` 或 `pluginManager.installBundle`）总是需要重启 DSH，即使 `dsh-hmr` 已经启用也一样。先移除插件再重新选中，或者让热加载监视插件的安装目录，都不管用：运行中的 DSH 一直执行它最先导入的那份模块。install、enable、disable、remove 和配置修改都已经能即时生效，唯独升级必须重启。dshenv（DSH 的声明式插件环境管理工具）这类工具因此只能对每次升级都提示用户重启。

### 实测（npm 版 `@deepseek-ai/dsh@0.1.7-rc.2`，源码 `7dfe937257`；以下引用在 `46a7f68b09` 上仍一致）

探针插件：一个 bundle，入口模块在被执行时向文件追加 `evaluate <版本> <时间戳>`，在 `apply` 运行时追加 `apply <版本>`。使用隔离的 `DSH_HOME`，`dsh web --port 13184`。

| 步骤 | 结果 |
|---|---|
| 安装 1.0.0，启动 `dsh web` | `evaluate 1.0.0 T1`、`apply 1.0.0` |
| 保持选中，执行 `dsh plugin --profile web add probe-2.0.0.tgz` | 磁盘上已是 2.0.0；没有任何重载，运行的仍是 1.0.0 |
| 从 `dsh.profile.bundles` 移除该 bundle，等待后再加回 | `apply 1.0.0 (module evaluated T1)`：重新 apply 了，但用的是缓存中的 1.0.0 模块，2.0.0 从未被读取 |
| profile 补丁 `- id: hmr`，`config.root: [<profile>/node_modules/<pkg>]`、`ignored: []`，重启后升级或直接修改已安装文件 | 没有重载 |

### 原因

- profile 以 `nodeLinker: hoisted` 安装（`packages/boot/app-boot/src/profile.ts:208`），一个包的每个版本都在同一个 `node_modules/<包名>` 路径下，解析到同一个文件 URL。
- Node 的 ESM 模块表从不清除，之后对该 URL 的 `import()` 都返回第一次加载的模块。
- `installBundle` 已经据此提前返回：`if (Object.hasOwn(before, name)) return 'restart-required'`（`packages/boot/plugin-manager/src/index.ts:561`）。
- `dsh-hmr` 能清除缓存并重新导入（`packages/boot/hmr/src/index.ts:469-485` 的 `Map.prototype.delete.call(this.internal.loadCache, filename)` 与 `require.cache` 处理），但只针对监视器报告的文件，而 `node_modules` 默认被忽略。

## Behavior

`hmr` 服务存在时，`installBundle`（或 `dsh plugin add`）替换一个已安装的包后，运行中的 DSH 加载新版本，无需重启：

1. 取消选中该 bundle 的各行，让它们的 fiber 释放。
2. 清除文件位于该包目录下的所有 `loadCache` / `require.cache` 条目。
3. 执行安装，重新选中该 bundle，由加载器导入新文件。
4. 成功时返回 `application: 'applied'`；任何一步失败，仍返回现在的 `'restart-required'`。

`hmr` 不存在时行为不变。

可选：在 `listBundles` 或插件清单中暴露实际加载的包版本，让工具能确认运行的是哪个版本。
