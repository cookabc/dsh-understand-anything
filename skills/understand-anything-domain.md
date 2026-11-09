---
name: understand-anything-domain
description: 从代码知识图谱提取业务域、业务流程与流程步骤，生成横向流程视图。
whenToUse: 用户想看业务领域划分、梳理某个业务流程、做领域建模或问「这个系统有哪些业务环节」时。
---

# /understand-anything-domain

把结构图谱翻译成业务语言：domains（业务域）→ flows（流程）→ steps（步骤）。

## 工作流

1. `ua_status` 确认有代码图谱；没有就先按 `understand-anything` 的流程 `ua_scan`。
2. `ua_domain({ "prepare": true })` 拿回一份**有界的**上下文：分层文件清单、入口点、`calls`/`imports` 边、以及 `analysisSchema`。不要去读整份图谱 JSON。
3. 结合上下文和必要的源码（用 `read` / `grep`，只挑相关文件），按 `analysisSchema` 写出 `analysis`：
   - `domains`：业务域名称 + 一句说明 + 相关的图谱节点 id；
   - `flows`：流程名 + 有序 `steps`（每步尽量给 `nodeId` 指回真实函数/类）；
   - `relations`：可选的补充关系。
   **只写你能从文件职责、命名和调用链里支持的内容，不要编造业务规则。**
4. `ua_domain({ "analysis": {...} })` 写回 `.ua/domain-graph.json`。工具会先生成确定性候选（按源码目录分域、沿 `calls` 链成流），再把你的分析合并进去；悬空引用会被丢弃并在 `dropped` 里报告。
5. `ua_dashboard({ "graph": "domain" })` 生成横向流程视图，用 `present` 交付路径。

## 说明

- 图谱过期时（`ua_status` 的 `stale.changedCount > 0`）先提醒用户刷新，再据此分析。
- `ua_domain({ "full": true })` 会在没有图谱时做一次轻量扫描派生，但**不会**覆盖主代码图谱。
- 流程顺序来自静态调用边，不等于运行时执行顺序；动态分发、消息队列、外部服务不在图里。
- `domain-graph.json` 是独立文件，不会覆盖 `knowledge-graph.json`。
