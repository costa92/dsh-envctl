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
- [x] 全量测试套件覆盖（当前 58 个测试文件，417 项测试全部通过）

### 审查修复（2026-09-26 第二轮）
- [x] A 批（数据安全）：`purge` 拒绝移走有未提交改动的受管克隆；包名不得以 `.` 开头；每次写 base 清单前做 schema 校验；`adopt` 遇到不可读的现有文件报错而不覆盖，并沿用清单已有别名
- [x] B 批（配置 patch）：同插件多个 patch 各占一块并整体收敛；`enabled: false` 与删掉的 patch 会被清除；写入不再展开 `$` 模式；别名按字面匹配且不得含空白；删除块不再压缩块外空行
- [x] C 批（收敛）：in-box 插件不在 bundles 视为禁用；来源类型切换触发重装；无变更的 apply 也记录当前 overlay，`adopt` 保留该记录（禁用插件升级、capture 本地 digest 两条经核对为预期行为，不改）
- [x] D 批（按用户选定方案）：新增 `restarted` 清除 `restart-required`；拒绝带凭据的 git URL；所有写管理文件的命令加环境锁；rollback 先存当前文件快照再原子恢复；原子写经软链接写目标并保留权限；本地目录与 source clone 取 `package.json` 包名、git URL 支持 `--package`；重复 install / source clone 只替换来源
- [x] 低优先级：`__proto__`/`constructor`/`prototype` 不得作 profile 名或别名；plan 不再显示 `-> latest`、`? -> ?`；README 更正 `adopt --yes`；其他用户进程持有的锁（EPERM）不再被当作失效

### GitHub Actions（已实现）
- [x] 仓库 CI：`.github/workflows/ci.yml` 在 Node 22/24 上以 frozen lockfile 跑 typecheck、test、build
- [x] 使用者示例：`docs/examples/github-actions/dshenv-check.yml`，`validate` 校验 base 与每个 overlay，`drift` 在 self-hosted runner 上以 `plan` 退出码做漂移门禁；测试会实际执行两段脚本

### 组件脚手架（`dshenv new`）（已实现）
- [x] `dshenv new <skill|agent|tool|mcp> <name>` 从 `templates/` 下的文件模板经 `{{key}}` 替换生成组件包；`--dir`、`--package`、`--typescript`（仅 tool）、`--loose`（仅 skill）
- [x] skill 默认生成 bundle（额外一行 `dsh-skill-filesystem` 挂载 `skills/`），`--loose` 直接写 `$DSH_HOME/skills/<name>/SKILL.md`，由 DSH 自动发现，不进清单
- [x] agent 生成 `dsh-agent-preset` + `dsh-persona`；tool 生成纯 JS `defineTool` 插件，peer 依赖 `@deepseek-ai/dsh-tools` 从运行中的 DSH 解析；mcp 生成 `dsh-mcp-client`
- [x] `-p` 复用 `install` 命令抽出的 `installPlugin`，登记失败时清理生成的目录，不自动 `apply`
- [x] 模板 peer 范围要求 DSH `>=0.1.7-0 <0.2.0-0`（agent 预设与 linked-package peer 解析在更早版本缺失）
- [x] 真实 DSH 冒烟验证（2026-09-26）：源码构建 0.1.7-rc.1 跑 `dsh web`，四类生成包全部加载成功（skill 列出、agent 预设注册、tool 注册且包内无 `node_modules`、mcp 仅因无服务端连接失败但无 schema 错误）；已安装的全局 0.1.5-rc.2 无法运行这些模板
- [x] npm 安装版冒烟验证（2026-09-26）：`@deepseek-ai/dsh@0.1.7-rc.2` 本地安装后跑 `dsh web`，skill、agent、JS tool 均加载；`--typescript` tool 经 `pnpm install && pnpm build` 后在 npm 版与源码版 0.1.7-rc.1 上均注册并可调用，`dsh-tools` 解析到运行中 DSH 的副本而非包内副本；mcp 行已激活并向配置地址发起连接（无真实 MCP 服务端，未注册工具）
- [x] 终审修复：模板中 `{{name}}` 标量加引号（`123`、`true` 等名称不再被 YAML 解析为非字符串）；`--dir` 为非目录或符号链接时报错且不删除；失败清理包括本次新建的父目录
- [x] 全量测试套件覆盖（当前 62 个测试文件，467 项测试全部通过）

### 容器示例（已实现）
- [x] `docs/examples/container/{Dockerfile,cordis.patch.yml,compose.yaml}`：镜像构建期把当前 dshenv 源码打包安装并 `COPY` 配置仓库的 `envctl/`，`dshenv apply --yes`、`dshenv plan` 校验无漂移后再 `dsh web`
- [x] home 级 `cordis.patch.yml` 把 webserver 监听改为 `0.0.0.0`（供 Docker 转发），CLI 本身拒绝 `--host`；端口只发布到 `127.0.0.1:3080:3080`（挡住局域网），不 `EXPOSE`、不传 `--trusted-host`；同一 Docker 网络内的容器仍可经容器 IP 访问、只剩启动 token 防护，文档建议使用独立网络
- [x] 命名构建上下文传入私有 dshenv 源码（未发布 npm）；DSH 版本固定 `0.1.7-rc.2`
- [x] 会话日志挂载命名卷 `dsh-data:/home/dsh/.dsh/sessions`，`profiles/`、`envctl/` 仍来自镜像不进卷
- [x] 真实 Docker 构建验证（2026-09-27）：scratch 配置仓库 apply/plan 通过，端口只回环可达、外部 Host 头访问 `/api` 被拒，容器重建后会话数据经卷保留、`storages/workspace.json` 按预期不保留

### 远程分发：团队共享基线（已实现）
- [x] `dshenv remote add/show/remove` 与 `dshenv sync`：订阅团队 Git 配置仓库（裸克隆于 `envctl/remote/repo.git`），采用 `<path>/manifest.yaml`、`lock.json`、`overlays/*.yaml`，固定到明确 commit 并记录于 `envctl/remote.json`（文件与 lock 条目的 sha256 摘要）
- [x] lock 按 `profile/alias` 条目归属：同步时只替换团队条目，本地 overlay 插件的 Git commit 与本地源摘要保留；团队 lock 不得含本机源条目
- [x] 预览（退出码 2）展示文件与 lock 条目的增删改及接受后的 plan；`--yes` 接受，只接受 fast-forward；`--ref` 限于订阅分支；接受后不自动 `apply`
- [x] 远程内容只读：写 base / 远程 overlay / 团队 lock 条目的命令一律拒绝，本机定制写本地 overlay；本地改动需 `--discard-local-changes` 才能覆盖，同名本地文件或条目需 `remote add --replace`
- [x] 快照与恢复覆盖 `remote.json` 与远程 overlay，`dshenv rollback` 可撤销 `sync`，中途写入失败自动恢复
- [x] `doctor` 报告订阅 URL、固定 commit 与被改动的远程文件和 lock 条目
- [x] 真实端到端验证（2026-09-27）：6 个手动验证步骤（订阅预览与接受、本机定制与写保护、团队更新的预览/接受/plan/`apply --dry-run`、快照回滚后再同步、本地改动冲突与 `--discard-local-changes`、凭据 URL 与历史改写拒绝）全部符合预期，未发现缺陷；并发文件锁另行验证（见下条）
- [x] 真实 apply 补测（2026-09-27）：npm 版 DSH `0.1.7-rc.2`、隔离 `DSH_HOME`，团队仓库固定真实 npm 插件 `@nanmicoder/dsh-agent-teams@0.1.21`；订阅后 `apply --yes` 真实安装、`dsh --dump-config` 可见插件层、`plan` 退出 0、`doctor` 无本地改动；本地 overlay 不影响 `sync`；团队禁用插件后 `sync --yes` + `apply --yes` 生效；`rollback <sync 快照 id> --yes` 回到首个状态后再次 fast-forward，未发现缺陷
- [x] 并发验证（2026-09-27）：团队提交更新后同时启动 3 个 `sync --yes` 进程，全部退出 0；恰好 1 个接受（固定到新 commit），另 2 个等锁后报已是最新；日志只有 1 条新的 `sync-completed`、只多 1 个快照，`remote show` 无本地改动，锁文件已释放
- [x] 全量测试套件覆盖（当前 75 个测试文件，600 项测试全部通过）

## 延后能力

下列项有价值，但引入独立的兼容或数据模型子系统，不进入近期阶段：

- 动态 HMR / 调用运行时内部 service（如 `ctx.dynamicCordisRunner`）
- 静态 Cordis Service DAG 分析（需插件暴露机器可读的服务贡献元数据）
- GUI / TUI / 插件市场 / 主观发行版
- 自动重启非本工具启动的 DSH 进程
- Desktop 内嵌 Harness 管理
