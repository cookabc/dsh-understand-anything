---
name: understand-anything-onboard
description: 基于知识图谱的依赖顺序导览，为新成员生成上手路线。对应 Understand Anything 的 /understand-onboard 与 dashboard 能力。
whenToUse: 用户要新人指南、onboarding、想按正确顺序读代码，或想打开可视化图谱时。
---

# /understand-anything-onboard

## 步骤

1. `ua_status` 确认图谱存在；没有就先按 `understand-anything` 的流程 `ua_scan`。
2. `ua_tour` 取回按依赖顺序排好的阅读步骤（依赖少的基础模块在前）。
3. 把每一步整理成一段说明：这一步读哪些文件、为什么先读它们、读完应该能回答什么问题。必要时用 `ua_explain` 补一两个关键节点的细节，但不要把所有节点都展开。
4. 用户想看图时，调用 `ua_dashboard` 生成离线 HTML，再用 `present` 交付路径；提醒用户这是本地文件、不需要服务器、不联网。
5. 结尾给出「读完导览后建议动手验证的一件小事」，例如跑某个测试或跟踪一条调用链。

## 注意

- 导览顺序来自静态导入关系，不等于运行时执行顺序。
- 图谱的 summary 为空时，如实说明「这一层还没有语义说明」，不要替它编一段职责描述。
