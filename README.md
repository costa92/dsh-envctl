<!-- generated-by: gsd-doc-writer -->

# dshenv (dsh-envctl)

`dshenv` 是用于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的声明式环境与插件管理工具（Environment-as-Code layer）。

它构建在 DSH 官方插件管理器协议与能力之上，通过声明式清单（`manifest.yaml`）和精确锁文件（`lock.json`）管理多 Profile 的插件、精确版本与配置补丁。

当前提供环境探测、Profile 盘点、捕获与接管、声明式插件管理、差异比对、健康诊断，以及范围受限的实际应用能力。`apply` 目前通过 DSH CLI 执行插件 `install/update`；启用、停用、实际卸载和配置补丁尚未接入执行适配器。

---

## 核心特性

- **审阅后应用**：`plan` 与 `apply --dry-run` 先展示影响，正式 `apply` 当前仅对 `install/update` 调用 DSH CLI，并在执行后重新盘点确认收敛。
- **声明式漂移检测**：自动计算实际安装态与目标清单差异（`plan` / `status`）。
- **无损环境捕获与接管**：将现有 DSH Profile 盘点为可审阅的候选清单（`capture`），确认事实未过期后再建立所有权（`adopt`）。
- **多运行时与能力探测**：无缝支持源码运行模式（`--harness-source`）、环境变量（`DSH_CLI`）及全局 PATH 探测（`doctor`）。
- **结构化成功输出**：所有命令的成功结果均支持 `--json` 格式；错误当前仍以纯文本写入 stderr。

---

## 路径与解析优先级

Harness 主目录解析优先级：
1. CLI 参数 `--dsh-home <path>`
2. 环境变量 `DSH_HOME`
3. 默认用户主目录 `~/.dsh`

相对路径先按当前工作目录转为绝对路径。盘点读取 Profile 的 `package.json`（`dsh.profile.bundles` + `dependencies`），不把 `node_modules` 中的传递依赖当成插件，也不跟随 Profile 外的 symlink 读取包元数据。

DSH 运行时命令解析优先级：
1. 环境变量 `DSH_CLI`（支持 JSON 数组或字面执行文件名，绝不进入 shell）
2. `--harness-source <path>` / 清单中的 `environment.harness.sourceDir`（转换为 `pnpm --dir <sourceDir> dsh`）
3. 系统 `PATH` 中的 `dsh`

---

## 安装与快速上手

### 本地链接安装

```bash
cd /path/to/dsh-envctl
pnpm install
pnpm build
pnpm link --global
```

验证安装：
```bash
dshenv --version
```

完整流程、能力边界、agent-teams 示例和常见问题见 [中文使用教程](docs/使用教程.md)。

---

## 命令参考

### 1. `dshenv doctor`
探测 DSH 运行时能力并检查环境就绪状态。

```bash
# 自动探测系统 DSH
dshenv doctor

# 指定 DSH 源码目录
dshenv doctor --harness-source /Users/costalong/code/dsh/deepseek-harness

# 结构化 JSON 输出
dshenv doctor --json
```

`doctor --json` 在 `runtime.capabilities` 中逐项报告能力状态，并保留 `runtime.discoverySupported`、`runtime.mutationsSupported` 等兼容字段：

| 状态 | 含义 |
| :--- | :--- |
| `available` | 已知 DSH 版本支持该能力，且需要的本地证据已验证；仅表示该项能力可见。 |
| `requires-live-service` | 该能力依赖已连接并认证的 live manager service；当前阶段尚未建立其连接契约。 |
| `disabled` | 当前版本、探测证据或本工具的安全边界不允许使用该能力。 |

对已验证的 DSH `0.1.7-rc.2` 源码，`discovery` 与 `packageOperations` 为 `available`，`bundleSelection` 与 `entryToggle` 为 `requires-live-service`，`configurationValidation` 与 `environmentMutation` 为 `disabled`。`packageOperations` 需要官方 operations export 的声明及目标文件均通过只读探测；只通过 DSH 命令探测、缺少可验证源码时，该项为 `disabled`。

`runtime.mutationsSupported=false`（能力矩阵中的 `mutations=false`）表示通用、完整的环境写能力仍未开放。它不代表 `apply` 命令不存在：当前 `apply` 通过范围受限的 DSH CLI 适配器执行插件 `install/update`。`enable/disable/remove`、配置补丁和完整环境变更仍不受支持。

### 2. `dshenv init`
在 `$DSH_HOME/envctl/` 下初始化空的清单、锁文件与初始状态。

```bash
dshenv init
dshenv init --dsh-home /path/to/custom-dsh
```

### 3. `dshenv capture`
无损盘点现有 DSH Profile 并生成待审阅的候选清单。

```bash
# 输出到控制台
dshenv capture

# 只捕获一个 Profile
dshenv capture --profile web

# 原子写入审阅文件（若目标文件已存在则拒绝覆盖）
dshenv capture --output my-dsh-backup.yaml
```

### 4. `dshenv adopt`
接管来自 `capture` 生成的候选清单，建立明确的插件所有权记录。

```bash
# 校验候选事实一致性并接管所有权
dshenv adopt --from my-candidate.yaml

# 跳过交互确认
dshenv adopt --from my-candidate.yaml --yes
```

### 5. `dshenv plan`
比对期望清单与当前 Profile 实际安装状态，计算变更计划。

```bash
dshenv plan
```

### 6. `dshenv apply`
基于受管清单与锁文件，将期望状态安全收敛应用到 DSH 运行环境中（具备独占写锁、快照备份与操作日志审计）。

```bash
# 模拟执行（不修改磁盘或获取排他锁）
dshenv apply --dry-run

# 执行变更并提交状态
dshenv apply --yes
```

当前只执行计划中的 `install/update`。`enable/disable` 会明确返回能力错误；从清单删除插件不会生成实际卸载操作。

### 7. `dshenv status`
显示当前环境状态摘要与操作统计。

```bash
dshenv status
dshenv status --json
```

---

## 退出码规范

| 退出码 | 含义 |
| :--- | :--- |
| `0` | 成功 / 环境与清单完全同步（Clean） |
| `1` | 通用 CLI 错误 / 参数解析失败 |
| `2` | 存在有效变更计划（Drifted） |
| `3` | 输入或清单格式校验失败（ValidationError） |
| `4` | DSH 运行时能力不支持或未找到（CapabilityError） |
| `5` | 环境降级或运行时响应异常（DegradedError） |

---

## 安全边界与约束

1. **路径约束**：清单中的本地链接和本地文件路径必须为绝对路径；仍应只使用可信源码目录和规范的 npm 包名。
2. **凭据使用约束**：不要把明文密钥写入清单、锁文件、patch 配置或源码 `package.json`。`doctor` 不回显 `DSH_CLI` 参数，但 `source status --json` 会输出源码包摘要，使用前应检查其中是否含敏感字段。
3. **非受管保护**：实际 Profile 中未写入 `manifest.yaml` 的插件保持 `unmanaged`，不会被自动删除。
4. **锁与管理文件快照**：`apply` 执行前备份当时已经存在的 `manifest/lock/state` 并获取独占锁；失败时覆盖恢复这些快照文件，但不能恢复“原本不存在”的文件状态，也不保证撤销 DSH CLI 已完成的 Profile 包变更。失败后应重新运行 `status` 与 `plan`。

---

## 后续路线图

见 `docs/roadmap.md`。后续版本计划交付：
- 将 Git 源准备、锁定与 `apply` 生命周期完整串联
- Profile 级 `rollback` 与垃圾回收（`gc` / `purge`）
- `enable/disable` 与真实卸载适配
- 细粒度 live manager service 双向通讯
