// URL-hash 去重索引（data/seen.json），滚动窗口清理。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DEDUP_RETAIN_DAYS } from './config.mjs';

const PATH = path.join(DATA_DIR, 'seen.json');

export function load() {
  if (!existsSync(PATH)) return {};
  try {
    return JSON.parse(readFileSync(PATH, 'utf8'));
  } catch (ex) {
    console.warn(`[dedup] seen.json 损坏，索引清零（本轮将出现重复条目）：${String(ex).slice(0, 80)}`);
    return {};
  }
}

export function save(idx) {
  const cutoff = Date.now() / 1000 - DEDUP_RETAIN_DAYS * 86400;
  const pruned = Object.fromEntries(Object.entries(idx).filter(([, v]) => v >= cutoff));
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(PATH, JSON.stringify(pruned));
  return Object.keys(pruned).length;
}
