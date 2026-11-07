---
name: understand-anything-auto-update
description: 让知识图谱跟着每次提交自动增量更新，或在会话开始时检查并刷新过期图谱。对应 Understand Anything 的 post-commit hook 与 SessionStart 过期检查。
whenToUse: 用户想开启/关闭提交后自动更新，或会话里发现图谱落后于代码时。
---

# /understand-anything-auto-update

## 两种触发方式

**A. 提交后自动跑（git post-commit hook）**

- `ua_hook({ "action": "install" })`：在仓库里安装受管 hook，并把 `.ua/config.json` 的 `autoUpdate` 设为 `true`。
- `ua_hook({ "action": "status" })`：查看是否已安装、`autoUpdate` 状态、是否有原 hook 被备份。
- `ua_hook({ "action": "uninstall" })`：移除受管 hook、恢复原有 hook、关闭 `autoUpdate`。
- `ua_hook({ "action": "enable" | "disable" })`：只改开关，不动 hook 文件；也可用 `ua_config({ "autoUpdate": true })`。

hook 的行为：每次 commit 后调用插件自带的 `bin/ua-post-commit.mjs`，做一次**纯 Node、不联网、不调模型**的确定性增量重扫，只重解析内容变化的文件，并把新的 git commit 写进图谱与 `meta.json`。**任何失败都被吞掉、绝不阻断提交。**

安装时若仓库已有 `post-commit`，会原样备份为 `post-commit.ua-original` 并在新 hook 里先链式调用，不会覆盖别人的逻辑。用 `git rev-parse --git-path hooks` 定位，因此 git worktree 也能正确安装。

> hook 里记录了插件源码的绝对路径；如果移动了插件目录，重新执行一次 `ua_hook({ "action": "install" })`。

**B. 会话内检查（等价于上游 SessionStart 检查）**

每次开始在这个项目里按图问答前：

1. `ua_status` 看 `stale.changedCount`；非 0 就先提醒用户「图谱之后有代码改动，结论可能不含这些变化」。
2. `ua_auto_update({ "apply": false })` 先看会更新什么；确认后 `ua_auto_update()`（默认 `apply: true`）执行增量重扫。
3. 图谱已是最新时它不会做任何写操作。

## 注意

- `autoUpdate` 默认关闭，必须显式开启；卸载 / disable 会一并关掉。
- 增量只更新结构层，模型写过的 `summary` / `tags` / `layer` 会保留。
- 自动更新只覆盖代码图谱；domain / knowledge / design 图谱需要各自重新生成。
