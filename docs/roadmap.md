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
- [x] 实现 `apply` 状态机执行器（支持 `--dry-run`、能力检查与异常自动快照回滚）
- [x] `apply` 通过 DSH CLI 执行 `install/update`，执行后复盘；`enable/disable` 在执行前拒绝；正式 apply 需要 `--yes`
- [x] 全量测试套件覆盖率（21 个测试文件，163 项测试全部通过）

### Phase 3: 受管 Git、Patch 管理器与便捷 CLI 命令（已实现）
- [x] 受管 Git 插件自动化 clone / fetch / fast-forward 校验 (`src/source/git.ts`)
- [x] 脏工作树安全拒绝保护（防用户本地代码丢失）
- [x] 本地源码目录构建审批与递归 SHA256 digest 校验机制 (`src/source/local.ts`)
- [x] 受管 YAML Patch 块插入、提取、校验与移除适配器 (`src/patch/patch.ts`)
- [x] 便捷插件管理命令：`install`、`enable`、`disable`、`remove`、`source status|clone|pull` (`src/cli.ts`)
- [x] 全量测试套件覆盖（25 个测试文件，178 项测试全部通过）

### Phase 4: 事务日志、回滚与垃圾清理
- [ ] 操作级事务日志回放 (`$DSH_HOME/envctl/logs/`)
- [ ] `rollback` 命令：状态秒级回退与快照恢复补偿机制
- [ ] 受管资源软删除与垃圾回收 (`trash/` & `gc`)
- [ ] 异常失败注入测试与自愈机制

## 延后能力

下列项有价值，但引入独立的兼容或数据模型子系统，不进入近期阶段：

- Base + Overlay 清单合并与出处规则
- 动态 HMR / 调用运行时内部 service（如 `ctx.dynamicCordisRunner`）
- 静态 Cordis Service DAG 分析（需插件暴露机器可读的服务贡献元数据）
- GitHub Actions、容器示例、远程环境分发
- GUI / TUI / 插件市场 / 主观发行版
- 自动重启非本工具启动的 DSH 进程
- Desktop 内嵌 Harness 管理
