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
import { decodeEntities, stripTags } from '../src/collectors.mjs'; // 实体解码/剥标签单一实现，直接复用

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FEEDS_DIR = path.join(ROOT, 'data', 'feeds');
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ITEMS = 15; // 单源入 feed 的最新 N 条（管线每轮只取 RSS_PER_SOURCE 条）
const BODY_CAP = 6000; // 单条正文入 feed 的字符上限（简讯义务之外的全文留存按需裁剪）
const DRY_RUN = process.env.LOCAL_FEEDS_DRY_RUN === '1'; // 调试开关：只提取写文件，不提交推送
// 一次性回灌：无视 prev 视全部条目为新（重抓全部正文）。用于描述能力上线后补齐存量，日常勿开
const BACKFILL = process.env.LOCAL_FEEDS_BACKFILL === '1';

// ---------- LightCounting：服务端渲染 HTML，纯 HTTP 提取，无需浏览器 ----------
// 页面结构（2026-09-25 实测）：/newsletters 为 55KB 服务端渲染 HTML，
// 条目均为 <h4><a href="/newsletter/en/<month>-<year>-<slug>-<id>">标题</a></h4>，无分页。
// 注意 /newsroom 路径并不存在（SPA 对 404 也返回 200，曾误导健康探测）。
const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// 详情页正文（2026-10-07 实测）：同样服务端渲染，正文在唯一 <h3> 标题后的一串 <p> 里；
// 报告付费部分页面本就不含（留存义务豁免——公开部分即全部可得信息）。
// 过滤 <40 字符的短段（页脚/杂项），截 BODY_CAP。
function extractLcBody(html) {
  const h3 = html.indexOf('<h3>');
  if (h3 < 0) return '';
  const seg = html.slice(h3).replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const paras = [...seg.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map(x => stripTags(decodeEntities(x[1])).trim())
    .filter(t => t.length >= 40);
  return paras.join('\n\n').slice(0, BODY_CAP);
}

// prevLinks：上一版 feed 已有的链接集合——新条目才抓详情页（成本闸，稳态每天 0-3 条）
async function extractLightCounting(haveText) {
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
  // 新条目补正文：URL 虽可复现（裸 HTTP 200），但顺手全文入 feed——下游免剥页
  for (const it of items) {
    if (haveText.has(it.link)) continue;
    try {
      const r = await fetch(it.link, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
      if (r.status === 200) {
        const body = extractLcBody(await r.text());
        if (body) it.description = body;
      }
    } catch (ex) {
      console.log(`[feed] LightCounting 正文抓取失败 ${it.link}: ${String(ex).slice(0, 80)}`);
    }
    await new Promise(r => setTimeout(r, 800)); // 礼貌间隔
  }
  return items;
}

// ---------- Yole：DataDome 202 挑战，需 stealth Chrome 渲染 ----------
// 2026-09-25 实测：stealth 插件 + 本机住宅 IP + 独立 userDataDir（攒信任分）即可通过挑战；
// 裸 HTTP 探测恒为 202 属预期。同样的代码在 GitHub Actions 的 Azure DC 出口过不去——
// 指纹检测拦的是客户端身份，不是渲染能力，这正是渲染必须留在本机的原因。
// puppeteer 依赖动态加载：tools/ 未 npm install 时仅 Yole 源失败，LightCounting 不受影响。
const CHROME_PATH = process.env.LOCAL_FEEDS_CHROME
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BROWSER_PROFILE = path.join(ROOT, 'tools', '.browser-profile'); // 固定身份攒 DataDome 信任分

async function extractYole(haveText) {
  const [{ default: puppeteer }, { default: StealthPlugin }] = await Promise.all([
    import('puppeteer-extra'),
    import('puppeteer-extra-plugin-stealth'),
  ]);
  puppeteer.use(StealthPlugin());
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    userDataDir: BROWSER_PROFILE,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 900 });
    const resp = await page.goto('https://www.yolegroup.com/articles/', {
      waitUntil: 'networkidle0', timeout: 60000,
    });
    if (resp.status() !== 200) throw new Error(`http ${resp.status}（DataDome 挑战未通过？）`);
    await new Promise(r => setTimeout(r, 4000)); // 等 FacetWP 列表与懒加载稳定
    const raw = await page.evaluate(() =>
      [...document.querySelectorAll('a.card-post')].slice(0, 30).map(a => ({
        href: a.href,
        title: a.querySelector('.card-post__title')?.textContent?.trim() || '',
        dateText: a.querySelector('time.card-post__date')?.textContent?.trim() || '',
      })));
    const items = [];
    for (const r of raw) {
      if (!r.href || !r.title) continue;
      const m = r.dateText.match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
      const d = m ? new Date(Date.UTC(+m[3], MONTHS[m[1].toLowerCase()] ?? 0, +m[2], 12)) : null;
      items.push({
        title: decodeEntities(r.title),
        link: r.href,
        pubDate: d ? d.toUTCString() : undefined,
      });
      if (items.length >= MAX_ITEMS) break;
    }
    if (!items.length) throw new Error('渲染成功但未提取到文章卡片（页面结构可能已变化）');
    // 新条目补正文（留存义务：DataDome 墙内 URL 不可复现，全文进 feed，仓库为唯一全文载体）。
    // 正文容器 .yole-content（2026-10-07 实测：随内容伸缩，strategy-insights 2K/访谈 75K；
    // 勿用启发式选择器——.single-post 是布局壳，混入导航/related/cookie 横幅）。
    // /industry-news/ 路径挑战更严：goto 常返 202，但挑战在页面内自动解开——
    // 以 waitForSelector(.yole-content) 为准而非 goto 状态码。留存义务方不裁剪，仅防病态封顶 120k
    for (const it of items) {
      if (haveText.has(it.link)) continue;
      try {
        await page.goto(it.link, { waitUntil: 'networkidle2', timeout: 45000 });
        const found = await page.waitForSelector('.yole-content', { timeout: 25000 }).then(() => true).catch(() => false);
        if (!found) throw new Error('正文容器未出现（DataDome 挑战未解）');
        const body = await page.evaluate(() => {
          const el = document.querySelector('.yole-content');
          return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
        });
        if (body) it.description = body.slice(0, 120000);
        else throw new Error('.yole-content 为空');
      } catch (ex) {
        console.log(`[feed] Yole 正文抓取失败 ${it.link}: ${String(ex).slice(0, 80)}`);
      }
    }
    return items;
  } finally {
    await browser.close();
  }
}

// ---------- 源注册表 ----------
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
  {
    file: 'yole.xml',
    channel: {
      title: 'Yole Group',
      link: 'https://www.yolegroup.com/articles/',
      description: 'Yole Group Industry Insights（本地 feed 生产者渲染抓取）',
    },
    extract: extractYole,
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
      // 正文（Yole=留存义务全文 / LightCounting=顺手全文）：管线的 fetchLocalFeeds
      // 读 description 入队列 content，简讯义务在此闭环
      it.description ? `<description>${esc(it.description)}</description>` : '',
      it.pubDate ? `<pubDate>${esc(it.pubDate)}</pubDate>` : '',
      '</item>',
    );
  }
  lines.push('</channel></rss>');
  return lines.filter(Boolean).join('\n') + '\n';
}

// ---------- 提交推送（仅 data/feeds，绝不带本地其余产物；本机无需日常 pull） ----------
function commitAndPush() {
  const git = args => execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  // 先清 data/ 其余产物的本地草稿（main.mjs 调试残留）：不清会阻塞 rebase 或在
  // autostash 回放时冲突。只点名产物路径，代码与 feeds 一概不碰（README 同步规范）
  const drafts = ['data/briefs', 'data/queue', 'data/series', 'data/seen.json', 'data/health.json'];
  const dirty = git(['status', '--porcelain', '--', ...drafts]);
  if (dirty) console.log(`[push] 丢弃本地 data 草稿（调试产物）:\n${dirty}`);
  // restore 逐路径执行：多路径是全有或全无，一条未跟踪会让其余路径的丢弃整体失效
  for (const p of drafts) { try { git(['restore', '--', p]); } catch { /* 未跟踪路径跳过 */ } }
  git(['clean', '-fdq', '--', ...drafts]);
  git(['add', 'data/feeds']);
  if (!git(['diff', '--cached', '--name-only'])) {
    console.log('[push] feeds 无变化，跳过提交');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  git(['commit', '-m', `feeds: 本地抓取 ${stamp} UTC`]);
  // 同步收敛在推送时刻：远端 main 每天有 Actions 的 data 提交，但本地（feeds+代码）与
  // 远端（data 产物）路径不相交，rebase 必然干净；--autostash 保住未提交的代码 WIP。
  // sslBackend=openssl：本机 schannel 对 github.com TLS 握手不稳定
  git(['-c', 'http.sslBackend=openssl', 'pull', '--rebase', '--autostash', 'origin', 'main']);
  git(['-c', 'http.sslBackend=openssl', 'push']);
  console.log('[push] 已同步远端并推送 data/feeds');
}

// ---------- 主流程：逐源提取 → 写 feed → 汇总提交 ----------
mkdirSync(FEEDS_DIR, { recursive: true });
let failed = 0;
for (const src of SOURCES) {
  try {
    const p = path.join(FEEDS_DIR, src.file);
    const prev = existsSync(p) ? readFileSync(p, 'utf8') : '';
    // 上一版已有正文的链接集合（guid 即 link）：抓过正文的条目不再重抓详情页（成本闸）。
    // 上轮抓取失败的（prev 无正文）不在集合内——下轮自动重试，DataDome 202 类瞬时拦截自愈
    const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    const prevDesc = new Map([...prev.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
      const link = m[1].match(/<guid>(.*?)<\/guid>/)?.[1]?.replace(/&amp;/g, '&');
      const desc = m[1].match(/<description>([\s\S]*?)<\/description>/)?.[1];
      return link ? [link, desc ? unesc(desc) : ''] : null;
    }).filter(Boolean));
    const haveText = BACKFILL ? new Set() : new Set([...prevDesc].filter(([, d]) => d).map(([l]) => l));
    const items = await src.extract(haveText);
    if (!items.length) throw new Error('提取到 0 条（页面结构可能已变化）');
    for (const it of items) if (!it.description) it.description = prevDesc.get(it.link) || '';
    const next = toRss(src.channel, items);
    writeFileSync(p, next);
    const withBody = items.filter(i => i.description).length;
    console.log(`[feed] ${src.channel.title}: ${items.length} 条（含正文 ${withBody}） -> ${path.relative(ROOT, p)}${prev === next ? '（内容无变化）' : ''}`);
  } catch (ex) {
    failed++;
    console.log(`[feed] ${src.channel.title} 失败（保留旧 feed）：${String(ex).slice(0, 120)}`);
  }
}
if (DRY_RUN) {
  console.log('[dry-run] LOCAL_FEEDS_DRY_RUN=1，跳过提交推送');
} else {
  commitAndPush();
}
console.log(`[done] ${SOURCES.length - failed}/${SOURCES.length} 源成功`);
process.exit(failed === SOURCES.length ? 1 : 0);
