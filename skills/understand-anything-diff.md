---
name: understand-anything-diff
description: 分析当前 git 改动会影响知识图谱里的哪些模块，并向上游追踪依赖者。
whenToUse: 提交前想看改动波及范围、做影响面评估、或问「这次改动会影响到谁」时。
---

# /understand-anything-diff

## 步骤

1. `ua_status` 看图谱记录的 `gitCommitHash` 与当前 HEAD、工作区差异。
2. `ua_diff`（可传 `root`，或 `base` 指定对比的 commit）拿到：
   - `direct`：变更文件直接对应的节点；
   - `upstream`：沿已观测关系反向追踪到的上游依赖者（最多 3 跳）；
   - `inferredUpstream`：只有推断关系支持的额外候选，不应混入确定结论；`via` 给出追踪依据；
   - `unmappedFiles` / `truncated`：未入图文件和结果截断，不能把缺失当作没有影响；
   - `layersTouched`：波及的架构分层；
   - `affectedCount`：影响面总量。
3. 按「直接改动 → 上游依赖者 → 需要重点回归的层」组织结论，点名文件路径。
4. 明确说明这是**结构影响面**，不是运行时行为保证；动态调用、配置开关、外部服务不在图里。
5. 如果图谱本身已经过期（`ua_status` 报变更），先建议 `ua_scan` 再重跑 `ua_diff`。

不要修改任何源码，也不要自作主张提交或回滚。
