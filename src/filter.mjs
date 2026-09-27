// 一级规则初筛：关键词库命中（普通词条子串匹配；'/…/' 形式按正则，用于易误伤的短词）。
import { KEYWORDS } from './config.mjs';

export function passes(item) {
  const text = (item.title + ' ' + item.content).toLowerCase();
  const hit = k => (k.startsWith('/') ? new RegExp(k.slice(1, -1), 'i').test(text) : text.includes(k));
  const hits = KEYWORDS.filter(hit);
  return { pass: hits.length > 0, hits };
}
