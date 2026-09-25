// 本地 feed 生产者：把反爬/动态页的信源在本机提取成标准 RSS 2.0，写入 data/feeds/ 并提交推送。
//
// 架构定位（与 Actions 的分工）：
//   本脚本 = 原料生产者，只产 data/feeds/*.xml（Windows 计划任务每日触发，机器当天开机即可，
//   错过不补——去重层会兜住节奏差异）；
//   GitHub Actions = 唯一加工中心，从 checkout 读 data/feeds/*.xml 走完整管线；
//   消费方永远以仓库 main 分支为准，本机 data/ 其余产物只是开发草稿。
//
// 零依赖（Node ≥18 自带 fetch）；渲染类源（puppeteer 解 DataDome 等）与抓取类源同构，
// 后续在 SOURCES 里加 extract 即可。
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { decodeEntities } from '../src/collectors.mjs'; // 实体解码单一实现，直接复用

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEEDS_DIR = path.join(ROOT, 'data', 'feeds');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ITEMS = 15; // 单源入 feed 的最新 N 条（管线每轮只取 RSS_PER_SOURCE 条）

// ---------- LightCounting：服务端渲染 HTML，纯 HTTP 提取，无需浏览器 ----------
// 页面结构（2026-09-25 实测）：/newsletters 为 55KB 服务端渲染 HTML，
// 条目均为 <h4><a href="/newsletter/en/<month>-<year>-<slug>-<id>">标题</a></h4>，无分页。
// 注意 /newsroom 路径并不存在（SPA 对 404 也返回 200，曾误导健康探测）。
const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

async function extractLightCounting() {
  const res = await fetch('https://www.lightcounting.com/newsletters', {
    headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000),
  });
  if (res.status !== 200) throw new Error(`http ${res.status}`);
  const html = await res.text();
  const items = [];
  const re = /<h4><a href="(\/newsletter\/en\/([a-z]+-20\d\d)-[^"]+)">\s*([^<]+?)\s*<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && items.length < MAX_ITEMS) {
    const [, href, monthYear, title] = m;
    const [mon, yr] = monthYear.split('-');
    const d = new Date(Date.UTC(+yr, MONTHS[mon.toLowerCase()] ?? 0, 1, 12));
    items.push({
      title: decodeEntities(title).trim(),
      link: 'https://www.lightcounting.com' + href,
      pubDate: d.toUTCString(), // 月刊粒度：精确到月，日期取当月 1 号（不伪装成日精度）
    });
  }
  return items;
}

// ---------- 源注册表 ----------
// Yole：全路径 DataDome 202 挑战（连住宅 IP 也拦），需 puppeteer+stealth 渲染实验，
// 跑通前留在 PROBE_ONLY 仅探测。
const SOURCES = [
  {
    file: 'lightcounting.xml',
    channel: {
      title: 'LightCounting',
      link: 'https://www.lightcounting.com/newsletters',
      description: 'LightCounting LightTrends newsletters（本地 feed 生产者抓取）',
    },
    extract: extractLightCounting,
  },
];

// ---------- RSS 2.0 输出 ----------
const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function toRss(channel, items) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0"><channel>',
    `<title>${esc(channel.title)}</title>`,
    `<link>${esc(channel.link)}</link>`,
    `<description>${esc(channel.description)}</description>`,
  ];
  for (const it of items) {
    lines.push(
      '<item>',
      `<title>${esc(it.title)}</title>`,
      `<link>${esc(it.link)}</link>`,
      `<guid>${esc(it.link)}</guid>`,
      it.pubDate ? `<pubDate>${esc(it.pubDate)}</pubDate>` : '',
      '</item>',
    );
  }
  lines.push('</channel></rss>');
  return lines.filter(Boolean).join('\n') + '\n';
}

// ---------- 提交推送（仅 data/feeds，绝不带本地其余产物） ----------
function commitAndPush() {
  const git = args => execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  git(['add', 'data/feeds']);
  if (!git(['diff', '--cached', '--name-only'])) {
    console.log('[push] feeds 无变化，跳过提交');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  git(['commit', '-m', `feeds: 本地抓取 ${stamp} UTC`]);
  git(['push']);
  console.log('[push] 已提交并推送 data/feeds');
}

// ---------- 主流程：逐源提取 → 写 feed → 汇总提交 ----------
mkdirSync(FEEDS_DIR, { recursive: true });
let failed = 0;
for (const src of SOURCES) {
  try {
    const items = await src.extract();
    if (!items.length) throw new Error('提取到 0 条（页面结构可能已变化）');
    const p = path.join(FEEDS_DIR, src.file);
    const prev = existsSync(p) ? readFileSync(p, 'utf8') : '';
    const next = toRss(src.channel, items);
    writeFileSync(p, next);
    console.log(`[feed] ${src.channel.title}: ${items.length} 条 -> ${path.relative(ROOT, p)}${prev === next ? '（内容无变化）' : ''}`);
  } catch (ex) {
    failed++;
    console.log(`[feed] ${src.channel.title} 失败（保留旧 feed）：${String(ex).slice(0, 120)}`);
  }
}
commitAndPush();
console.log(`[done] ${SOURCES.length - failed}/${SOURCES.length} 源成功`);
process.exit(failed === SOURCES.length ? 1 : 0);
