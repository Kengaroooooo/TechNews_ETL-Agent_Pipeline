// 级联流水线入口：采集（含健康诊断）→ 去重 → 初筛 → LLM 研判/纪要 → 序列/早报/队列 → P0 告警 → 去重落盘。
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import * as collectors from './collectors.mjs';
import * as stockanalysis from './stockanalysis.mjs';
import * as minutes from './minutes.mjs';
import * as dedup from './dedup.mjs';
import * as filter from './filter.mjs';
import * as llm from './llm.mjs';
import * as series from './series.mjs';
import * as render from './render.mjs';
import {
  DATA_DIR, RSS_SOURCES, MAX_LLM_ITEMS, LLM_BUDGET_MS,
  SA_TICKERS, SA_BACKFILL_DAYS, SA_MAX_MINUTES_PER_RUN, SA_MINUTES_BUDGET_MS, utcnow,
} from './config.mjs';

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

  // 去重索引先载入：transcripts 采集器需要用它把去重闸前移到详情页抓取之前
  const seen = dedup.load();

  // 1. 采集（RSS 主端点的健康诊断随采集一并记录，避免同源二次全量拉取；另探测反爬源/API/备用端点）
  const items = [];
  const health = [];
  for (const src of RSS_SOURCES) {
    const { items: got, url, diag } = await collectors.fetchRss(src);
    console.log(`[collect] ${src.name}: ${got.length} items via ${url}`);
    items.push(...got);
    health.push(...diag);
  }
  // 1b. 本地 feed（data/feeds/*.xml，本机定时任务生产并提交；目录缺失自动跳过）
  const local = collectors.fetchLocalFeeds();
  if (local.files.length) console.log(`[collect] local feeds: ${local.items.length} items from ${local.files.join(', ')}`);
  items.push(...local.items);

  // 1c. stockanalysis transcripts（索引页当 feed：每 ticker 一请求即轮询；seen 命中/窗口外
  //     的条目不再抓详情页，去重前置控制采集成本。条目 content = 索引页自带 Quartr 摘要）
  const sa = await stockanalysis.collect(SA_TICKERS, seen, SA_BACKFILL_DAYS);
  items.push(...sa.items);

  health.push(...await collectors.probeEndpoints());
  writeHealth(health);
  const readings = await collectors.fetchVastai();
  console.log(`[collect] Vast.ai: ${readings.filter(r => !r.error).length}/${readings.length} models ok`);

  // 2. 去重（此处仅过滤；seen 提交延后到全部产出落盘之后——中途失败条目可被下轮重试）
  const fresh = items.filter(i => !(i.item_id in seen));
  console.log(`[dedup] ${items.length} fetched, ${fresh.length} new`);

  // 3. 一级规则初筛
  const passed = [];
  let noise = 0;
  for (const i of fresh) {
    const { pass, hits } = filter.passes(i);
    if (pass) { i.keywords_hit = hits; passed.push(i); } else noise++;
  }

  // 4. 二级 LLM 研判（双闸：条数上限 + 总时间预算。未研判条目不再静默丢弃，
  //    降级直通 queue/brief 并标 llm_skipped，下轮也不会因去重重复产出）
  const llmOn = llm.available();
  const deadline = Date.now() + LLM_BUDGET_MS;
  const graded = [];
  for (const [idx, i] of passed.entries()) {
    const withinCap = idx < MAX_LLM_ITEMS;
    const report = llmOn && withinCap ? await llm.analyze(i, deadline - Date.now()) : null;
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
      // 队列 content = 简讯口径（项目定位）：LLM 摘要 > 源方摘要(digest) > 原文截断。
      // 慷慨源（TrendForce 全文 RSS）的原文不再入队——研判在内存中吃过全文，url 可复现
      content: report?.summary || i.digest || i.content.slice(0, 400),
      llm_skipped: llmOn && !report,
    });
  }

  // 4b. 文档模式纪要：transcript 全文 → 分块提取 → 合并 data/minutes/*.md，队列补 minutes_file
  //     指针。独立子闸（SA_MINUTES_BUDGET_MS）且与新闻研判共享总预算——新闻优先，剩余给纪要；
  //     预算尽/条数满的 transcript 降级为 Quartr 摘要条目（minutes_file 留空），下轮不再补做
  let minutesDone = 0;
  if (llmOn) {
    const gradedById = new Map(graded.map(g => [g.id, g]));
    for (const [id, t] of sa.texts) {
      if (minutesDone >= SA_MAX_MINUTES_PER_RUN) break;
      if (!gradedById.has(id)) continue; // 只为过筛入队的条目产纪要（省 LLM）
      const left = Math.min(SA_MINUTES_BUDGET_MS, deadline - Date.now());
      if (left < 60000) break; // 一篇分块+合并至少需要一分钟量级
      try {
        const m = await minutes.digestTranscript(t, left);
        if (m) { gradedById.get(id).minutes_file = m.rel; minutesDone++; }
      } catch (ex) {
        console.log(`[minutes] ${t.meta.slug} 失败（条目仍以摘要入队）: ${String(ex).slice(0, 80)}`);
      }
    }
  }

  // 5. 输出
  series.append(readings);
  const issues = await createP0Issues(graded.filter(g => g.priority === 'P0'));
  const stats = {
    fetched: items.length, new: fresh.length, passed: passed.length, noise,
    p0: graded.filter(g => g.priority === 'P0').length,
    p1: graded.filter(g => g.priority === 'P1').length,
    p2: graded.filter(g => g.priority === 'P2').length,
    skipped: graded.filter(g => g.llm_skipped).length,
    minutes: minutesDone,
    p0_issues: issues,
  };
  // 各层执行状态汇总（简报「运行状态」块 + 末行日志用）
  // 端点在线 = 拿到 2xx/3xx 数字状态码；网络级失败（status='network-error' 字符串）与
  // >=400 一律算离线——字符串与数字比较恒为 false，不能只写 status >= 400
  const isDown = h => !(typeof h.status === 'number' && h.status >= 200 && h.status < 400);
  const failMap = new Map();
  for (const h of health) if (isDown(h)) {
    const k = `${h.name} ${h.status}`;
    failMap.set(k, (failMap.get(k) || 0) + 1);
  }
  const diag = {
    srcOk: health.length - [...failMap.values()].reduce((a, b) => a + b, 0),
    srcTotal: health.length,
    srcFailed: [...failMap].map(([k, n]) => (n > 1 ? `${k}×${n}` : k)).join('、'),
    localFeeds: local.files.length
      ? `${local.files.length} 个（${local.files.map(f => f.replace(/\.xml$/, '')).join('、')}）` : '',
    vastOk: readings.filter(r => !r.error).length,
    vastTotal: readings.length,
    llm: llm.state(),
  };
  render.writeBrief(runTs, readings, graded, stats, llmOn, diag);
  render.writeQueue(runTs, graded);

  // 6. 全部产出落盘后提交去重索引（在此之前失败 = 下轮重试，而非永久丢条目）。
  //    transcripts 窗口外的老条目同样在此标 seen——它们不产出，但下轮不再出现在"新增"里
  const now = Math.floor(Date.now() / 1000);
  for (const i of fresh) seen[i.item_id] = now;
  for (const id of sa.staleIds) seen[id] = now;
  const kept = dedup.save(seen);
  const llmState = !llmOn ? 'off' : diag.llm.tripped ? 'tripped' : 'on';
  console.log(`[pipeline] done: ${JSON.stringify(stats)} llm=${llmState} src=${diag.srcOk}/${diag.srcTotal} vast=${diag.vastOk}/${diag.vastTotal} seen=${kept}`);
}

main().catch(ex => { console.error('[pipeline] fatal:', ex); process.exit(1); });
