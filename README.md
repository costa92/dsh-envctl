# dshenv (dsh-envctl)

`dshenv` 是用于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的声明式环境与插件管理工具（Environment-as-Code layer）。

它构建在 DSH 官方插件管理器协议与能力之上，通过声明式清单（`manifest.yaml`）和精确锁文件（`lock.json`）管理多 Profile 的插件、精确版本与配置补丁。

当前处于 **Phase 2A 只读能力基础设施** 阶段，提供环境探测、Profile 盘点、环境捕获、状态汇总、差异比对及健康诊断功能，不修改 DSH 现有环境与 Profile。DSH 环境写命令仍未开放。

---

## 核心特性

- **安全只读**：`init` 仅写入 `$DSH_HOME/envctl/*`，`capture --output` 仅写入显式指定的审阅文件；Profile、依赖与运行时数据保持只读。
- **声明式漂移检测**：自动计算实际安装态与目标清单差异（`plan` / `status`）。
- **无损环境捕获**：一键将现有 DSH Profile 盘点为可审阅的候选清单（`capture`）。
- **多运行时与能力探测**：无缝支持源码运行模式（`--harness-source`）、环境变量（`DSH_CLI`）及全局 PATH 探测（`doctor`）。
- **结构化输出**：所有命令均支持 `--json` 格式，方便 CI/CD 及脚本编排。

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

`runtime.mutationsSupported=false`（能力矩阵中的 `mutations=false`）在 Phase 2A 始终成立。`packageOperations` 可见只说明官方包操作接口存在，**不代表 `apply` 可用**；本工具尚未注册 `apply` 或其他 DSH 环境写命令。

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

1. **绝对路径与防越权**：所有外部本地链接和文件路径必须为绝对路径；包名必须严格匹配 npm 命名规范，防止路径穿越攻击。
2. **凭据与脱敏**：清单与锁文件中禁止嵌入明文密钥，敏感环境变量与 Authorization header 不进入日志与输出。
3. **非受管保护**：非受管插件在未被 `adopt` 接管前保持 `unmanaged`，绝不执行静默删除。
4. **事务与回滚**：`apply` 执行前强制创建快照备份并获取独占锁，异常中断自动回滚恢复。

---

## 后续路线图

见 `docs/roadmap.md`。后续版本计划交付：
- 受管 Git 插件生命周期（clone/fetch/fast-forward）与构建审批
- `rollback` 与垃圾回收（`gc` / `purge`）
- 细粒度 live manager service 双向通讯
