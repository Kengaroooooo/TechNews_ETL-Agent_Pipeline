// 信源配置、关键词库、运行参数。
// 端点均经 2026-09-25 实测：
// - RSS 四家直连可用；TrendForce 真实端点为 /news/feed/（原始方案所给 rss.html 已 404）
// - Vast.ai 只认 q 参数（o/order/limit 会被 API 以 400 拒绝），单查询上限 64 条，型号名带空格
// - SEMI/Yole/LightCounting 反爬拦截，v1 仅探测
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const RSS_SOURCES = [
  { name: 'EE Times', url: 'https://www.eetimes.com/feed/' },
  { name: 'Light Reading', url: 'https://www.lightreading.com/rss.xml' },
  { name: 'Fierce Network', url: 'https://www.fierce-network.com/rss/xml' },
  { name: 'TrendForce', url: 'https://www.trendforce.com/news/feed/' },
];

// v1 仅健康探测（本地出口被反爬拦截；Actions 出口能否过，答案由 data/health.json 持续给出）
// 注：LightCounting 探测为 200（可达），但正文疑似 JS 壳，实际可采集性待 v2 渲染层验证
export const PROBE_ONLY = [
  { name: 'SEMI', url: 'https://www.semi.org/en/news-media-press' },
  // 已由本地 feed 供给（tools/local-feeds.mjs）；此处仅探测抓取目标的可达性
  { name: 'LightCounting', url: 'https://www.lightcounting.com/newsletters' },
  // 已由本地 feed 供给（stealth Chrome 渲染突破 DataDome）；裸探测恒 202 属预期，可采集性以 feed 实际产出为准
  { name: 'Yole Group', url: 'https://www.yolegroup.com/articles/' },
  { name: 'IEEE 802.3', url: 'https://www.ieee802.org/3/' }, // 本地 200 可达，采集器排期 v2
  // transcripts 采集由 src/stockanalysis.mjs 随采集记录诊断；此处探测代表性端点的总体可达性
  { name: 'StockAnalysis', url: 'https://stockanalysis.com/stocks/nvda/transcripts/' },
];

// stockanalysis.com transcripts（第四类采集器：索引页当 feed，见 src/stockanalysis.mjs）。
// watch list 与关键词库覆盖面对齐：GPU（NVDA/AMD）、网络芯片/光互联（AVGO/MRVL）、存储（MU）。
// 注：TSM 无 transcripts 收录（404），暂不列入；Quartr 补录后可加回
export const SA_TICKERS = ['NVDA', 'MRVL', 'AVGO', 'AMD', 'MU'];
export const SA_BACKFILL_DAYS = 90;        // 首跑只产出近 N 天 transcript，更早的只标 seen（防历史回灌）
export const SA_MAX_MINUTES_PER_RUN = 2;   // 每轮最多产 N 篇全文纪要（LLM 文档模式，防挤占新闻研判）
export const SA_MINUTES_BUDGET_MS = 5 * 60000; // 纪要子闸：与新闻研判共享 LLM 总预算，取 min(子闸, 总剩余)

export const VASTAI_ENDPOINT = 'https://console.vast.ai/api/v0/bundles/';
export const VASTAI_MODELS = ['H100 SXM', 'H100 NVL', 'H200', 'H200 NVL', 'B200', 'A100 SXM4', 'RTX 4090', 'RTX 5090'];
export const VASTAI_PAGE_CAP = 64; // API 单查询上限（实测；触顶时其 truncated 标志并不翻，须按 n>=cap 自行判定截断）

// 一级初筛关键词库（规则初筛降 LLM 成本；命中任一即过筛）。
// 不收录被其它词完整覆盖的词条：'b200' ⊃ 'gb200'，'photonic' ⊃ 'silicon photonics'。
// '/…/' 形式按正则匹配，用于裸子串易误伤的短词（如 'eml' 会命中含该字样的任意单词）。
export const KEYWORDS = [
  'hbm', 'cowos', 'tsmc', 'asml', 'cpo', 'lpo', 'transceiver', '800g', '1.6t', 'photonic',
  'wafer', 'nand', 'dram', 'gpu', 'optical', '/\\beml\\b/', 'serdes', 'backplane',
  'advanced packaging', 'wfe', 'h100', 'b200', 'h200', 'mi300', 'mi325', 'mi350', 'hyperscaler', 'capex',
  'foundry', 'infiniband', 'coherent', 'optics', 'data center', 'datacenter', 'ai accelerator', 'blackwell',
];

export const MAX_LLM_ITEMS = Number(process.env.MAX_LLM_ITEMS || 0) || Infinity; // 单轮 LLM 研判条数上限。缺省不限制（真正的闸是 LLM_BUDGET_MS 时间预算）；设正整数可恢复条数闸
// LLM 预算与 job 超时联动：预算（LLM_BUDGET_MINUTES，缺省 15）封顶为 job 超时（PIPELINE_TIMEOUT_MINUTES，
// 缺省 25）减 6 分钟——预留采集/输出/提交时间，防 LLM 拖到 job 超时被杀导致整轮产出丢失
const JOB_TIMEOUT_MIN = Number(process.env.PIPELINE_TIMEOUT_MINUTES || 25);
export const LLM_BUDGET_MS = Math.min(
  Number(process.env.LLM_BUDGET_MINUTES || 0) > 0 ? Number(process.env.LLM_BUDGET_MINUTES) * 60000 : 15 * 60000,
  Math.max(1, JOB_TIMEOUT_MIN - 6) * 60000,
);
export const RSS_PER_SOURCE = 200;       // 每源每轮取最新 N 条。不设实质限制（去重挡重复，成本闸在 MAX_LLM_ITEMS/内容截断），只防病态 feed（误配返回上万条）打爆内存与 seen.json
export const DEDUP_RETAIN_DAYS = 30;     // 去重索引保留窗口

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
// 本地 feed（data/feeds/*.xml）：由 tools/local-feeds.mjs 在本机生产并提交进仓库，
// 管线（本地或 Actions）从磁盘直接读取，无需本机在线、无需暴露服务。
export const LOCAL_FEEDS_DIR = path.join(DATA_DIR, 'feeds');

export const utcnow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
