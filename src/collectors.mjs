// 三类采集器：RSS（fast-xml-parser）、Vast.ai REST、健康探测。
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import {
  USER_AGENT, RSS_SOURCES, PROBE_ONLY, VASTAI_ENDPOINT, VASTAI_MODELS, RSS_PER_SOURCE, utcnow,
} from './config.mjs';

const xp = new XMLParser({ ignoreAttributes: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HEADERS = { 'User-Agent': USER_AGENT };

export function stripTags(s = '') {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeItem({ source, title, link, content, published }) {
  link = String(link ?? '').trim();
  title = stripTags(title ?? '');
  const base = link || source + title;
  return {
    source, title, link,
    content: stripTags(content ?? ''),
    published: String(published ?? ''),
    fetched_at: utcnow(),
    item_id: createHash('sha256').update(base).digest('hex').slice(0, 16),
  };
}

// 拉单个 RSS 源（RSS 2.0 与 Atom 双格式），主端点失败自动尝试备用端点。
export async function fetchRss(src) {
  const urls = [src.url, ...(src.alt ? [src.alt] : [])];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      if (res.status !== 200) continue;
      const parsed = xp.parse(await res.text());
      const channel = parsed?.rss?.channel ?? parsed?.feed ?? {};
      let entries = channel.item ?? channel.entry ?? [];
      if (!Array.isArray(entries)) entries = entries ? [entries] : [];
      const items = entries.slice(0, RSS_PER_SOURCE)
        .map(e => makeItem({
          source: src.name,
          title: e.title ?? '',
          link: e.link?.href ?? e.link ?? '',
          content: e['content:encoded'] ?? e.content ?? e.summary ?? e.description ?? '',
          published: e.pubDate ?? e.published ?? e.updated ?? '',
        }))
        .filter(i => i.title || i.content);
      return { items, url };
    } catch { /* 端点失败 → 试下一个 */ }
  }
  return { items: [], url: urls[0] };
}

// Vast.ai 分型号挂牌统计。注意：只认 q 参数（排序/条数参数会被 400 拒绝），统计在客户端做。
export async function fetchVastai(models = VASTAI_MODELS) {
  const readings = [];
  for (const m of models) {
    const q = JSON.stringify({ rentable: { eq: true }, gpu_name: { eq: m } });
    const rec = { model: m };
    try {
      const res = await fetch(`${VASTAI_ENDPOINT}?q=${encodeURIComponent(q)}`,
        { headers: HEADERS, signal: AbortSignal.timeout(30000) });
      if (res.status !== 200) {
        rec.error = `http ${res.status}`;
      } else {
        const j = await res.json();
        const offers = j.offers ?? [];
        const prices = offers.map(o => o.dph_total).filter(v => typeof v === 'number').sort((a, b) => a - b);
        rec.n = prices.length;
        rec.truncated = j.truncated;
        if (prices.length) {
          const pct = f => prices[Math.min(prices.length - 1, Math.floor(prices.length * f))];
          const r3 = v => Math.round(v * 1000) / 1000;
          rec.min = r3(prices[0]); rec.p25 = r3(pct(0.25)); rec.p50 = r3(pct(0.5));
          rec.p75 = r3(pct(0.75)); rec.max = r3(prices[prices.length - 1]);
          rec.avg = r3(prices.reduce((s, v) => s + v, 0) / prices.length);
        }
      }
    } catch (ex) {
      rec.error = String(ex).slice(0, 100);
    }
    readings.push(rec);
    await sleep(1000); // 礼貌间隔
  }
  return readings;
}

// 全端点健康探测（含反爬拦截源——换出口后的真实可达性由这里持续记录进 data/health.json）。
export async function probeAll() {
  const targets = [
    ...RSS_SOURCES.map(s => ({ name: s.name, url: s.url, kind: 'rss' })),
    ...RSS_SOURCES.filter(s => s.alt).map(s => ({ name: `${s.name} 备用端点`, url: s.alt, kind: 'rss' })),
    ...PROBE_ONLY.map(s => ({ name: s.name, url: s.url, kind: 'probe-only' })),
    { name: 'Vast.ai API', url: VASTAI_ENDPOINT, kind: 'api' },
  ];
  const results = [];
  for (const t of targets) {
    const rec = { name: t.name, kind: t.kind, url: t.url };
    const t0 = Date.now();
    try {
      const res = await fetch(t.url, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
      rec.status = res.status;
      if (t.kind === 'rss' && res.status === 200) {
        try {
          const parsed = xp.parse(await res.text());
          const e = parsed?.rss?.channel?.item ?? parsed?.feed?.entry ?? [];
          rec.entries = Array.isArray(e) ? e.length : e ? 1 : 0;
        } catch { /* 解析失败不影响状态记录 */ }
      }
    } catch (ex) {
      rec.status = 'network-error';
      rec.error = String(ex).slice(0, 100);
    }
    rec.ms = Date.now() - t0;
    results.push(rec);
  }
  return results;
}
