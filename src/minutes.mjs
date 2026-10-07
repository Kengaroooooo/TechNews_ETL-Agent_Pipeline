// 文档模式：transcript 全文 → 发言人边界分块 → 逐块 LLM 提取 → 合并结构化纪要。
// 与新闻条目模式（llm.analyze，产出 50 字 tldr + 150 字 summary）互补——
// 40-60K 字符的会议转录需要多次调用才能"全面"，产物是独立文件 data/minutes/*.md，
// 队列条目只带 minutes_file 指针。原文不落盘（url 可复现），全文仅在内存中作原料。
//
// 预算纪律：分块循环实时检查剩余预算，不足则提前终止并降级为"要点直拼"产出
// （标注部分提取）；底层复用 llm.chat（协议自适应/熔断/围栏容错统一实现）。
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';
import * as llm from './llm.mjs';

const MINUTES_DIR = path.join(DATA_DIR, 'minutes');
const CHUNK_CHARS = 6000; // 单块字符上限：低于内容窗口下限（1000）不可能触发上下文超限

// 按发言人块边界分块（块 = "Speaker: text" 段落），Q&A 结构不被切断；
// 单发言超长（CEO 长段）按句子硬切兜底。
export function chunkBySpeaker(text, maxChars = CHUNK_CHARS) {
  const chunks = [];
  let cur = '';
  const flush = () => { if (cur) { chunks.push(cur); cur = ''; } };
  for (const p of text.split('\n\n')) {
    if (p.length > maxChars) {
      flush();
      const sentences = p.match(/[^.!?]+[.!?]+["')\]]*\s*/g) || [p];
      let piece = '';
      for (const s of sentences) {
        if (piece && piece.length + s.length > maxChars) { chunks.push(piece); piece = ''; }
        piece += s;
      }
      if (piece) chunks.push(piece);
      continue;
    }
    if (cur && cur.length + p.length > maxChars) flush();
    cur += (cur ? '\n\n' : '') + p;
  }
  flush();
  return chunks;
}

const CHUNK_PROMPT = `你是行业情报分析师。下面是一份公司财报电话会/行业会议转录的一个片段（格式 "发言人: 内容"）。
提取该片段中的关键信息，输出严格 JSON：
{"points":["每条一个独立事实/观点/数字，中文，保留具体数字、指引、产品型号、厂商名与发言人（如 CFO/CEO/分析师）"]}
要求：只依据输入材料；寒暄、操作提示、无实质内容返回空数组；禁止推测。`;

const MERGE_PROMPT = `你是资深行业分析师。下面是一份公司会议转录的分块提取结果（JSON 数组，每条为片段提取的事实点，按转录顺序排列）。
将其合并为结构化中文纪要，Markdown 格式，小节固定为：
## 核心结论
## 财务与指引
## 业务与产品要点
## Q&A 焦点
## 风险与措辞变化
要求：去重合并同类项；数字保留原文口径并注明主体；"财务与指引"无数字则写"未披露"；"Q&A 焦点"提炼分析师追问与管理层回应（无 Q&A 内容则写"本会议无 Q&A"）；只依据输入，禁止推测。直接输出 Markdown 正文，不要围栏。`;

// 生成一篇纪要。budgetMs 为本篇的剩余预算；返回 { rel, points, degraded } 或 null（无实质产出）。
export async function digestTranscript({ meta, title, published, link, text }, budgetMs) {
  const deadline = Date.now() + budgetMs;
  const chunks = chunkBySpeaker(text);
  const points = [];
  let degraded = false;
  for (const c of chunks) {
    const left = deadline - Date.now();
    if (left < 15000) { degraded = true; break; } // 剩余预算不够再跑一块+合并，提前收口
    const raw = await llm.chat(CHUNK_PROMPT, c, Math.min(180000, left), { json: true });
    if (raw == null) { degraded = true; break; } // 熔断/失败——已收集的要点照常产出
    try {
      const pts = JSON.parse(raw).points;
      if (Array.isArray(pts)) points.push(...pts.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()));
    } catch { /* 单块输出破损：丢块不丢篇 */ }
  }
  if (!points.length) return null;

  // 合并成文；预算不足或合并失败则降级为要点直拼
  let body = '';
  const left = deadline - Date.now();
  if (left > 15000) {
    const merged = await llm.chat(MERGE_PROMPT, JSON.stringify(points), Math.min(180000, left), { json: false });
    if (merged && merged.length > 100) body = merged;
  }
  if (!body) {
    degraded = true;
    body = ['## 要点提取（合并降级：预算不足或合并失败，按转录顺序直拼）', ...points.map(p => `- ${p}`)].join('\n');
  }

  const file = `${meta.ticker}-${meta.slug}.md`;
  const rel = `data/minutes/${file}`;
  mkdirSync(MINUTES_DIR, { recursive: true });
  writeFileSync(path.join(MINUTES_DIR, file), [
    `# ${title}`,
    '',
    `- 日期：${published?.slice(0, 10) ?? '未知'}`,
    `- 原文：${link}`,
    `- 生成：${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}${degraded ? '（部分提取：预算或服务中断，非完整纪要）' : ''}`,
    '', body, '',
  ].join('\n'));
  console.log(`[minutes] ${file}：${chunks.length} 块 → ${points.length} 要点${degraded ? '（降级产出）' : ''}`);
  return { rel, points: points.length, degraded };
}
