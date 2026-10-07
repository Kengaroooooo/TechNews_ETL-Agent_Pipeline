// 下游输出：每日简报（人读）+ 条目队列（原件+元数据，通用 JSONL 接口）。
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const BRIEF_DIR = path.join(DATA_DIR, 'briefs');
const QUEUE_DIR = path.join(DATA_DIR, 'queue');

export function writeBrief(runTs, readings, graded, stats, llmOn, diag) {
  mkdirSync(BRIEF_DIR, { recursive: true });
  const lines = [`\n## ${runTs.slice(11, 16)} UTC 运行\n`];
  // 运行状态：各层执行状态一览，放在最前——不读正文即可判断本轮质量
  const llmLine = !llmOn ? '关（缺 key，纯规则模式）'
    : diag.llm.tripped ? `开 → 熔断（${diag.llm.reason}），剩余条目降级规则模式`
    : '开';
  lines.push('### 运行状态\n');
  lines.push(`- 采集：端点 ${diag.srcOk}/${diag.srcTotal} 在线；本地 feed ${diag.localFeeds || '无'}；Vast.ai ${diag.vastOk}/${diag.vastTotal} 型号`);
  lines.push(`- 异常源：${diag.srcFailed || '无'}`);
  lines.push(`- 去重：拉取 ${stats.fetched} 条 → 新增 ${stats.new} 条`);
  lines.push(`- 初筛：过筛 ${stats.passed} 条 / 拒 ${stats.noise} 条`);
  lines.push(`- LLM 研判：${llmLine}${llmOn ? `（研判成功 ${stats.passed - stats.skipped} 条，降级直通 ${stats.skipped} 条）` : ''}`);
  lines.push(`- 产出：P0 ${stats.p0} / P1 ${stats.p1} / P2 ${stats.p2}；纪要 ${stats.minutes ?? 0} 篇；P0 告警 Issue ${stats.p0_issues}`);
  lines.push('');
  const ok = readings.filter(r => r.p50 !== undefined);
  if (ok.length) {
    lines.push('### GPU 现货挂牌（Vast.ai，$/GPU·hr）\n');
    lines.push('| 型号 | n | min | P50 | avg | 截断 |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of ok) {
      lines.push(`| ${r.model} | ${r.n} | ${r.min ?? '-'} | ${r.p50} | ${r.avg ?? '-'} | ${r.truncated ? '是' : '否'} |`);
    }
    lines.push('');
  }
  for (const [pri, head] of [['P0', '### P0 破局性/重大异动'], ['P1', '### P1 正常技术跟进'], ['P2', '### P2 行业一般动态']]) {
    const rows = graded.filter(g => g.priority === pri);
    if (rows.length) {
      lines.push(head + '\n');
      for (const g of rows) lines.push(`- **${g.title.slice(0, 90)}**（${g.source}）— ${g.tldr || ''}`);
      lines.push('');
    }
  }
  const p = path.join(BRIEF_DIR, `${runTs.slice(0, 10)}.md`);
  appendFileSync(p, lines.join('\n'));
  return p;
}

// 条目队列：原件+元数据+LLM 研判摘要（机器摘要为参考信息，非事实口径）。
export function writeQueue(runTs, graded) {
  mkdirSync(QUEUE_DIR, { recursive: true });
  const p = path.join(QUEUE_DIR, `${runTs.slice(0, 10)}.jsonl`);
  for (const g of graded) appendFileSync(p, JSON.stringify(g) + '\n');
  return p;
}
