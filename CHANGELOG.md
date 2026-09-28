# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。发布流程见 [docs/发布流程.md](docs/发布流程.md)。

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
