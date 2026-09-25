# TechNews_ETL-Agent_Pipeline

半导体 / 光通信 / GPU 算力行业情报自动采集与研判管线：GitHub Actions 定时拉取多源 RSS 与市场行情 API，经级联过滤（去重 → 规则初筛 → LLM 研判）产出价格时序、结构化条目队列、每日简报与 P0 告警 Issue。零服务器成本。

## 架构（级联过滤）

```
数据源层（RSS ×5 / Vast.ai REST / 本地 feed ×1 / 探测源 ×4）
  → 采集与清洗（HTML 剥除、归一 StandardItem）
  → 去重（URL-hash，data/seen.json，30 天滚动窗口）
  → 一级规则初筛（关键词库 + 高信噪比源白名单；未过筛计噪声丢弃）
  → 二级 LLM 研判（OpenAI 兼容 API：实体抽取/TL;DR/P0-P2 分级；缺 key 自动降级纯规则）
  → 输出：
      data/series/gpu_prices.jsonl   GPU 挂牌价格时序
      data/queue/YYYY-MM-DD.jsonl    过筛条目队列（P0/P1/P2 + 未研判降级直通条目，通用下游 JSONL 接口，格式见下）
      data/briefs/YYYY-MM-DD.md      每日简报（人读）
      GitHub Issues                  P0 即时警报（同题去重）
      data/health.json               全端点健康探测（每次运行更新）
```

## 本地 feed 生产者（反爬/动态源）

反爬与动态页面过不了客户端指纹检测（拦客户端不拦 IP，GitHub 出口属 Azure 数据中心段，机器人黑名单常客；详见"源健康"注），由**本机**完成提取、以文件形式经仓库供给 Actions——零服务暴露、零隧道、零月费：

```
本机（Windows 计划任务每日一次 → tools/local-feeds.mjs）
  提取（HTTP 直取或 puppeteer 渲染）→ data/feeds/*.xml（标准 RSS 2.0）→ git push（只提交 data/feeds）
        ↓ 仓库 = 唯一真相源
GitHub Actions 从 checkout 读 data/feeds/*.xml → 与 RSS 源同构走完整管线
```

- 本机当天没跑 = 该源当日无更新，去重层兜住节奏差异，不断供不报错
- 依赖分工：LightCounting 纯 HTTP 提取（零依赖）；Yole 需渲染（puppeteer-core 驱动系统 Chrome + stealth 插件，依赖装在 `tools/` 独立 package，不影响根 `npm ci`；首次使用先在 `tools/` 下 `npm install`，Chrome 路径可用环境变量 `LOCAL_FEEDS_CHROME` 覆盖）
- **接口纪律：消费方永远以仓库 main 分支为准；本机 data/ 其余产物只是开发草稿，绝不提交——完整判定规则见下节「本地 ↔ GitHub 同步规范」**
- 部署（PowerShell 执行一次，时间自定，建议早于 Actions 的 01:17 UTC / 北京 09:17）：

```powershell
schtasks /create /tn "TechNews-LocalFeeds" /tr "\"C:\Program Files\nodejs\node.exe\" \"<仓库路径>\tools\local-feeds.mjs\"" /sc daily /st 09:00
```

  并在任务属性勾选"如果错过了计划开始时间，请尽快启动任务"（关机日开机后补跑）。

## 本地 ↔ GitHub 同步规范

本机定位 = **feed 执行机 + 开发工作区**；GitHub 仓库 = **唯一真相源**（代码、feeds、全部数据产物的最全版本；数据产物由 Actions 独家产出并提交）。判定原则一句话：**改动会影响 main 分支运行的必须推，本机私有状态绝不推。**

### 必须推（不推 = 功能不生效 / 断供）

| 内容 | 原因 |
|---|---|
| `src/`、`tools/`、`.github/workflows/`、`.gitignore` | Actions 跑的是**远端 main**——本地改完不推 = 线上仍是旧逻辑，且没有任何报错提醒你 |
| `package.json` **必须连带 `package-lock.json`** | Actions 用 `npm ci` 严格校验锁文件一致性，只推其一 = workflow 直接红 |
| `data/feeds/*.xml` | 本机核心职责。不推 = Actions 持续消费旧 feed（对应源停更）；推送后下一轮自动补齐，去重层兜住不重复 |

注意：cron 触发时间、`LLM_API_KEY`（Secret）、`LLM_BASE_URL` / `LLM_MODEL`（Variables）**只存在于 GitHub 仓库设置，本地仓库里没有对应物**——改这些去 Settings → Secrets and variables → Actions，与 push 无关。

### 绝不推（推了 = 污染真相源 / 永久损伤数据）

| 内容 | 后果 |
|---|---|
| 本地 `node src/main.mjs` 的调试产物：`data/briefs/`、`data/queue/`、`data/series/`、`data/seen.json`、`data/health.json` | 双重伤害：① 本地无 key，产出的是未研判降级版本，覆盖 Actions 的完整版本；② **`seen.json` 一旦上推，那批条目被永久标记已处理——降级直通是设计行为不重试，它们永远得不到 LLM 研判** |
| `tools/.browser-profile/` | stealth 浏览器身份（cookie/指纹/session）。推到公开仓库 = 交出反爬身份；多机克隆共用同身份会互相顶掉 session。已 .gitignore，保持 |
| `.env`、任何 key 材料 | 密钥纪律见「API Key 安全」。已 .gitignore |
| 一次性探针 / 实验脚本（如 `tools/probe-yole.mjs`） | 默认本地草稿；被生产链路引用（并入 local-feeds.mjs）或具文档价值时才转正提交 |

### 执行细则（防手滑，均为事故场景提炼）

- 本地提交**永远点名路径**：`git add data/feeds`、`git add src tools package.json package-lock.json`。**禁止**裸 `git add data`、`git add -A`、`git commit -a`——工作区里 always 躺着本地调试产物的改动，一扫全进。`tools/local-feeds.mjs` 的自动提交同样自我约束（只 `git add data/feeds`）
- 本地**勤 pull**：Actions 每天 01:17 UTC 都在 main 上产生 data 提交，本地落后时 feed 推送会被拒（non-fast-forward）直至同步——断供就是这么发生的。pull 前先丢弃调试产物改动：`git restore data/seen.json data/health.json data/briefs data/queue data/series`（只是草稿，丢了不心疼）
- `node src/main.mjs` 本地跑仅限开发调试（无 key = 纯规则模式，产出的 queue/brief 仅供看格式），跑完按上一条丢弃改动

## 数据产物

### data/queue/YYYY-MM-DD.jsonl —— 条目接口

每行一个过筛条目（规则初筛通过即入队，不再限于 P0/P1）：

| 字段 | 说明 |
|---|---|
| id / url / source | 条目 hash / 原文链接 / 源名称 |
| published / fetched_at | 文内发布时间 / 抓取时间（UTC） |
| title / category / priority | 规范化标题 / 分类 / P0-P2 |
| entities / tldr / key_takeaways / agent_comment | LLM 生成的研判摘要（参考信息，非事实口径） |
| keywords_hit | 一级初筛命中词 |
| llm_skipped | LLM 未研判直通（超上限/超时预算/研判失败），字段值 `true` 时其余 LLM 字段为空 |
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
| SEMI | HTML | ❌ 403 | 反爬拦截 |
| Yole | HTML | ✅ 已由本地 feed 供给 | DataDome 202 挑战已被本机 stealth Chrome 渲染突破（住宅 IP + 固定浏览器身份是关键）；裸探测恒 202 属预期 |
| LightCounting | HTML | ✅ 已由本地 feed 供给 | `/newsletters` 为服务端渲染页，HTTP 直取即可（注意 `/newsroom` 是伪 200 的 404 页，曾误导探测）；抓取目标可达性继续由 health.json 监控 |

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

- v2：SEMI 反爬待解（可试与 Yole 同源的本地 stealth 渲染方案）；IEEE 802.3 文件列表采集器；ComputePrices（90+ 云厂挂牌，需注册 key）
- 成本闸已内建：`MAX_LLM_ITEMS` 环境变量控制单轮研判条数上限
