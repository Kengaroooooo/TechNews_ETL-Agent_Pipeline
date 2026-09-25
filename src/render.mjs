// 下游输出：每日简报（人读）+ 条目队列（原件+元数据，通用 JSONL 接口）。
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

const BRIEF_DIR = path.join(DATA_DIR, 'briefs');
const QUEUE_DIR = path.join(DATA_DIR, 'queue');

export function writeBrief(runTs, readings, graded, stats, llmOn) {
  mkdirSync(BRIEF_DIR, { recursive: true });
  const lines = [`\n## ${runTs.slice(11, 16)} UTC 运行\n`];
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
  lines.push(`统计：本轮新增 ${stats.new} 条，过筛 ${stats.passed} 条（P0 ${stats.p0} / P1 ${stats.p1} / P2 ${stats.p2}），未过筛 ${stats.noise} 条；LLM 研判层：${llmOn ? '开' : '关（缺 key，纯规则模式）'}\n`);
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
