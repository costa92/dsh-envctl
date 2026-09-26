# dshenv 后续规划与路线图

本路线图基于 `docs/superpowers/specs/2026-09-25-dsh-environment-manager-design.md` 设计。

---

## 阶段规划

### Phase 1: 只读原型（0.1.0，已验证）
- [x] CLI 骨架与环境路径解析
- [x] 声明式清单 (`manifest.yaml`)、锁 (`lock.json`) 与状态格式及校验
- [x] 安全 DSH 运行时能力探测 (`doctor`)
- [x] 只读 Profile 盘点 (`inventory`)
- [x] 无损环境捕获 (`capture`)
- [x] 确定性变更比对与状态映射 (`plan`, `status`)

验证基线：13 个测试文件、62 项测试通过；`typecheck` 通过；隔离 `doctor` 能识别 DSH `0.1.7-rc.2`，并保持 `mutations=false`。

### Phase 2A：只读能力基础设施（已验证）
- [x] 精确识别已验证的 DSH `0.1.7` 版本族，拒绝 `0.1.70` 等相似版本
- [x] 只读探测官方 operations export 的声明与目标文件，不执行插件管理器代码
- [x] 建立细粒度能力矩阵与单向收紧的证据评估
- [x] `doctor` 增加能力状态，并保留原有 JSON 字段与 `mutations=false`

验证记录（2026-09-25）：Node `v25.2.1`、pnpm `10.24.0`；`pnpm test` 为 16 个文件、102 项测试通过，`pnpm typecheck`、`pnpm build` 与 `git diff --check` 通过。隔离真实源码 `doctor` 识别 DSH `0.1.7-rc.2`：`discovery` 和 `packageOperations` 为 `available`，`bundleSelection` 和 `entryToggle` 为 `requires-live-service`，`environmentMutation` 为 `disabled`，`mutationsSupported=false`。全局命令用相同隔离参数验证；fixture 不产生 `envctl`，Harness 仓库不变。

### Phase 2B：官方管理器适配与环境接管（已实现）
- [x] 确立所有权 Schema（`ownership` 字典记录 `adoptedAt`、`adoptedBy` 与 `lockedVersion`）
- [x] 实现 `adopt --from <candidate>` 命令：校验候选事实一致性，生成所有权记录
- [x] 实现独占写锁（`acquireEnvironmentLock`）、快照备份（`backups/`）与操作日志（`logs/journal.jsonl`）
- [x] 正式 `apply` 先加锁再读取清单、盘点与计划，避免 rollback/purge 间隙导致执行过期计划；`--dry-run` 不加锁
- [x] 锁被占用时每 100ms 重试直至 `timeoutMs`（默认 5 秒）；无法解析的锁文件超过 5 秒才视为陈旧，避免抢走正在写入的锁
- [x] 陈旧锁接管经 `mkdir` 守卫串行化，并发等待方不会同时接管；守卫残留时报错提示手工删除，不自动回收
- [x] 实现 `apply` 状态机执行器（支持 `--dry-run`、能力检查与异常自动快照回滚）
- [x] `apply` 通过 DSH CLI 执行 `install/update`，执行后复盘；正式 apply 需要 `--yes`
- [x] `apply` 按 `dsh.profile.bundles` 执行 `enable/disable`（禁用保留依赖）
- [x] 受管插件 `remove`：仅 `state.ownership` 中且已离开清单的包，先改 bundles 再 `dsh plugin remove`
- [x] `configure`：digest 不一致时写入 `cordis.patch.yml` 受管块
- [x] 同一插件的多项差异一次列全（install/update → enable/disable → configure），单次 `apply` 即可收敛
- [x] 全量测试套件覆盖率（21 个测试文件，163 项测试全部通过）

### Phase 3: 受管 Git、Patch 管理器与便捷 CLI 命令（已实现）
- [x] 受管 Git 插件自动化 clone / fetch / fast-forward 校验 (`src/source/git.ts`)
- [x] 脏工作树安全拒绝保护（防用户本地代码丢失）
- [x] 本地源码目录构建审批与递归 SHA256 digest 校验机制 (`src/source/local.ts`)
- [x] apply 成功后把本地来源源码 digest 写入 lock；plan 在 digest 变化或未记录时对已装本地插件 `update`
- [x] 受管 YAML Patch 块插入、提取、校验与移除适配器 (`src/patch/patch.ts`)
- [x] 便捷插件管理命令：`install`、`update --to`、`enable`、`disable`、`remove`、`list`、`config get|validate|set`、`source status|clone|pull` (`src/commands/plugins.ts`、`src/commands/source.ts`)
- [x] `source clone --profile` 写入 `envctl/sources` 并锁定 commit，plan/apply 可安装 git 插件
- [x] `source pull --profile` 更新 lock commit；apply 成功后标记 `restart-required`
- [x] 标记 `restart-required` 时写入复盘得到的 `installedVersion`，不再丢弃该字段
- [x] plan 比对 Profile 依赖 spec 的 `#<commit>` 与 lock commit，不一致时 `update` 重装锁定 commit（无 commit 证据不猜）
- [x] 全量测试套件覆盖（当前 36 个测试文件，234 项测试全部通过）

### Phase 4: 事务日志、回滚与垃圾清理（已实现）
- [x] 操作日志写入 `journal.jsonl`（apply/rollback/gc）
- [x] `rollback`：从 `envctl/backups/` 恢复管理文件；需要 `--yes`；不撤销 DSH 包变更
- [x] `gc`：只删除 `envctl/trash` 内过期项；需要 `--yes`
- [x] apply 执行失败时恢复管理文件快照
- [x] apply 执行失败时逆序撤销本工具对 Profile bundles（保留原位置）与 `cordis.patch.yml` 的改动；DSH 已完成的卸载不回滚
- [x] `purge`：有 ownership 的受管 patch（及 `envctl/sources` clone）移入 trash；外部路径拒绝

### Phase 5：Base + Overlay 清单合并（已实现）
- [x] `envctl/overlays/<name>.yaml` 叠加 base，按别名/patch id 合并，支持新增、字段覆盖、`remove: true`、`environment` 覆盖
- [x] 本机持久选择（`overlay use`），`--overlay` / `--no-overlay` / `DSHENV_OVERLAY` 临时覆盖；缺失即报错，不退回 base
- [x] 出处：`list` 的 `origin`、`overlay show`
- [x] 有生效 overlay 时写入命令必须指定 `--layer`
- [x] apply 在锁内加载合并清单，state 记录 `appliedOverlay`，切换时警告
- [x] lock 只细化合并清单：npm 目标版本以清单为准，git url 不一致时不沿用 lock commit；`--layer base` 写入（含 `adopt`、`source clone`）前校验与 overlay 可合并
- [x] npm 版本只允许精确版本（schema、`install`、`update --to`、`capture`），避免范围与已装版本永远不一致
- [x] git 清单声明的 `commit` 与 lock 缺失或不一致时 `blocked` 并给出处理指引，不再静默以 lock 为准
- [x] 选了 overlay 但 base 清单不存在时 `doctor` 照常出报告（`manifestExists: false`），overlay 文件仍单独校验
- [x] 全量测试套件覆盖（当前 50 个测试文件，362 项测试全部通过）

### 审查修复（2026-09-26 第二轮）
- [x] A 批（数据安全）：`purge` 拒绝移走有未提交改动的受管克隆；包名不得以 `.` 开头；每次写 base 清单前做 schema 校验；`adopt` 遇到不可读的现有文件报错而不覆盖，并沿用清单已有别名
- [ ] B 批（配置 patch）：多 patch、`$` 替换、别名转义、patch `enabled`/删除清理、块外空行
- [ ] C 批（收敛）：in-box 禁用、禁用插件升级、来源类型切换、capture 本地 digest、空 apply 记录 overlay
- [ ] D 批（待定方案）：`restart-required` 清除、git URL 凭据、写命令加环境锁、rollback 前备份、原子写保留软链接与权限、本地/git 包名取 `package.json`、base 重装保留 patch

## 延后能力

下列项有价值，但引入独立的兼容或数据模型子系统，不进入近期阶段：

- 动态 HMR / 调用运行时内部 service（如 `ctx.dynamicCordisRunner`）
- 静态 Cordis Service DAG 分析（需插件暴露机器可读的服务贡献元数据）
- GitHub Actions、容器示例、远程环境分发
- GUI / TUI / 插件市场 / 主观发行版
- 自动重启非本工具启动的 DSH 进程
- Desktop 内嵌 Harness 管理
