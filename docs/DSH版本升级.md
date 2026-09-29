# DSH 新版本兼容验证

dshenv 只放行已验证的 DSH 版本族（当前为 `0.1.7`，含其预发布版）。DSH 发布新版本后，按以下步骤验证并放宽门禁。

## 1. 冒烟

```bash
make smoke-dsh DSH_VERSION=<新版本>
```

脚本 `scripts/smoke-dsh.sh` 把 `@deepseek-ai/dsh@<新版本>` 装到临时目录，并在隔离的 `DSH_HOME` 中依次执行：

1. `doctor --json`：门禁放行则为 `PASS`；门禁拒绝（退出码 4）时打印 `WARN`，后续步骤带 `--allow-untested-dsh` 继续。
2. `init` → `install`（默认 `@nanmicoder/dsh-agent-teams@0.1.21`，可用 `SMOKE_PLUGIN` 覆盖）→ `apply --yes` → `plan` 无漂移 → `dsh --dump-config` 能看到插件。
3. `disable` 和 `remove` 各自 `apply --yes`，之后 `plan` 均无漂移。

全部 `PASS` 时退出码为 0；失败的步骤会附带输出。第二个参数可以指定工作目录，便于事后查看 `doctor.json` 与日志。

`.github/workflows/compat.yml` 每天对已验证版本、`latest` 与 `next` 自动跑这一冒烟，所以 DSH 发布新版本后，通常在这里先看到结果（`latest`/`next` 只报告，失败不影响工作流结论）；也可以在 Actions 里手动运行并填写版本。冒烟通过后，再用 `make e2e-dsh DSH_VERSION=<新版本>` 跑完整主链。

## 2. 放宽门禁

冒烟全部通过后，逐项修改并补测试：

| 位置 | 内容 |
| --- | --- |
| `src/dsh/version.ts` | `knownDshFamily` 与 `isCompatibleDshVersion` 中的已验证版本族 |
| `tests/dsh/version.spec.ts`、`tests/cli/doctor.spec.ts` | 新版本放行；相近的非法版本（如 `0.1.80`）仍被拒绝 |
| `src/scaffold/templates.ts` | `PEER_RANGE`：跨 minor 版本时需要调整上限 |
| `docs/examples/container/Dockerfile` 及其 README | `DSH_VERSION` 默认值 |
| `docs/roadmap.md` | 记录验证版本、日期与冒烟结果 |
| `README.md` | 顶部 DSH 徽标中的已验证版本族 |
| `.github/workflows/e2e.yml`、`.github/workflows/compat.yml`、`tests/github-actions.spec.ts` | 端到端测试与兼容性矩阵中必须通过的已验证版本 |

`packageOperations` 能力依赖对 Harness 源码中官方 operations export 的只读探测（`src/dsh/surface-probe.ts`）。新版本若调整了该导出，还需要用 `--harness-source` 指向新源码并运行 `dshenv doctor`，确认该项仍为 `available`。

## 已知结果

| DSH 版本 | 门禁 | 冒烟 | 日期 |
| --- | --- | --- | --- |
| `0.1.7-rc.2` | 放行 | 13 步全部通过 | 2026-09-27 |
| `0.1.6-alpha.2` | 拒绝 | 带 `--allow-untested-dsh` 全部通过；`dshenv new` 模板仍需要 0.1.7+ | 2026-09-27 |
| `0.2.0-rc.1`（`next`） | 拒绝 | 带 `--allow-untested-dsh`：doctor、init、remove 通过；install 与 disable 失败，DSH 以 peerDependencies 不兼容拒绝安装 `@nanmicoder/dsh-agent-teams@0.1.21`（插件只声明到 0.1.7-rc.2），属插件侧，需插件发布兼容版本或 `dsh plugin allow-version` 豁免 | 2026-09-29 |
