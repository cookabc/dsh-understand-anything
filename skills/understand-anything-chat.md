---
name: understand-anything-chat
description: 用知识图谱回答关于代码库的问题（某功能在哪、支付流程怎么走、谁依赖这个模块）。
whenToUse: 用户就某个代码库提问，且项目里已有 .ua/knowledge-graph.json 时。
---

# /understand-anything-chat

**不要一上来读整个图谱文件。**先检索，再只展开相关的 1 跳子图。

## 步骤

1. `ua_status` 确认图谱存在；顺便看新鲜度。如果 `stale.changedFiles` 非空，回答前提醒用户「图谱之后有代码改动，以下结论可能不含这些变化，建议 `ua_scan` 刷新」。
2. `ua_query`，把用户的问题拆成关键词传 `query`（如 `payment auth login`）。它返回打分后的匹配节点、相关的边、邻居节点和所在分层。
3. 对最关键的节点调用 `ua_explain`（传 `nodeId`），拿到摘要、上下游关系和定义附近的源码节选、行号和 `source.citation`。需要更多上下文时再用 `read` / `grep` 直接看源文件。
4. 沿 `imports` 等已观测关系说明依赖；`calls` 只是同名匹配推断，必须单独标明。回答时引用 `source.citation`，并检查 `source.stale` 和 `annotation.stale`。
5. 只用相关子图作答；匹配为空就直说，并从已有节点里给出相近的关键词建议。

## 回答要求

- 区分三类内容：**图谱里记录的结构事实**、**模型补写的 summary**、**你此刻的推断**。
- 引用源码使用工具返回的路径与行号，别把整份 JSON 倒进上下文。
- 用户问「改动会影响什么」时，改用 `understand-anything-diff` 流程。
