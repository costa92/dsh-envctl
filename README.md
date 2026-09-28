<!-- generated-by: gsd-doc-writer -->

# dshenv

`dshenv` 是用于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的声明式环境与插件管理工具（Environment-as-Code layer）。

它构建在 DSH 官方插件管理器协议与能力之上，通过声明式清单（`manifest.yaml`）和精确锁文件（`lock.json`）管理多 Profile 的插件、精确版本与配置补丁。

当前提供环境探测、Profile 盘点、捕获与接管、声明式插件管理、差异比对、健康诊断，以及范围受限的实际应用能力。`apply` 通过 DSH CLI 执行 `install/update/remove`，通过 Profile `dsh.profile.bundles` 执行 `enable/disable`，并通过 `cordis.patch.yml` 受管块执行 `configure`。调用 DSH CLI 前会用与 `doctor` 相同的版本矩阵做门禁。`remove` 只卸载 `state.ownership` 中且已从清单删除的插件。

---

## 核心特性

- **审阅后应用**：`plan` 与 `apply --dry-run` 先展示影响；正式 `apply` 对 `install/update/remove` 调用 DSH CLI，并在执行后重新盘点确认收敛。
- **声明式漂移检测**：自动计算实际安装态与目标清单差异（`plan` / `status`）。
- **无损环境捕获与接管**：将现有 DSH Profile 盘点为可审阅的候选清单（`capture`），确认事实未过期后再建立所有权（`adopt`）。
- **多运行时与能力探测**：无缝支持源码运行模式（`--harness-source`）、环境变量（`DSH_CLI`）及全局 PATH 探测（`doctor`）。
- **结构化输出**：所有命令的成功结果均支持 `--json` 格式；带 `--json` 时错误以 `{"error":{"type","message","exitCode"}}` 写入 stderr（命令行参数解析错误除外，仍为 commander 的纯文本）。
- **组件脚手架**：`dshenv new` 从模板生成 skill/agent/tool/mcp 组件包，可选直接登记进清单。
- **团队共享基线**：`dshenv remote add` 订阅团队 Git 配置仓库，`dshenv sync` 预览并显式接受固定 commit 的更新；远程文件与团队 lock 条目只读，本机定制写本地 overlay，其插件的 lock 条目照常由本机维护。

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

跨机器同步 `manifest.yaml` 与 `overlays/`；`lock.json`、`state.json`、`overlay-selection.json` 只属于本机。

---

## 安装与快速上手

### 从 npm 安装（推荐）

```bash
npm install -g @costa92/dshenv
# 或
pnpm add -g @costa92/dshenv
dshenv --version
```

npm 包已含构建好的 `lib/`，安装时不需要构建；固定版本用 `@costa92/dshenv@0.2.0`。各版本见 [Releases](https://github.com/costa92/dshenv/releases)（附同一份 `.tgz`），变更见 [CHANGELOG](CHANGELOG.md)。

### 从 Git 地址安装

```bash
pnpm add -g --allow-build=@costa92/dshenv "git+https://github.com/costa92/dshenv.git#v0.2.0"
```

`#` 后可换成其他 tag、commit 或 `master`（未发布的最新代码）。安装时 pnpm 会在克隆中执行 `prepare` 构建 `lib/`；pnpm 10 默认不运行依赖的构建脚本，所以必须带 `--allow-build=@costa92/dshenv`，否则安装后缺少 `lib/` 无法运行。npm 从 Git 地址安装时会在准备阶段崩溃（npm 10.9 arborist 缺陷），请使用 pnpm。

### 本地链接安装

```bash
cd /path/to/dshenv
pnpm install
pnpm build
pnpm link --global
```

验证安装：
```bash
dshenv --version
```

完整流程、能力边界、agent-teams 示例和常见问题见 [中文使用教程](docs/使用教程.md)。

DSH 发布新版本时，用 `make smoke-dsh DSH_VERSION=<版本>` 验证兼容性，放宽版本门禁的步骤见 [DSH 新版本兼容验证](docs/DSH版本升级.md)。

发布新版本的步骤见 [发布流程](docs/发布流程.md)。

---

## 命令参考

### 1. `dshenv doctor`
探测 DSH 运行时能力并检查环境就绪状态。

```bash
# 自动探测系统 DSH
dshenv doctor

# 指定 DSH 源码目录
dshenv doctor --harness-source "$HOME/code/dsh/deepseek-harness"

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

`runtime.mutationsSupported=false`（能力矩阵中的 `mutations=false`）表示通用、完整的环境写能力仍未开放。它不代表 `apply` 命令不存在：当前 `apply` 通过 DSH CLI 执行 `install/update/remove`，通过 Profile `dsh.profile.bundles` 执行 `enable/disable`，并对 `configure` 写入 `cordis.patch.yml` 受管块。计划之外的通用环境变更仍不受支持。

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
```

`adopt` 没有交互确认，会直接写入清单、锁文件和状态；`--yes` 为兼容保留，不改变行为。执行前请先审阅候选文件。

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

当前执行计划中的 `install/update/enable/disable/remove/configure`。`configure` 只写入 Profile `cordis.patch.yml` 的受管块。没有所有权记录的实际插件只标为 `unmanaged`，不会卸载。

`apply`（含 `--dry-run`）会对有操作的 Profile 各运行一次 `dsh --profile <p> --dump-config`（超时 15 秒），读其中的 `hmr` 行判断 DSH 热加载是否开启，据此报告哪些改动无需重启：

| 操作 | 热加载开启 | 热加载关闭或无法判断 |
| --- | --- | --- |
| `install`、`enable`、`disable`、`configure`、`remove` | 无需重启（state 记为 `healthy`，`remove` 删除条目） | 需要重启（`restart-required`） |
| `update`（npm 版本、Git commit、本地源码变化） | 需要重启 | 需要重启 |

成功后在计划之后输出分组，某组为空时省略，没有需要重启的项时不输出 `Then run` 行：

```text
No restart needed:
  [web] enable @nanmicoder/dsh-agent-teams
Restart DSH to load:
  [web] update shared-plugin (package updates are not hot-reloaded)
  [cli] install tool-x (hot reload is off for profile cli)
Then run: dshenv restarted
```

`--dry-run` 在每个计划操作后标注 `(no restart)` 或 `(restart required: <原因>)`。`--json` 结果新增 `restart: { notRequired, required }`，每项为 `{ profile, package, kind, reason, detail? }`，`reason` 取 `hmr-on`、`package-update`、`hmr-off`、`hmr-unknown`，`detail` 只在 `hmr-unknown` 时出现，为探测失败的原因。Profile 尚未创建时不运行探测（`--dump-config` 会创建 Profile），按无法判断处理。

dshenv 改写 Profile `package.json`（启用、停用、卸载前移出 bundle）或 `cordis.patch.yml`（写入、清除受管块及回滚恢复）时持有 DSH 的 `package.json.lock`，被占用时最多等 30 秒。热加载开启时卸载插件会先移出 bundle、等待 3 秒让 DSH 卸下插件，再调用 `dsh plugin remove`；插件本来就不在 bundle 列表中时不等待。apply 失败回滚 `cordis.patch.yml` 时，如果 DSH 在 dshenv 写入之后又改过该文件，只把该插件的受管块恢复原样，DSH 的改动保留。

几点说明：

- 「无需重启」表示 DSH 会自动重新加载；dshenv 不确认插件是否真的加载成功（DSH 只在日志里记录重新加载失败）。
- `configure` 会列在分组里，但不写入 state，所以只含 `configure` 的 apply 之后运行 `dshenv restarted` 可能显示清除了 0 个插件。
- 判定为无需重启的 `remove` 会连同该插件此前的 `restart-required` 条目一起删除（插件已经不在了）。
- 等 Profile 锁超时后 apply 会回滚，但回滚本身写 bundle 与 `cordis.patch.yml` 时也可能要等这把锁；回滚未能完成时运行 `dshenv plan` 查看现状。DSH Web 安装插件时整个安装过程都持锁，可能超过 dshenv 的 30 秒等待，等安装结束后再重试。

### 7. `dshenv rollback`
从 `envctl/backups/` 恢复最近一次（或指定 operation id 的）管理文件快照。只恢复 `manifest.yaml` / `lock.json` / `state.json`，不撤销已经发生的 DSH 包安装。恢复前会把当前三个文件另存为一份新快照（输出中给出其 id，可再 rollback 回去）；快照里没有的文件会被删除。

```bash
dshenv rollback --dry-run
dshenv rollback --yes
dshenv rollback apply-abc123 --yes
```

### 8. `dshenv gc`
删除 `envctl/trash/` 中超过保留期的条目。默认 7 天。不会删除 trash 目录之外的路径。

```bash
dshenv gc --dry-run
dshenv gc --yes
dshenv gc --older-than 3 --yes
```

### 9. `dshenv purge`
把有所有权的受管 patch（以及 `envctl/sources/<profile>/<package>` 下的 clone）移入 `envctl/trash/<operation-id>`。不删除外部 Git 目录、Profile 根或凭据。

```bash
dshenv purge agent-teams --profile web --dry-run
dshenv purge agent-teams --profile web --yes
```

### 10. `dshenv list`
列出清单中的插件，以及 plan 标出的 unmanaged 包。

```bash
dshenv list
dshenv list --profile web --json
```

### 11. `dshenv update`
只改清单（以及已有 lock 条目）里的精确 npm 版本，不解析 latest。随后用 `apply --yes` 真正更新。

```bash
dshenv update agent-teams --profile web --to 0.1.22
```

### 12. `dshenv config`
读取或改清单中的插件配置。`set` 只写 manifest；`apply` 才会落到 `cordis.patch.yml`。

```bash
dshenv config get agent-teams --profile web
dshenv config validate agent-teams --profile web
dshenv config set agent-teams taskPlanning captain --profile web
```

### 13. `dshenv status`
显示当前环境状态摘要与操作统计。

```bash
dshenv status
dshenv status --json
```

### 14. `dshenv source clone`
带 `--profile` 时克隆到 `envctl/sources/<profile>/<package>`，并把 HEAD commit 写入 lock；包名取仓库 `package.json` 的 `name`（可用 `--package` 指定）。带账号密码或 token 的 URL 会被拒绝，请改用 SSH 或 git credential helper。随后 `apply --yes` 才能安装。显式给出目标目录时仍可克隆到外部路径（`purge` 不会删除外部目录）。

```bash
dshenv source clone https://github.com/ex/plugin.git --profile web --as demo
dshenv source clone https://github.com/ex/plugin.git ./external-checkout
```

### 15. `dshenv overlay`
按机器/环境在 base 清单（`envctl/manifest.yaml`）之上叠加 `envctl/overlays/<name>.yaml`。

```bash
dshenv overlay use laptop      # 本机持久选择
dshenv overlay use --none      # 清除选择
dshenv overlay list            # 列出 overlay，标出当前生效项
dshenv overlay show --json     # 合并结果与每个插件的出处
dshenv plan --overlay server   # 单次命令临时指定
dshenv plan --no-overlay       # 单次命令只用 base
```

选择优先级：`--overlay` > `--no-overlay` > `DSHENV_OVERLAY` > 本机选择文件。选中的 overlay 不存在或无效时报错，不会退回只用 base。有生效 overlay 时，改清单的命令（`install`、`update`、`enable`、`disable`、`remove`、`config set`、`source clone --profile`、`adopt`）必须带 `--layer base` 或 `--layer overlay`。

### 16. `dshenv restarted`
`apply` 输出 `Restart DSH to load:` 分组时，其中插件的状态标为 `restart-required`（升级了已装插件，或该 Profile 的热加载关闭、无法判断）。热加载开启时的安装、启用、停用、配置与卸载当场生效，不需要本命令。重启 DSH 后运行本命令确认，清除该状态（已卸载插件的条目一并删除）。dshenv 无法自行判断 DSH 是否已重启。

```bash
dshenv restarted
dshenv restarted --profile web --json
```

#### runtime：核对运行中的 DSH 是否已加载

`apply` 只能推断改动是否已被热加载。`dshenv runtime` 登录运行中的 `dsh web`，读取 Plugin Manager 报告的真实加载状态，与清单对比：

```bash
export DSHENV_DSH_URL='http://127.0.0.1:3080/?token=...'   # dsh web 启动时打印的地址
dshenv runtime --profile web
```

- 地址只从环境变量 `DSHENV_DSH_URL` 读取。它等同于登录凭据，dshenv 不会输出或记录其中的 token；默认只连本机，连其他主机需加 `--allow-remote`。
- 只适用于 `dsh web`；headless、sdk、acp 运行不开 web 服务，无法核对。
- 每个插件的结果：`loaded`、`unloaded`（符合清单），`loading`（热加载进行中，也覆盖 `apply` 之后 DSH 还未热加载的瞬间；若持续为 `loading`，说明热加载没有生效，需重启 DSH；带 `is waiting for services it injects` 时，是插件依赖的 service 还没有任何插件提供，检查是否漏装或停用了提供它的插件），`unverifiable`（包没有可核对的插件行），`missing`、`failed`、`not-loaded`、`still-loaded`（与清单不符）。
- 退出码：`0` 全部符合；`2` 仍在加载，稍后重跑；`5` 有不符项；`1` 无法连接、登录失败或运行中的 DSH 不是该 profile；`3` 用法错误。
- 不核对版本：DSH 只报告磁盘上的版本，看不出内存中加载的是哪个版本；升级插件后仍需重启 DSH。

### 17. 在 CI 中使用
仓库自身的 CI 见 `.github/workflows/ci.yml`（Node 22/24 上跑 typecheck、test、build）。在你的配置仓库里校验清单与 overlay、在真实环境上做漂移门禁，可参考 `docs/examples/github-actions/dshenv-check.yml`，说明见 `docs/使用教程.md` 第 15 节。

### 18. `dshenv new`

从模板生成 DSH 组件包，可选直接登记进清单：

```bash
dshenv new skill code-review            # skill bundle：skills/code-review/SKILL.md
dshenv new skill code-review --loose    # 直接写入 $DSH_HOME/skills/code-review/SKILL.md
dshenv new agent reviewer               # agent 预设（dsh-agent-preset + dsh-persona）
dshenv new tool echo-text -p web        # 纯 JS tool 插件，并登记到 profile web
dshenv new tool echo-text --typescript  # TypeScript 版本，需先 pnpm install && pnpm build
dshenv new mcp docs-server              # MCP server 配置包
```

- 名称必须是 kebab-case；目标目录非空时拒绝。
- `-p` 等同于随后执行 `dshenv install <目录> -p <profile>`（支持 `--as`、`--layer`）；登记失败时删除生成的目录。不会自动 `apply`。

### 19. 容器示例

`docs/examples/container/` 提供构建 DSH Web 容器镜像的 `Dockerfile`、`compose.yaml` 与 `cordis.patch.yml`，镜像构建期执行 `dshenv apply` 装好清单声明的插件。安全要点：容器内监听 `0.0.0.0` 只是为了让 Docker 转发端口，宿主机端口必须只发布到 `127.0.0.1`（不要用 `-P`），否则会把 DSH Web 的 shell 执行能力暴露到局域网；回环发布挡不住同一 Docker 网络内的其他容器，它们能直接访问容器 IP 并通过 Host 校验，只剩启动 token 一道防线，因此应放在独立的自定义网络上（compose 的项目网络即可，但同项目新增的服务也能访问）。完整用法、构建参数与数据卷说明见 `docs/examples/container/README.md`。

### 20. `dshenv remote` 与 `dshenv sync`

团队在一个 Git 配置仓库中维护 base 清单、lock 与团队 overlay（默认读取仓库内 `envctl/`），成员订阅后按固定 commit 显式接受更新：

```bash
dshenv remote add git@github.com:team/dsh-config.git          # 预览：文件变化与接受后的 plan，退出码 2，不写文件
dshenv remote add git@github.com:team/dsh-config.git --yes    # 接受并固定到分支最新 commit
dshenv remote show                                           # URL、分支、固定 commit、远程文件与 lock 条目及本地改动
dshenv sync                                                  # 拉取并预览更新，退出码 2；已是最新时退出码 0
dshenv sync --yes                                            # 接受更新（只接受 fast-forward），之后自行 plan / apply
dshenv sync --ref v1.2.0 --yes                               # 移动到订阅分支上的某个 tag 或 commit
dshenv remote remove --yes                                   # 取消订阅，文件保留为本地文件
```

- 只采用 `<path>/manifest.yaml`（必需）、`<path>/lock.json`、`<path>/overlays/*.yaml`；`--path` 指定仓库内目录（`.` 为仓库根），`--branch` 指定分支（默认远程 HEAD 所指分支）。团队 manifest、团队 overlay 与团队 lock 都不能使用 `local-link` / `local-file` 源（本机路径无法跨机器共享），否则整个 commit 被拒绝。
- `manifest.yaml` 与团队 overlay 整文件归远程；`lock.json` 按 `profile/alias` 条目归属：团队 lock 中的条目归远程，其余条目（本地 overlay 插件的 Git commit、本地源摘要）归本机，同步时只替换团队条目。本地 overlay 把团队 lock 已固定的插件改为 `local-link` / `local-file` 源时，`apply` 以退出码 3 拒绝；应在本地 overlay 中对它写 `remove: true`，再以新 alias 加入本地源插件。
- 远程内容只读：写 base、写远程 overlay、改写团队 lock 条目的命令都以退出码 3 拒绝；本机定制写本地 overlay（`--layer overlay`），`source clone --profile` 等写本机条目的命令照常可用。
- 本地已有 `manifest.yaml`、同名 overlay，或本地 lock 已有团队 lock 同名条目时，`remote add` 需要 `--replace`（先快照再覆盖）；本地改过远程文件或团队条目时 `sync` 拒绝，`--discard-local-changes` 可覆盖。
- 每次接受都会先建快照，用 `dshenv rollback <快照 id> --yes` 撤销（id 见接受时输出的 `snapshot ...`；之后又 `apply` 过时，不带 id 的 `rollback --yes` 只会撤销那次 apply）；接受后不会自动 `apply`。接受更新即同意执行其中声明的插件。
- URL 不得内嵌凭据（认证交给 SSH 或 git credential helper）；git 失败时退出码 1，并带出 git 的原始错误。
- `--json` 时 `sync` 输出 `{status, from, to, files: {added, modified, removed}, lockEntries: {added, modified, removed}, plan}`，lock 条目写作 `<profile>/<alias>`，`status` 为 `up-to-date`、`pending` 或 `accepted`。

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
2. **凭据使用约束**：不要把明文密钥写入清单、锁文件、patch 配置或源码 `package.json`。清单与 lock 中带账号密码或 token 的 git URL 会被 schema 拒绝，`capture` 会跳过这类依赖并告警。`doctor` 不回显 `DSH_CLI` 参数，但 `source status --json` 会输出源码包摘要，使用前应检查其中是否含敏感字段。
3. **非受管保护**：实际 Profile 中未写入 `manifest.yaml` 的插件保持 `unmanaged`，不会被自动删除。
4. **锁与管理文件快照**：所有写 `manifest`/overlay/`lock`/`state` 的命令都先获取环境锁（最多等 5 秒）。`apply` 执行前备份当时已经存在的 `manifest/lock/state`；失败时原子恢复这些快照文件，快照中不存在的文件会被删除，并逆序撤销本工具对 Profile `dsh.profile.bundles` 与 `cordis.patch.yml` 的改动；DSH CLI 已完成的包安装、更新或卸载不会撤销，已成功卸载的包也不会恢复其 bundle 与受管块。失败后应重新运行 `status` 与 `plan`。

---

## 后续路线图

见 `docs/roadmap.md`。后续版本计划交付：
- 配置补丁之外的 live manager 写能力
- 细粒度 live manager service 双向通讯

## 许可证

[MIT](LICENSE)
