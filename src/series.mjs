// GPU 挂牌价格时序（data/series/gpu_prices.jsonl）——价格序列的单一存放处。
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR, utcnow } from './config.mjs';

const PATH = path.join(DATA_DIR, 'series', 'gpu_prices.jsonl');

export function append(readings) {
  mkdirSync(path.dirname(PATH), { recursive: true });
  const ts = utcnow();
  for (const rec of readings) {
    appendFileSync(PATH, JSON.stringify({ ts, ...rec }) + '\n');
  }
}
