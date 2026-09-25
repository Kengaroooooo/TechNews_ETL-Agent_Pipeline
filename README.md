# TechNews_ETL-Agent_Pipeline

半导体 / 光通信 / GPU 算力行业情报自动采集与研判管线：GitHub Actions 定时拉取多源 RSS 与市场行情 API，经级联过滤（去重 → 规则初筛 → LLM 研判）产出价格时序、结构化条目队列、每日简报与 P0 告警 Issue。零服务器成本。

## 架构（级联过滤）

```
数据源层（RSS ×5 / Vast.ai REST / 探测源 ×4）
  → 采集与清洗（HTML 剥除、归一 StandardItem）
  → 去重（URL-hash，data/seen.json，30 天滚动窗口）
  → 一级规则初筛（关键词库 + 高信噪比源白名单；未过筛计噪声丢弃）
  → 二级 LLM 研判（OpenAI 兼容 API：实体抽取/TL;DR/P0-P2 分级；缺 key 自动降级纯规则）
  → 输出：
      data/series/gpu_prices.jsonl   GPU 挂牌价格时序
      data/queue/YYYY-MM-DD.jsonl    P0/P1 条目队列（通用下游 JSONL 接口，格式见下）
      data/briefs/YYYY-MM-DD.md      每日简报（人读）
      GitHub Issues                  P0 即时警报（同题去重）
      data/health.json               全端点健康探测（每次运行更新）
```

## 数据产物

### data/queue/YYYY-MM-DD.jsonl —— 条目接口

每行一个 P0/P1 条目：

| 字段 | 说明 |
|---|---|
| id / url / source | 条目 hash / 原文链接 / 源名称 |
| published / fetched_at | 文内发布时间 / 抓取时间（UTC） |
| title / category / priority | 规范化标题 / 分类 / P0-P2 |
| entities / tldr / key_takeaways / agent_comment | LLM 生成的研判摘要（参考信息，非事实口径） |
| keywords_hit | 一级初筛命中词 |
| content | 清洗后原文快照（≤8000 字符） |

### 其他文件

- `data/series/gpu_prices.jsonl`：GPU 挂牌价时序（ts + 分型号 n/min/p25/p50/p75/max/avg/truncated）。口径注意：P2P 挂牌 ≠ 成交价，只适合序列纵向比较
- `data/briefs/`：每日简报（人读）
- `data/health.json`：全端点健康记录
- `data/seen.json`：去重索引

## 源健康（2026-09-25 本地出口基线，Actions 出口状态看 [data/health.json](data/health.json)）

| 源 | 协议 | 本地实测 | 说明 |
|---|---|---|---|
| EE Times / Light Reading / Fierce Network / TrendForce | RSS | ✅ 200 | TrendForce 真实端点 `/news/feed/` |
| SemiAnalysis | RSS | ⚠️ CF 盾 | 主域名 curl 403；备 `semianalysis.substack.com/feed` 自动切换 |
| Vast.ai | REST | ✅ 200 | 只认 `q` 参数（o/order/limit 被 400 拒）；单查询 64 条截断；型号名带空格 |
| IEEE 802.3 | HTML | ✅ 200 | v1 仅探测，采集器排期 v2 |
| SEMI / LightCounting / Yole | HTML | ❌ 反爬 | 403 / JS 壳 / 202 挑战；Playwright 渲染排期 v2 |

> 关于"换出口能否解决反爬"：Actions 换到 Azure 美国段解决**可达性与 IP 层封锁**，但 Cloudflare/DataDome 的 **JS 挑战跟的是客户端不是 IP**，数据中心 IP 风控评分反而更低——所以探测源的真实状态以 health.json 实测为准，不预设。

## API Key 安全（Public 仓库 + Secrets）

1. key 以 **GitHub Actions Secret** 存储：仓库 Settings → Secrets and variables → Actions → New repository secret，名 `LLM_API_KEY`。Secrets 加密存储、只有仓库管理员可见，与仓库 Public/Private 无关；日志自动打码。
2. 三层配合防护：触发器只有 `schedule` + `workflow_dispatch`（**fork 的 PR 默认拿不到 secrets**）；代码不打印/落盘 key；key 缺失自动降级纯规则模式。
3. 模型配置用普通 Variables（非敏感）：`LLM_BASE_URL`、`LLM_MODEL`，缺省 DeepSeek（`https://api.deepseek.com` / `deepseek-chat`）。充值制限额=成本保险丝。
4. 纪律：不要把 key 写进任何文件；泄露随时在 Settings 轮换。

## 快速开始

```bash
npm install
node src/main.mjs        # 本地跑一轮（无 key = 纯规则模式；无 GITHUB_TOKEN = 跳过 Issue）
```

上线：push 到 GitHub 后 Actions 每日自动运行一次（UTC 01:17；手动触发：Actions → pipeline → Run workflow）。定时工作流 60 天无仓库活动会被 GitHub 自动停用——本管线的数据自动提交即保活。

## 路线图

- v2：Playwright 无头浏览器渲染（解锁 SEMI/Yole/LightCounting 的 JS 挑战）；IEEE 802.3 文件列表采集器；ComputePrices（90+ 云厂挂牌，需注册 key）
- 成本闸已内建：`MAX_LLM_ITEMS` 环境变量控制单轮研判条数上限
