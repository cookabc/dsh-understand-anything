---
name: understand-anything-figma
description: 通过 Figma REST API 分析设计文件，生成页面/屏幕/组件/实例/设计令牌的设计知识图谱。对应 Understand Anything 的 /understand-figma。
whenToUse: 用户给了 Figma 文件链接或 file key，想把设计稿结构、组件与令牌可视化时。
---

# /understand-anything-figma

## 前提（先告知用户一次）

1. 需要 `FIGMA_TOKEN` 环境变量（在 figma.com/settings 创建个人访问令牌后 `export FIGMA_TOKEN=…`）。**不要**把令牌写进对话、参数、图谱或任何文件；工具只从环境变量读取，只放在 `X-Figma-Token` 请求头里。
2. 这是本插件**唯一**会联网的能力，请求只发往 `api.figma.com`。其余工具全部离线。

若 `FIGMA_TOKEN` 缺失，工具返回 `FIGMA_TOKEN_MISSING`，此时停下来把上述说明转告用户，不要尝试其它途径获取令牌。

## 工作流

1. `ua_figma({ "urlOrKey": "<Figma URL 或 file key>" })`。工具会拉取文件树并生成 `.ua/design-graph.json`（`kind: "design"`）：
   - page（画布）→ screen（顶层 FRAME / SECTION）→ component / componentSet / instance；
   - `doc.styles` → token 节点；
   - 边：`contains`（父子）、`instance_of`（实例→组件）、`uses_token`（节点→样式令牌）；
   - layers 按 page 分组，tour 按 page 顺序。
2. 若返回的 `upToDate: true`，说明该文件版本没变，不必重跑；用户明确要求重算时传 `force: true`。
3. 可选语义补写：读 `stats` 与 `ua_query` 结果，用 `analysis: { nodes:[{nodeId, summary, tags}], relations:[...] }` 给关键 screen/component 写用途说明，再调一次 `ua_figma`。
4. `ua_dashboard({ "graph": "design" })` 生成设计图谱页，用 `present` 交付。

## 边界

- 图谱单独写在 `design-graph.json`，**不会覆盖**代码图谱 `knowledge-graph.json`。
- 只取结构元数据，不下载图片、不解析二进制、不把令牌或完整响应落盘。
- API 返回可能很大：解析有 5000 节点与 12 层深度上限，超出会停止遍历并在 `stats.truncated` 体现，不要声称覆盖完整设计稿。
- 组件语义（这个 screen 是干什么的）需要模型补写，工具本身只给结构。
