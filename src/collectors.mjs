// 三类采集器：RSS（fast-xml-parser）、Vast.ai REST、健康探测。
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import {
  USER_AGENT, RSS_SOURCES, PROBE_ONLY, VASTAI_ENDPOINT, VASTAI_MODELS, RSS_PER_SOURCE, utcnow,
} from './config.mjs';

// ignoreAttributes:false 才能拿到 Atom <link href>；属性键 @_ 前缀，消费处须自行过滤。
const xp = new XMLParser({ ignoreAttributes: false });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const HEADERS = { 'User-Agent': USER_AGENT };

// 实体解码统一剥离：&amp; 必须最后解码，否则 &amp;lt; 会被双重还原成 <。
export function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(+d); } catch { return ''; }
    })
    .replace(/&amp;/gi, '&');
}

export function stripTags(s = '') {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// RSS/Atom 字段值可能是字符串、带属性文本节点（{'#text':..,'@_type':..}）、
// 嵌套元素（<title><a>..</a></title>，直接 String() 会成 [object Object]）或数组；统一拍平为纯文本。
export function asText(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(' ');
  const text = v['#text'] ?? v._;
  if (text != null) return asText(text);
  return Object.entries(v)
    .filter(([k]) => !k.startsWith('@_'))
    .map(([, x]) => asText(x))
    .filter(Boolean)
    .join(' ');
}

// Atom 的 <link href> 是属性节点，RSS 2.0 是文本节点；多条时优先取非 self 链接。
function asLink(v) {
  if (typeof v === 'string') return v;
  const arr = Array.isArray(v) ? v : [v];
  const withHref = arr.filter(l => l?.['@_href']);
  const pick = withHref.find(l => !l['@_rel'] || l['@_rel'] === 'alternate') ?? withHref[0];
  return pick?.['@_href'] ?? '';
}

export function makeItem({ source, title, link, content, published }) {
  link = asLink(link).trim();
  title = stripTags(decodeEntities(asText(title)));
  const contentText = stripTags(decodeEntities(asText(content)));
  // link 与 title 均空时回落 content 前缀，避免同源此类条目 hash 互相碰撞
  const base = link || (source + title + contentText.slice(0, 200));
  return {
    source, title, link,
    content: contentText,
    published: asText(published),
    fetched_at: utcnow(),
    item_id: createHash('sha256').update(base).digest('hex').slice(0, 16),
  };
}

// 拉单个 RSS 源（RSS 2.0 与 Atom 双格式），主端点失败自动尝试备用端点。
// 每个端点的响应健康随采集一并返回（diag），替代单独再拉一遍的二次请求。
export async function fetchRss(src) {
  const urls = [src.url, ...(src.alt ? [src.alt] : [])];
  const diag = [];
  for (const url of urls) {
    const t0 = Date.now();
    const rec = { name: src.name, kind: 'rss', url };
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(25000) });
      rec.status = res.status;
      if (res.status !== 200) {
        console.log(`[collect] ${src.name} 不可用: http ${res.status} ${url}`);
      } else {
        const parsed = xp.parse(await res.text());
        const channel = parsed?.rss?.channel ?? parsed?.feed ?? {};
        let entries = channel.item ?? channel.entry ?? [];
        if (!Array.isArray(entries)) entries = entries ? [entries] : [];
        rec.entries = entries.length;
        rec.ms = Date.now() - t0;
        diag.push(rec);
        const items = entries.slice(0, RSS_PER_SOURCE)
          .map(e => makeItem({
            source: src.name,
            title: e.title ?? '',
            link: e.link?.href ?? e.link ?? '',
            content: e['content:encoded'] ?? e.content ?? e.summary ?? e.description ?? '',
            published: e.pubDate ?? e.published ?? e.updated ?? '',
          }))
          .filter(i => i.title || i.content);
        return { items, url, diag };
      }
    } catch (ex) {
      rec.status = 'network-error';
      rec.error = String(ex).slice(0, 100);
      console.log(`[collect] ${src.name} 不可用: ${rec.status} ${url}`);
    }
    rec.ms = Date.now() - t0;
    diag.push(rec);
  }
  return { items: [], url: urls[0], diag };
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
          const pct = f => prices[Math.min(prices.length - 1, Math.max(0, Math.ceil(prices.length * f) - 1))];
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

// 探测不参与采集的端点（反爬源、API、RSS 备用端点）；RSS 主端点的健康由 fetchRss 的
// diag 随采集记录，避免对同源二次全量拉取（换出口后的真实可达性由此持续进 data/health.json）。
export async function probeEndpoints() {
  const targets = [
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
