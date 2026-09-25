// 一级规则初筛：关键词库命中，或高信噪比源白名单直通。
import { KEYWORDS, AUTO_PASS_SOURCES } from './config.mjs';

export function passes(item) {
  const text = (item.title + ' ' + item.content).toLowerCase();
  const hits = KEYWORDS.filter(k => text.includes(k));
  if (AUTO_PASS_SOURCES.has(item.source)) return { pass: true, hits };
  return { pass: hits.length > 0, hits };
}
