## Motivation

如果一个插件的 `inject` 里有某个 service 没有任何已加载的插件提供，它会永远停在 fiber 阶段 `pending`。`pluginInventory.list` 和 `pluginManager.listPlugins` 显示 `fiberPhase: 'pending'`，但不说明缺的是哪个 service。用户分不清「还在加载」和「永远加载不了」，也找不到该安装或启用哪个插件。dshenv 的 `dshenv runtime` 目前只能说插件「在等待它注入的 service」；静态分析各包的 `inject` 声明也不可靠，因为很多插件在运行时计算 `inject`，或在函数内部用 `ctx.inject` 按需依赖。

### 实测（npm 版 `@deepseek-ai/dsh@0.1.7-rc.2`，源码 `7dfe937257`；以下引用在 `46a7f68b09` 上仍一致）

探针 bundle 的插件声明 `export const inject = ['spikeMissingService']`，安装到隔离的 profile 中，`dsh web --port 13185`：

- `pluginManager/listPlugins` 返回的探针条目只有 `enabled: true`、`fiberPhase: 'pending'`。
- 几秒后仍是 `pending`，没有任何接口说明原因。

### 这些信息已经存在

`Fiber._refresh`（`vendor/cordis/src/fiber.ts:611-621`）遍历 `Object.keys(this.inject)`，一旦 `this._store[name]` 缺失就把 fiber 标记为未激活，缺失的这些名字就是尚未解析的 service。随后 `_getState`（`vendor/cordis/src/fiber.ts:574-579`）把「没有 epoch」映射为 `FiberState.PENDING`。

## Behavior

插件清单条目在 fiber 因缺少注入的 service 而 pending 时，列出缺少的 service 名称：

```ts
/** Injected services this entry's fiber is still waiting for; present only while it is pending on them. */
readonly missingServices?: readonly string[]
```

- 字段加在 `PluginInventoryEntry`（`packages/host/plugin-inventory/src/types.ts:17`）和预设行上。
- `readPluginInventory`（`packages/host/plugin-inventory/src/index.ts`）对 pending 的 fiber 填充：取 `fiber.inject` 中在该 fiber 已解析的 store 里找不到的名字；Cordis 若另有可选注入的记录，排除可选项。
- `listPlugins` 原样透传。

这样网页界面可以在启动不了的插件旁显示「正在等待 service X」，dshenv 等工具可以直接指出缺失的 service 并提示需要哪个插件提供它。
