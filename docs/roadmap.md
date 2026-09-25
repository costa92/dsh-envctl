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

### Phase 2B：官方管理器适配与环境接管（待单独规划）
- [ ] 确定 live manager service 的公开连接与认证契约
- [ ] 目标 DSH 精确版本的 operations fixture 与 live service 契约测试通过
- [ ] Phase 2A 可针对具体计划判定全部 required capabilities
- [ ] 单独审阅 `state.json` 所有权 Schema 与迁移方案
- [ ] 配置 Git remote，建立可追踪发布路径
- [ ] 挂载 `@deepseek-ai/dsh-plugin-manager` 官方写适配器与 Profile 独占写锁
- [ ] 实现 `apply` 状态机与 `adopt` 显式接管命令

以上门禁未满足前，仅继续只读探测、诊断和文档工作，不注册 Phase 2B 写命令。

### Phase 3: 受管 Git 与本地源码生命周期
- [ ] 受管 Git 插件自动化 clone / fetch / fast-forward 校验
- [ ] 脏工作树安全拒绝保护（防代码丢失）
- [ ] 本地源码构建审批与 digest 校验机制
- [ ] 离线 bundle/entry 协调适配器

### Phase 4: 事务日志、回滚与垃圾清理
- [ ] 操作级事务日志 (`$DSH_HOME/envctl/logs/`)
- [ ] `rollback` 命令：状态秒级回退与补偿机制
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
