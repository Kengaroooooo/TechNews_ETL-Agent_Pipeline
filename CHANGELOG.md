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
- **全面检视修复**（产出腐化 + 静默丢数据 + 文档对齐）：
  - 采集层：`stripTags` 实体解码补齐数字/十六进制实体与 `&apos;`，`&amp;` 改最后解码（修复双重还原）；新增 `asText` 拍平 RSS 对象字段（修复 Fierce Network title 内嵌 `<a>` 元素导致标题 `[object Object]`）；Atom `<link href>` 改 `ignoreAttributes:false` + 属性提取（原实现 href 被丢、链接变垃圾）；hash 回落键加 content 前缀（同源无链接无标题条目碰撞）；分位数索引 `floor` 改 `ceil(n·f)−1`（修复 n=64 时 p50 取第 33 个值的偏差）；采集失败改为逐端点打印诊断日志。
  - 可靠性：去重索引提交后置到全部产出落盘之后（中途失败条目下轮可重试，不再永久丢）；LLM 研判加总时间预算闸（15min < workflow 25min 超时，防超时重试拖垮整轮，超预算条目降级直通）；`MAX_LLM_ITEMS` 溢出条目不再静默丢弃，降级直通 queue 并标 `llm_skipped: true`；`seen.json` 解析失败改为告警而非静默清零；价格时序剔除失败读数。
  - 冗余/探测：RSS 主端点健康由采集诊断随采记录，取消二次全量拉取；删除关键词 `gb200`/`silicon photonics`（分别被 `b200`/`photonic` 覆盖）、`AUTO_PASS_SOURCES` 中的死配置 `Vast.ai`；workflow 移除与代码默认值重复的 `MAX_LLM_ITEMS` 注入。
  - 文档：README 队列说明对齐实际（全优先级 + `llm_skipped` 字段）、源健康表按 health.json 实测修正（LightCounting 200/JS 壳）、config 注释同步。
- **本地 feed 生产者上线（反爬源架构）**：确立"本机产原料、Actions 加工、仓库为唯一真相源"的数据流——新增 `tools/local-feeds.mjs`（Windows 计划任务每日触发，提取 → `data/feeds/*.xml` 标准 RSS → 只提交 data/feeds 推送），管线新增 `fetchLocalFeeds()` 从 checkout 直接消费。侦察发现 LightCounting `/newsletters` 实为服务端渲染（非 JS 壳，HTTP 直取即可，43 条无分页），而 `/newsroom` 是 SPA 伪 200 的 404 页（此前误导了健康探测，已修正探测 URL）；首个 feed 实跑提取 15 条，管线端到端验证 4 条过筛入队（cpo/optical 命中）。Yole 全路径 DataDome 202（连住宅 IP 也拦），留 PROBE_ONLY 待 puppeteer+stealth 实验。新增接口纪律：消费方以仓库 main 为准，本机其余 data/ 产物只是开发草稿不提交。
