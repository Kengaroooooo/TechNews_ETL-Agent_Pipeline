// 级联流水线入口：探测 → 采集 → 去重 → 初筛 → LLM 研判 → 序列/早报/队列 → P0 告警。
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import * as collectors from './collectors.mjs';
import * as dedup from './dedup.mjs';
import * as filter from './filter.mjs';
import * as llm from './llm.mjs';
import * as series from './series.mjs';
import * as render from './render.mjs';
import { DATA_DIR, RSS_SOURCES, MAX_LLM_ITEMS, utcnow } from './config.mjs';

function writeHealth(results) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path.join(DATA_DIR, 'health.json'),
    JSON.stringify({ checked_at: utcnow(), sources: results }, null, 1));
}

// P0 警报：开 GitHub Issue（用运行时注入的 GITHUB_TOKEN，仅本仓库；本地无 token 自动跳过）。
async function createP0Issues(p0Items) {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.REPO;
  if (!token || !repo || !p0Items.length) return 0;
  const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json' };
  const openTitles = new Set();
  try {
    for (let page = 1; page <= 4; page++) {
      const res = await fetch(`https://api.github.com/repos/${repo}/issues?state=open&per_page=100&page=${page}`,
        { headers, signal: AbortSignal.timeout(15000) });
      if (res.status !== 200) break;
      const batch = await res.json();
      if (!Array.isArray(batch) || !batch.length) break;
      batch.forEach(i => openTitles.add(i.title));
    }
  } catch { return 0; }
  let n = 0;
  for (const g of p0Items) {
    const title = `[P0] ${g.title.slice(0, 90)}`;
    if (openTitles.has(title)) continue;
    const body = [
      `**来源**：${g.source}`, `**链接**：${g.url}`, `**抓取**：${g.fetched_at}`, '',
      `**TL;DR**：${g.tldr || ''}`, '', '**要点**',
      ...g.key_takeaways.map(k => `- ${k}`), '',
      `**点评**：${g.agent_comment || ''}`, '', '**内容快照**', '',
      '> ' + g.content.slice(0, 1500).replace(/\n+/g, '\n> '),
    ].join('\n');
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/issues`,
        { method: 'POST', headers, body: JSON.stringify({ title, body }), signal: AbortSignal.timeout(15000) });
      if (res.status === 201) n++;
    } catch { /* 单条失败不阻断 */ }
  }
  return n;
}

async function main() {
  const runTs = utcnow();
  console.log(`[pipeline] cycle start ${runTs}`);

  // 0. 健康探测（含反爬源——Actions 出口的真实可达性由这里持续记录）
  writeHealth(await collectors.probeAll());

  // 1. 采集
  const items = [];
  for (const src of RSS_SOURCES) {
    const { items: got, url } = await collectors.fetchRss(src);
    console.log(`[collect] ${src.name}: ${got.length} items via ${url}`);
    items.push(...got);
  }
  const readings = await collectors.fetchVastai();
  console.log(`[collect] Vast.ai: ${readings.filter(r => !r.error).length}/${readings.length} models ok`);

  // 2. 去重
  const seen = dedup.load();
  const fresh = items.filter(i => !(i.item_id in seen));
  const now = Math.floor(Date.now() / 1000);
  for (const i of fresh) seen[i.item_id] = now;
  dedup.save(seen);
  console.log(`[dedup] ${items.length} fetched, ${fresh.length} new`);

  // 3. 一级规则初筛
  const passed = [];
  let noise = 0;
  for (const i of fresh) {
    const { pass, hits } = filter.passes(i);
    if (pass) { i.keywords_hit = hits; passed.push(i); } else noise++;
  }

  // 4. 二级 LLM 研判（成本闸：单轮上限 MAX_LLM_ITEMS；缺 key 自动降级纯规则）
  const llmOn = llm.available();
  const graded = [];
  for (const i of passed.slice(0, MAX_LLM_ITEMS)) {
    const report = llmOn ? await llm.analyze(i) : null;
    graded.push({
      id: i.item_id, url: i.link, source: i.source,
      published: i.published, fetched_at: i.fetched_at,
      title: report?.title || i.title,
      category: report?.category || '',
      priority: report?.priority || 'P2',
      entities: report?.entities || {},
      tldr: report?.tldr || '',
      key_takeaways: report?.key_takeaways || [],
      agent_comment: report?.agent_comment || '',
      keywords_hit: i.keywords_hit || [],
      content: i.content.slice(0, 8000),
    });
  }
  const overflow = Math.max(0, passed.length - MAX_LLM_ITEMS);

  // 5. 输出
  series.append(readings);
  const stats = {
    new: fresh.length, passed: passed.length, noise,
    p0: graded.filter(g => g.priority === 'P0').length,
    p1: graded.filter(g => g.priority === 'P1').length,
    p2: graded.filter(g => g.priority === 'P2').length,
  };
  render.writeBrief(runTs, readings, graded, stats, llmOn);
  render.writeQueue(runTs, graded);
  const issues = await createP0Issues(graded.filter(g => g.priority === 'P0'));
  console.log(`[pipeline] done: ${JSON.stringify(stats)} llm=${llmOn} overflow=${overflow} p0_issues=${issues}`);
}

main().catch(ex => { console.error('[pipeline] fatal:', ex); process.exit(1); });
