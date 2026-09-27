# 提交给 DSH 的需求

上游 `deepseek-ai/deepseek-harness` 关闭了空白 issue，需按 Feature 模板（`## Motivation`、`## Behavior`）提交。两份正文已按模板整理，可分别提交：

| 文件 | 标题 |
| --- | --- |
| [`issue-1-live-plugin-update.md`](issue-1-live-plugin-update.md) | 插件管理器：升级已装插件后不重启 DSH 即加载新版本 |
| [`issue-2-missing-services.md`](issue-2-missing-services.md) | 插件清单：报告 pending 插件正在等待的 service |

```bash
gh issue create -R deepseek-ai/deepseek-harness \
  --title "插件管理器：升级已装插件后不重启 DSH 即加载新版本" \
  --body-file docs/dsh-requests/issue-1-live-plugin-update.md
gh issue create -R deepseek-ai/deepseek-harness \
  --title "插件清单：报告 pending 插件正在等待的 service" \
  --body-file docs/dsh-requests/issue-2-missing-services.md
```

`gh` 不会套用模板里的 `type: Feature`，提交后在网页上把 issue 类型设为 Feature；或者在网页上选 Feature 模板，把正文粘进去。

源码引用于 2026-09-27 在上游 `46a7f68b09` 上核对，两项需求均未实现。`dsh-plugin-manager-requests*.md` 是合在一起的原始草稿（中英文），供需要英文版时参考。
