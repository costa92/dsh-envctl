# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。发布流程见 [docs/发布流程.md](docs/发布流程.md)。

## 未发布

### 新增

- `dshenv web start|stop|status`：在后台启动 dsh web（Linux/macOS 上为独立进程组，Windows 上不附着在启动它的控制台上，dshenv 退出或关闭终端后继续运行）并打印浏览器地址，停止时连同它启动的子进程一起停止；地址、pid 与主进程启动时间记在权限为 `0600` 的 `envctl/run/<profile>.json`，`runtime` 在没有设置 `DSHENV_DSH_URL` 时自动使用它。
  - 按 pid 与启动时间识别自己启动的 dsh web，不受 `COLUMNS` 截断 `ps` 输出、系统没有 `ps` 或 pid 被复用的影响；无法确认时 `status` 显示 `unknown`，`start`/`stop` 报错并保留记录，不停止任何进程。
  - dsh web 退出而它启动的子进程还在时，`status` 显示 `not running (leftover processes)`，`start` 先停掉这些子进程再启动，`stop` 也会停掉它们。
  - SIGKILL 后仍未停下时 `stop` 以非零退出码报错并保留记录；同一 Profile 的 `start`/`stop` 依次执行；启动中按 Ctrl+C 会停止正在启动的 dsh web。
  - 启动失败时引用的 DSH 输出里 `token=` 之后的内容替换为 `<redacted>`；Windows 上可以运行 npm 安装的 `dsh.cmd`。
- `dshenv runtime --start`：没有在运行的 `dsh web` 时自己启动一个（随机端口、不开浏览器、不打印 token），核对完即停止它和它启动的子进程（核对中按 Ctrl+C 也一样）；不带 web 应用的 Profile 报出 DSH 自己的错误。

### 变更

- Profile 名在清单、overlay、lock 与 `-p` 中统一校验：只能含字母、数字、`.`、`_`、`-`，不能以 `-` 开头，也不能是 `.` 或 `..`，否则报 `Invalid profile name`（退出码 3）。
- 团队配置（remote 的 manifest 与 overlay）不能再设置 `environment.harness.sourceDir` / `environment.sourceRoot`，团队 manifest、overlay 与 lock 中的 Git 插件不能使用 `file://`、绝对或相对路径等本机地址，否则整个 commit 被拒绝；这两项请写进本机 overlay。
- 团队配置（remote 的 manifest 与 overlay）的插件 patch 与 profile patch 不能含 JavaScript 表达式（`__jsExpr`），它会被写成 DSH 执行的 `!!js` 值；这类 patch 请写进本机 overlay。
- 清单中 Git 来源的 URL 与 ref 不能以 `-` 开头，`commit` 必须是 7-64 位十六进制 commit id；`source clone` 把 URL 放在 `--` 之后传给 git，`source pull --ref` 拒绝以 `-` 开头的 ref。
- `runtime --allow-remote` 连非本机地址时只接受 https，拒绝明文 http。
- `self-update` 在用户主目录下运行 npm/pnpm，不再读取当前目录的 `.npmrc`。
- `apply` 失败时只恢复它自己写的 `lock.json` 与 `state.json`，不再用快照覆盖 `manifest.yaml`、overlay 与 `envctl/skills`，apply 期间的手工修改得以保留；快照恢复本身失败时报出原因并提示 `dshenv rollback <id> --yes`，不再静默忽略。
- `apply` 遵守清单中的 `environment.harness.allowUntestedVersion`，与 `doctor` 一致。
- 从源码目录运行 DSH（`--harness-source` 或 `environment.harness.sourceDir`）改为 `pnpm --silent --dir <目录> dsh`。

### 修复

- `apply` 每装成功一个插件就记入所有权，中途失败或被中断时已装的插件不再变成未受管；`rollback` 保留由 `apply` 安装、仍在 Profile 中的插件的所有权。
- 同一 Profile 内先执行卸载再执行安装，同一别名换成另一个包时，卸载旧包不再清掉新包刚写入的 patch 与挂载。
- Profile 中只出现在 bundle 列表、没有安装的包，按清单声明的 npm、Git 或本地来源安装，不再被当作已同步。
- 不存在且本次计划也不会创建的 Profile，其中的 in-box 插件操作在 `plan` 阶段标为 blocked，不再到 `apply` 建完快照后才报错。
- 替换 loose skill 失败时删除残留的临时副本，新副本改名失败时把旧技能放回原处。
- `adopt` 捕获到的别名已被另一个包占用时改用 `<别名>-1` 等新别名，不再覆盖已有条目和它的 patches。
- `gc --older-than` 只接受非负数，`''`、`-1`、`1e3` 等以退出码 3 拒绝，不再删除全部 trash。
- `purge` 先检查 patch 文件与 clone 路径都安全再改动，移动 clone 失败时恢复已清除的 patch 块。
- `source clone --profile` 写 lock 失败时恢复清单（或 overlay）并删除克隆；`source pull --profile` 总是按清单中的 URL 写入完整的 lock 条目，不再显示 `Updated` 却没有锁定新 commit。
- 从源码目录运行 DSH 时，`--version`（10 秒）与 `--dump-config`（15 秒）超时会结束整棵进程树并返回，不再被 pnpm 启动的子进程拖住；pnpm 的脚本横幅不再混进输出，`tools` 能解析、HMR 探测不再总是 unknown。
- 结束进程树时等全部退出后才返回，强制结束只发给仍存活的进程，不会误杀之后复用了 pid 的进程。
- `rollback` 先检查快照中的 `manifest.yaml`、`lock.json`、`state.json` 能否解析，不能时以退出码 3 拒绝且不改动任何文件，不再恢复出一份让之后所有命令都失败的文件。
- `adopt` 已写入清单、接管 patch 条目时失败，错误信息说明插件已接管、修正后运行 `dshenv pull` 即可，不再看起来像 adopt 没有生效。
- `remote sync` 预览复制技能目录时跳过软链接，不再顺着链接写入或删除外部文件。

## 0.3.0 - 2026-09-28

### 新增

- `dshenv install in-box:<包名>`：把随 DSH 发布的 bundle（如 `@deepseek-ai/dsh-acp-app`）声明进清单，不再只能靠 `capture` 生成。
- `dshenv tools list|enable|disable|config`：按架构图分类列出 Profile 的内置工具与开关状态（读自 `dsh --dump-config`），开关或配置结果写进清单的 profile patches；agent 预设里的工具通过整份复制预设实现，`plan` 列出已固定的预设。
- DSH 配置双向同步：清单新增 `profiles.<profile>.patches`，原样保存 Profile 自己的 cordis patch 条目（模型、语言、权限、技能目录等），`apply` 把它们写进 `cordis.patch.yml` 的一个受管块。
- `dshenv pull`：把 DSH 写在受管块之外的条目和在受管块里的改动收进清单，含本机绝对路径的条目写进本机 overlay（没有时新建并选中 `local`），基础清单归团队 remote 所有时全部写进 overlay。两边都改过时需 `--prefer dsh|manifest`；先建快照，可用 `rollback` 撤销。
- `plan` 列出受管块之外的 patch 条目，并能分辨受管块是在 DSH 里改过还是清单改过；`adopt` 接管 Profile 时一并收进这些条目，`capture` 给出提示。
- loose skill 同步：`$DSH_HOME/skills` 下的技能目录由 `pull` 收进 `envctl/skills/<名字>`，`apply` 复制回 DSH，被覆盖或删除的副本移进 `envctl/trash`；`plan` 列出技能变更与未受管技能；快照与 `rollback` 覆盖 `envctl/skills`；团队配置仓库的 `envctl/skills` 随 `sync` 同步，`sync`/`remote add` 的预览计划包含接受后的技能变更；团队技能在 DSH 里改过时 `plan` 提示去团队仓库改或 `apply` 还原。

### 修复

- 不是 DSH bundle 的插件包（没有 `dsh.bundle`）以前被放进 bundle 列表，DSH 跳过不加载，`plan` 却显示已同步；现在改为用受管的 `insert` 行挂载，同一次 `apply` 内装好并挂载，`enable`/`disable`/`remove` 与 `runtime` 都按挂载判断。

## 0.2.1 - 2026-09-28

### 新增

- `dshenv self-update`：用 `npm view --prefer-online` 查询 npm 上的版本，再用安装 dshenv 的包管理器（全局 npm 或 pnpm）升级自身，安装输出直接显示在终端。`--check` 只查询，有可安装版本时退出码 2；`--to <版本>` 指定精确版本，可用于降级。不带 `--to` 时不会降级预发布版或本地构建。本地链接、源码检出和从 Git 地址安装的 dshenv 不会被替换。失败时只显示错误码，不带出 registry 地址或 token。
- README 与使用教程补充升级 dshenv 的说明。

## 0.2.0 - 2026-09-28

### 修复

- 快照先写入临时目录，完整后再改名发布；复制中途失败不再留下不完整的快照，避免 `rollback` 选中它并删除现有的 lock/state 文件。
- 快照记录当时不存在的 overlay；`sync` 在写入新 overlay 后、更新 `remote.json` 前被中断时，`rollback` 会删除这些新文件。rollback 前的备份会同时保存这些文件，它们若已成为本地文件，可以再次 rollback 找回。
- `source clone --profile` 在拿到环境锁之后才判断哪些目录归自己；两个 clone 并发时，失败的一方不再删掉整个 `sources/` 目录。命令失败时只删除自己的 checkout，父目录只在为空时删除。
- `source clone --profile` 先解析 `lock.json` 再写清单；lock 损坏时清单保持不变。
- `adopt` 在写 `state.json` 失败时把已写的清单和 lock 恢复原样。
- 回滚 `cordis.patch.yml` 所用的原内容在写入时的同一次 profile 锁内读取；dshenv 等锁期间 DSH 做的修改不再被回滚覆盖。
- `cordis.patch.yml` 为非空 flow 数组（如 `[{id: x}]`）时，先改写成块式序列再追加受管块，不再生成非法 YAML；`~`、`null` 等空文档按空数组处理；被旧版本写坏的文件（flow 数组后接受管块）会被 `plan` 发现并规划一次 configure，`apply` 时修复，保留所有受管块；写入结果不是单个顶层数组时拒绝写入。
- `apply` 新安装的插件会记录所有权，之后从清单删除该插件时会被卸载，不再变成未受管。
- 更新一个保持禁用的插件时，更新后会再次禁用（DSH `plugin add` 会选中 bundle）。
- 本地来源路径改变时规划 update，即使新旧路径内容 digest 相同。
- 缺少校验证据时不再报告已收敛：已装 Git 规格未指向 commit（如 `#main`）、npm 包没有版本号时按锁定版本重装；已安装的本地来源无法读取时列为 unverified：`status` 显示 degraded，`plan` 单独列出，但不阻止其他操作。
- `apply` 调用的 DSH `plugin add` / `plugin remove` 10 分钟超时，超时后终止 DSH 及其启动的 pnpm 等整棵进程树并回滚，不再无限期占用环境锁。
- 不支持硬链接的文件系统上，只创建（create-only）写入改用排他复制，不会覆盖并发创建的文件；复制中途失败时删除写了一半的目标文件。
- 在 Windows 上按 `;` 切分 PATH 并按 PATHEXT 查找 `dsh.cmd` 等命令。

### 变更

- 清单中 npm 来源的 `registry` 字段不再被接受：`apply` 从未使用它，声明私有 registry 实际会从默认 registry 安装同名包。
- `lock.json` 中的 git `commit` 必须是 7-64 位十六进制 commit id（支持 SHA-256 仓库）；分支名、tag 会被拒绝。

## 0.1.3 - 2026-09-28

### 变更

- GitHub 仓库改名为 [`costa92/dshenv`](https://github.com/costa92/dshenv)，与 npm 包名一致；npm 包的 `repository` 与 `homepage` 指向新地址。旧地址 `costa92/dsh-envctl` 由 GitHub 自动跳转。

## 0.1.2 - 2026-09-28

### 修复

- 以 `git+` 地址安装 Git 来源：`file://` 与自建服务器的 `https://` 地址此前会被 pnpm 当作本地目录或压缩包而安装失败。
- DSH 插件命令失败时显示 DSH 自己的 `dsh:` 诊断行（如版本不兼容的原因与放行命令），不再只有退出码；pnpm 原始输出不显示。
- `adopt` 替换清单中已有的插件时保留已声明的 `patches`，不再静默丢失配置。
- `status <插件>` 可以按别名过滤，与其他插件命令一致。
- `source pull --ref <分支名>` 快进到上游分支；此前会快进到本地分支自身，报告成功但没有更新。只有与上游分支完全同名时才改用上游，`HEAD`、`HEAD~1` 等修订仍按当前检出解析。

## 0.1.1 - 2026-09-28

### 变更

- 发布到 npm registry，包名 `@costa92/dshenv`（无作用域的 `dshenv` 被 npm 以与 dotenv、osenv 过于相似为由拒绝）：`npm install -g @costa92/dshenv`。命令名仍为 `dshenv`。
- 从 Git 地址用 pnpm 安装时，放行参数改为 `--allow-build=@costa92/dshenv`；卸载改为 `pnpm remove --global @costa92/dshenv`。
- Release 工作流把同一份 `.tgz` 发布到 npm（带 provenance）并附在 GitHub Release 上。

## 0.1.0 - 2026-09-27

首个公开版本。支持的 DSH 版本族：`0.1.7`（含预发布版）。

### 新增

- 环境探测与盘点：`doctor` 报告 DSH 版本与能力矩阵；`capture` 把现有 Profile 盘点为候选清单，`adopt` 建立所有权。
- 声明式管理：`manifest.yaml` + `lock.json`，`plan` / `status` 计算漂移；npm 只接受精确版本，Git 来源锁定 commit，本地来源记录 digest。
- `apply`：通过 DSH CLI 执行 install / update / remove，通过 Profile bundles 执行 enable / disable，通过 `cordis.patch.yml` 受管块执行 configure；带环境锁、快照、操作日志与失败回滚，并按 DSH 热加载状态报告哪些改动需要重启。
- 便捷命令：`install`、`update --to`、`enable`、`disable`、`remove`、`list`、`config get|set|validate`、`source status|clone|pull`、`restarted`、`rollback`、`gc`、`purge`。
- Base + Overlay 清单合并与本机 overlay 选择。
- 团队共享基线：`remote add|show|remove` 订阅 Git 配置仓库，`sync` 预览并接受固定 commit 的更新。
- `runtime`：连接运行中的 `dsh web`，核对清单插件是否已加载，并说明卡在 pending 的插件。
- `new`：从模板生成 skill / agent / tool / mcp 组件包。
- `--json` 结构化输出，错误同样以 JSON 写入 stderr。
- 示例：GitHub Actions 漂移检查、容器镜像；`make smoke-dsh` 验证新 DSH 版本。
