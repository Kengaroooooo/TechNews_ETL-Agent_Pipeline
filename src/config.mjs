// 信源配置、关键词库、运行参数。
// 端点均经 2026-09-25 实测：
// - RSS 四家直连可用；TrendForce 真实端点为 /news/feed/（原始方案所给 rss.html 已 404）
// - Vast.ai 只认 q 参数（o/order/limit 会被 API 以 400 拒绝），单查询上限 64 条，型号名带空格
// - SemiAnalysis 主域名 Cloudflare 盾，备 .substack.com 端点；SEMI/Yole/LightCounting 反爬拦截，v1 仅探测
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export const RSS_SOURCES = [
  { name: 'EE Times', url: 'https://www.eetimes.com/feed/' },
  { name: 'Light Reading', url: 'https://www.lightreading.com/rss.xml' },
  { name: 'Fierce Network', url: 'https://www.fierce-network.com/rss/xml' },
  { name: 'TrendForce', url: 'https://www.trendforce.com/news/feed/' },
  { name: 'SemiAnalysis', url: 'https://www.semianalysis.com/feed', alt: 'https://semianalysis.substack.com/feed' },
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
];

export const VASTAI_ENDPOINT = 'https://console.vast.ai/api/v0/bundles/';
export const VASTAI_MODELS = ['H100 SXM', 'H100 NVL', 'H200', 'H200 NVL', 'B200', 'A100 SXM4', 'RTX 4090', 'RTX 5090'];

// 一级初筛关键词库（规则初筛降 LLM 成本；命中任一即过筛）。
// 不收录被其它词完整覆盖的词条：'b200' ⊃ 'gb200'，'photonic' ⊃ 'silicon photonics'。
export const KEYWORDS = [
  'hbm', 'cowos', 'tsmc', 'asml', 'cpo', 'lpo', 'transceiver', '800g', '1.6t', 'photonic',
  'wafer', 'nand', 'dram', 'gpu', 'optical', 'eml', 'serdes', 'backplane',
  'advanced packaging', 'wfe', 'h100', 'b200', 'h200', 'mi300', 'hyperscaler', 'capex',
  'foundry', 'infiniband', 'coherent', 'optics', 'data center', 'ai accelerator', 'blackwell',
];
// 高信噪比源免关键词初筛
export const AUTO_PASS_SOURCES = new Set(['SemiAnalysis']);

export const MAX_LLM_ITEMS = Number(process.env.MAX_LLM_ITEMS || 20); // 单轮 LLM 研判条数上限（成本闸）
export const LLM_BUDGET_MS = 15 * 60 * 1000; // LLM 研判总时间闸（workflow 超时 25min 的 60%，留出采集/输出余量）
export const RSS_PER_SOURCE = 10;        // 每源每轮取最新 N 条
export const DEDUP_RETAIN_DAYS = 30;     // 去重索引保留窗口

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
// 本地 feed（data/feeds/*.xml）：由 tools/local-feeds.mjs 在本机生产并提交进仓库，
// 管线（本地或 Actions）从磁盘直接读取，无需本机在线、无需暴露服务。
export const LOCAL_FEEDS_DIR = path.join(DATA_DIR, 'feeds');

export const utcnow = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
