// stockanalysis.com transcripts 采集器：索引页当 feed，去重前置于详情抓取。
//
// 站点特性（2026-10-07 实测，Node fetch 验证）：
// - 无反爬：标准 UA HTTP 直取全 200；robots.txt 仅禁 /e/ /p/，transcripts 路径允许
// - 索引页 /stocks/{ticker}/transcripts/ 一页含全部历史（NVDA 130+ 条，按财年分组），
//   每条卡片自带 Quartr AI 摘要（一段话）——摘要零边际成本，即条目简讯
// - 详情页 /stocks/{ticker}/transcripts/{eventId}-{slug}/ 全文服务端渲染：
//   发言人块 + 句级 <span class="transcript-sentence" data-start-sec>，无需浏览器
// - 数据源 Quartr（页脚声明），财报后数小时内发布；覆盖 earnings call 与会议 keynote
//
// 采集纪律（与项目"简讯+完整信息"原则对齐）：
// - 索引页 = 轮询（每轮每 ticker 一次，等同拉一个 RSS）；seen 命中的条目不再抓详情
// - 窗口外（SA_BACKFILL_DAYS）的老条目只标 seen 不产出，防首跑回灌全部历史
// - 原文不落盘（url 可复现）；全文仅作为 LLM 纪要（minutes）的原料在内存中使用
import { createHash } from 'node:crypto';
import { USER_AGENT } from './config.mjs';
import { decodeEntities, stripTags } from './collectors.mjs';

const BASE = 'https://stockanalysis.com';
const HEADERS = { 'User-Agent': USER_AGENT };
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

async function getHtml(url) {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
  if (res.status !== 200) throw new Error(`http ${res.status} ${url}`);
  return res.text();
}

const hashId = s => createHash('sha256').update(s).digest('hex').slice(0, 16);

// 索引页 → 条目存根列表 [{ slug, title, date, summary, link, item_id }]
// 解析为两遍匹配按 slug 汇聚：标题锚点、日期 span 紧随其后；Quartr 摘要在
// 展开面板 div[id^="transcript-panel-"] 的首个 <p>。卡片间内容靠 slug 关联，
// 不依赖卡片 DOM 边界（li 结构变化时仍稳）。
export function parseIndex(html, ticker) {
  const t = ticker.toLowerCase();
  const titles = new Map(); // slug -> { title, date }
  const linkRe = new RegExp(
    `<a href="/stocks/${t}/transcripts/([^/"]+)/"[^>]*>([^<]+)</a>[\\s\\S]{0,500}?<span[^>]*>([A-Z][a-z]{2} \\d{1,2}, \\d{4})</span>`, 'g');
  let m;
  while ((m = linkRe.exec(html))) {
    if (!titles.has(m[1])) titles.set(m[1], { title: stripTags(decodeEntities(m[2])).trim(), date: m[3] });
  }
  const summaries = new Map(); // slug -> summary
  const sumRe = /transcript-panel-([^"]+)"[\s\S]{0,1200}?<p[^>]*>([\s\S]*?)<\/p>/g;
  while ((m = sumRe.exec(html))) {
    const slug = m[1];
    const text = stripTags(decodeEntities(m[2])).trim();
    if (!summaries.has(slug) && text) summaries.set(slug, text);
  }
  const items = [];
  for (const [slug, { title, date }] of titles) {
    const dm = date.match(/^([A-Z][a-z]{2}) (\d{1,2}), (\d{4})$/);
    const ts = dm ? Date.UTC(+dm[3], MONTHS[dm[1]] ?? 0, +dm[2], 12) : NaN;
    const link = `${BASE}/stocks/${t}/transcripts/${slug}/`;
    items.push({ slug, title, dateTs: ts, published: new Date(ts).toISOString(), summary: summaries.get(slug) || '', link, item_id: hashId(link) });
  }
  // 新的在前（索引页顺序即时间倒序，保序即可）
  return items;
}

// 详情页全文 → "Speaker: text" 纯文本（保留发言人边界，供分块纪要使用）。
// 结构：#transcript-panel-full 内若干 <div class="border-t…"> 块，
// 块内加粗名 div + <p> 内句级 span。句内标签仅 span/空白，剥后即句子。
export function parseTranscript(html) {
  const i = html.indexOf('transcript-panel-full');
  const seg = i > 0 ? html.slice(i) : html;
  const blocks = seg.split(/<div class="border-t /).slice(1);
  const parts = [];
  for (const b of blocks) {
    const sm = b.match(/<div class="text-lg font-bold[^"]*">([\s\S]*?)<\/div>/);
    if (!sm) continue; // 非发言人块（相关推荐等）自然被跳过
    const speaker = stripTags(decodeEntities(sm[1])).trim();
    const sentences = [...b.matchAll(/<span class="transcript-sentence[^"]*"[^>]*>([\s\S]*?)<\/span>/g)]
      .map(s => stripTags(decodeEntities(s[1])).trim()).filter(Boolean);
    if (!sentences.length) continue;
    parts.push(`${speaker}: ${sentences.join(' ')}`);
  }
  return parts.join('\n\n');
}

// 主入口：逐 ticker 拉索引 → 存根过 seen/时间窗 → 新条目抓详情全文。
// 返回 { items(入管线的轻量条目), texts(item_id -> 全文,仅过筛候选), staleIds(窗口外,只标 seen) }
export async function collect(tickers, seen, backfillDays) {
  const cutoff = Date.now() - backfillDays * 86400 * 1000;
  const items = [];
  const texts = new Map();
  const staleIds = [];
  for (const ticker of tickers) {
    try {
      const html = await getHtml(`${BASE}/stocks/${ticker.toLowerCase()}/transcripts/`);
      const stubs = parseIndex(html, ticker);
      let fresh = 0;
      for (const s of stubs) {
        if (s.item_id in seen) continue;
        if (!Number.isFinite(s.dateTs) || s.dateTs < cutoff) { staleIds.push(s.item_id); continue; }
        const item = {
          source: 'StockAnalysis', title: `${ticker}: ${s.title}`,
          link: s.link, content: s.summary, digest: '',
          published: new Date(s.dateTs).toISOString().replace('.000Z', 'Z'),
          fetched_at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          item_id: s.item_id, sa_meta: { ticker, slug: s.slug },
        };
        items.push(item);
        fresh++;
        try {
          const full = parseTranscript(await getHtml(s.link));
          if (full) texts.set(s.item_id, { meta: item.sa_meta, title: item.title, published: item.published, link: s.link, text: full });
        } catch (ex) {
          console.log(`[collect] SA ${s.slug} 详情抓取失败（条目仍以 Quartr 摘要入队）: ${String(ex).slice(0, 80)}`);
        }
        await new Promise(r => setTimeout(r, 800)); // 礼貌间隔
      }
      console.log(`[collect] StockAnalysis ${ticker}: 索引 ${stubs.length} 条，新增 ${fresh}`);
    } catch (ex) {
      // 404 = 该 ticker 无 transcripts 收录（如 TSM，公司页存在但无转录）——非故障，
      // 记录后继续；Quartr 未来补录后自动恢复
      const msg = String(ex.message || ex);
      console.log(`[collect] StockAnalysis ${ticker}: ${/http 404/.test(msg) ? '无 transcripts 收录（404）' : '索引抓取失败 ' + msg.slice(0, 60)}`);
    }
  }
  return { items, texts, staleIds };
}
