# CHANGELOG

> 项目修改历史。条目格式：日期 | 内容与原因。

## 2026-09-25

- **v0.1 建成并本地实测通过**：级联管线（RSS ×5 + Vast.ai 分型号行情 + 全端点健康探测 → URL-hash 去重 → 关键词初筛 → LLM 研判插槽 → 价格序列/条目队列/每日简报/P0 Issue 警报）。本地首跑：4 源 RSS 40 条、Vast.ai 8/8 型号、初筛 15 过 25 弃。端点按实测修正三处：TrendForce 真实端点为 `/news/feed/`（原始方案的 rss.html 已 404）、Vast.ai 只认 `q` 参数（o/order/limit 被 400 拒）且单查询 64 条截断、SemiAnalysis 主域名 CF 盾加 `semianalysis.substack.com/feed` 备用端点。
- **部署 GitHub Actions**（初为每 4 小时），同日调整为**每日一次**（UTC 01:17，覆盖隔夜美股时段动态）。
- **换出口实测结论**（GitHub Actions/Azure 出口）：SemiAnalysis/SEMI 仍 403、Yole 仍 202、LightCounting 200 但 JS 壳——反爬拦客户端不拦 IP，换出口无效，解锁须无头浏览器渲染（v2 路线）。结论与原理写入 README。
- **LLM 层 provider 兼容垫片**：`response_format` 被 400 拒时自动去参重试 + 容忍 markdown 围栏包裹（适配 GLM 等 OpenAI 兼容平台的差异）。
- **runner 固定 ubuntu-24.04、actions 升 v5**（消除 Node 20 弃用警告与 ubuntu-latest 迁移变数）；SemiAnalysis 备用端点纳入健康探测。
- **对外信息面整理**：文档与源码注释统一为项目功能描述；仓库历史整理为单一初始提交。跨项目接口文档由消费侧自行维护，不在本仓库存放。
- **去重索引重置**：首批队列条目为无 LLM key 环境产物（全 P2、摘要为空），重置 seen.json 使存量条目在下次运行重新过筛，端到端验证 LLM 研判层。
