# CHANGELOG

> 项目修改历史。条目格式：日期 | 内容与原因。

## 2026-10-07

- **移除 SemiAnalysis 信源**：主域名 CF 盾 + 备用 substack 端点双 403 持续无产出（health.json 多轮记录），放弃。同日完成 stockanalysis.com 侦察（transcripts/company profile 全服务端渲染、裸 curl 可直取，无 CF 挑战），作为候选替代信源，接入方案另行实施。
- **确立「简讯与全文政策」并全源对齐**：条目必供简讯（标题+摘要）；全文按 URL 可复现性分级——可复现→url 即出口不留存（全 RSS 源/StockAnalysis/Fierce Network 文章页按"人工可复现"豁免），不可复现→全文留存（Yole，feed 即载体），付费墙→豁免（LightTrends 报告正文）。可复现性验证一律用 node fetch（本机 curl/schannel 对 Akamai 站会 TLS renegotiation 假挂，EE Times 000 为客户端怪癖非反爬）。
- **新增 StockAnalysis transcripts 采集器**（`src/stockanalysis.mjs`，watch list NVDA/MRVL/AVGO/AMD/MU；TSM 无收录 404 属源端缺数据，已换 MRVL）：索引页当 feed 轮询（每 ticker 每轮 1 请求），去重闸前置于详情页抓取之前（seen 命中/窗口外不抓详情，SA_BACKFILL_DAYS=90 防首跑历史回灌）；条目 content = 索引页自带 Quartr 摘要。稳态实测第二轮全 0 新增。
- **新增 LLM 文档模式纪要**（`src/minutes.mjs` + `llm.mjs` 抽出通用 `chat()` 底层）：transcript 全文按发言人边界分块（≤6000 字符，Q&A 结构不切断）→ 逐块提取 → 合并五节纪要落 `data/minutes/*.md`，队列条目带 minutes_file 指针；独立子闸（每轮 ≤2 篇、5min）与新闻研判共享总预算（新闻优先），预算不足降级为要点直拼并标注；原文不落盘（url 可复现）。LLM key 环境下端到端待 Actions 首跑验证。
- **队列 content 摘要化**：LLM schema 新增 summary（≈150 字信息性摘要，研判调用顺手产出零额外请求），content 降级链 = LLM summary → 源方 description（makeItem 新增 digest 字段）→ 原文前 400 字；慷慨源（TrendForce 全文 RSS）原文不再入队，`slice(0,8000)` 截断移除。
- **本地 feed 补正文**（`tools/local-feeds.mjs`）：LightCounting 详情页 HTTP 直取剥 `<p>` 正文（列表/详情均 SSR）；Yole 同浏览器会话渲染详情页取 `.yole-content` 全文（留存义务方不裁剪；`/industry-news/` 路径 DataDome 更严，以 waitForSelector 为成功判据而非 goto 状态码）。成本闸：上轮已有正文的条目不重抓，失败条目自动下轮重试；存量一次性回灌（LOCAL_FEEDS_BACKFILL=1）已执行——LC 15/15、Yole 15/15（含 76K 字符访谈全文）；prev 正文继承防 feed 重写时静默丢失。调试开关 LOCAL_FEEDS_DRY_RUN=1 跳过提交。

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
- **Yole DataDome 突破，本地 feed 扩至 2 源**：puppeteer-core 驱动系统 Chrome（无浏览器下载，`tools/` 独立依赖不污染根 npm ci）+ stealth 插件 + 固定 userDataDir 攒信任分，一次通过 202 挑战（住宅 IP + 稳定浏览器身份是关键，同代码在 Actions 的 Azure DC 出口必然失败——指纹检测拦客户端不拦渲染能力）。渲染页结构 `a.card-post` + `time.card-post__date` 提取 15 条（Ayar Labs CPO 融资等核心议题），管线端到端验证入队。依赖动态加载：tools/ 未装依赖时仅 Yole 源降级失败，LightCounting 不受影响。
