// 二级 LLM 研判（严格 JSON 输出）+ 文档模式底层调用。协议自适应：LLM_BASE_URL 指向
// Anthropic 兼容端点（智谱 Coding Plan 的 /api/anthropic、Claude API）时走 /v1/messages
// 吃订阅额度，其余（DeepSeek/GLM API/Moonshot 等 OpenAI 兼容）走 /chat/completions 吃按量余额。
// 换服务商/换额度来源 = 只改 LLM_BASE_URL，协议由 URL 自动匹配。
//
// 密钥纪律：LLM_API_KEY 只从环境变量读取（GitHub Actions Secrets 注入），
// 不落代码、不落文件、不打印；缺 key 时返回 null，管线自动降级为纯规则模式。
const SYSTEM_PROMPT = `你是一名专注于半导体制造、先进封装、光通信互联与 AI 算力硬件的资深行业情报分析师。
对输入的产业信源内容做深度加工与研判。核心原则：
1. 严谨客观，过滤公关辞令、模糊吹捧与情绪化表达；
2. 优先提取硬指标：制程节点、封装形式(CoWoS/InFO/SoIC)、光模块速率(400G/800G/1.6T)、功耗(W)、成本/良率(%)、芯片型号(H100/B200/GB200等)及关键厂商；
3. 严格基于输入材料输出，禁止无根据推测，未明确的信息标注"未披露"；
4. 只输出严格 JSON，字段固定为：
{"title":"中文规范化标题","category":"Semiconductor|Optical_Comm|GPU_Compute|General","priority":"P0|P1|P2","entities":{"companies":[],"tech":[],"metrics":[]},"tldr":"50字内核心结论","summary":"150字左右中文信息性摘要：覆盖关键数字、事实与影响，供下游不回原文即可消费","key_takeaways":["要点1","要点2"],"agent_comment":"分析师视角一句话点评（核心看点与风险）"}`;

// 熔断（进程级状态，作用域 = 一轮管线）：欠费/鉴权类错误重试无意义，命中即停整轮；
// 其余 429（真限流）可能是瞬时抖动，连续 6 次（约两条的额度）才停。停后剩余条目
// 直接降级规则模式，不再空耗请求与预算；下一轮进程重启自然复位。
let tripped = false;
let streak429 = 0;
let tripReason = ''; // 人类可读的熔断原因（http 状态码 + 服务商错误码/消息），简报「运行状态」用

function trip(status, ecode, emsg) {
  tripped = true;
  tripReason = `http ${status}${ecode ? ` code ${ecode}` : ''}${emsg ? `：${emsg}` : ''}`.slice(0, 100);
  console.log(`[llm] breaker: http ${status}${ecode ? ` code ${ecode}` : ''} ${emsg}——本轮剩余条目跳过 LLM 研判，降级规则模式`);
  return null;
}

export const available = () => Boolean(process.env.LLM_API_KEY) && !tripped;

// 熔断状态快照（main 汇入简报「运行状态」）：tripped=false 表示本轮 LLM 层全程未熔断
export const state = () => ({ tripped, reason: tripReason });

// 协议判定：URL 里带 anthropic（域名或路径，如 open.bigmodel.cn/api/anthropic、
// api.anthropic.com）即视为 Anthropic 兼容端点，走 /v1/messages；其余走 OpenAI 兼容。
const isAnthropicBase = (base) => /(^|\.)anthropic\.com|\/anthropic/.test(base);

// 端点/头解析（新闻研判与文档模式共用）。Anthropic 无 response_format、system 独立字段、
// max_tokens 必填、双头认证（x-api-key + Bearer 兼容原生 Claude API 与代理实现）。
function resolveEndpoint() {
  const base = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = process.env.LLM_MODEL || 'deepseek-chat';
  // 协议选择：LLM_PROTOCOL 显式指定优先（anthropic|openai），否则按 URL 自动判定——
  // 覆盖自动判定覆盖不到的形态（如火山方舟 /api/plan 这类不含 anthropic 字样的 Anthropic 协议端点）
  const anthropic = String(process.env.LLM_PROTOCOL || (isAnthropicBase(base) ? 'anthropic' : 'openai')).toLowerCase() === 'anthropic';
  const endpoint = anthropic ? `${base}/v1/messages` : `${base}/chat/completions`;
  const headers = anthropic
    ? { 'x-api-key': process.env.LLM_API_KEY, 'Authorization': `Bearer ${process.env.LLM_API_KEY}`,
        'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    : { 'Authorization': `Bearer ${process.env.LLM_API_KEY}`, 'Content-Type': 'application/json' };
  return { base, model, anthropic, endpoint, headers };
}

// 上下文超限信号：analyze 捕获后减半内容窗口重试；minutes 的块固定 ≤6000 字符，不应触发
class ContextOverflow extends Error {}

// ---------- 内容窗口自适应（新闻条目模式） ----------
// 输入内容的截取长度跟随模型实际上下文上限，而非拍脑袋常数。解析优先级：
//   1) LLM_MAX_CONTENT_CHARS 显式指定（字符数）
//   2) 模型端点元数据折算（/models 里带 context_length 等字段的服务商；按保守 2 字符/token
//      折算，预留 system 提示 + 输出 + 裕量，封顶 16000 字符控制单请求体量）
//   3) 都拿不到 → 保守默认 3000 字符
// 运行中遇到"上下文超限"类 400 再自动减半重试（见 analyze），学习结果本轮内持续生效。
let contentChars; // undefined = 未初始化；作用域 = 一轮管线（进程级，重启复位）

// 返回内容窗口访问器：无参读、传参写（上下文超限减半时用）
async function resolveContentChars(base, anthropic, model, headers) {
  if (contentChars === undefined) {
    const env = Number(process.env.LLM_MAX_CONTENT_CHARS || 0);
    if (env > 0) {
      contentChars = env;
    } else {
      contentChars = 3000;
      try {
        const res = await fetch(`${base}${anthropic ? '/v1/models' : '/models'}`,
          { headers, signal: AbortSignal.timeout(10000) });
        if (res.status === 200) {
          const j = await res.json();
          const m = (j.data ?? j.models ?? []).find(x => x?.id === model);
          // 各家字段名不统一，取第一个能读到的上下文长度（token 数）
          const ctx = m && ['context_length', 'max_context_length', 'context_window', 'max_input_tokens', 'max_model_len', 'max_tokens']
            .map(k => Number(m[k])).find(n => Number.isFinite(n) && n > 0);
          if (ctx) {
            // 预留：system 提示 ~1k + 输出 max_tokens 4k + 裕量 1k ≈ 6k tokens；保守按 2 字符/token 折算
            contentChars = Math.min(16000, Math.max(1000, Math.floor((ctx - 6144) * 2)));
            console.log(`[llm] ${model} 上下文 ${ctx} tokens → 内容窗口 ${contentChars} 字符`);
          }
        }
      } catch { /* 元数据拿不到就用默认，无需告警 */ }
    }
  }
  return v => { if (v !== undefined) contentChars = v; return contentChars; };
}

// 底层通用调用：新闻研判（analyze）与文档模式分块/合并（minutes）共用。
// 内容长度控制由调用方负责；返回裸文本（含 ``` 围栏已剥），失败/预算尽/已熔断返回 null。
// json=true 请求 response_format（provider 不支持时自动去参重试），false 直接自然语言输出。
export async function chat(system, user, budgetMs = 90000, { json = true } = {}) {
  if (!available()) return null;
  const deadline = Date.now() + budgetMs;
  const { model, anthropic, endpoint, headers } = resolveEndpoint();
  let useJsonMode = json; // provider 不支持 response_format 时自动去掉重试（GLM 等兼容性垫片）
  for (let attempt = 0; attempt < 3; attempt++) {
    const left = deadline - Date.now();
    if (left < 5000) return null; // 预算耗尽，剩余调用不再发起
    try {
      const payload = anthropic
        ? { model, max_tokens: 4096, temperature: 0.2, system,
            messages: [{ role: 'user', content: user }] }
        : { model, temperature: 0.2,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}) };
      const res = await fetch(endpoint, {
        method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(Math.min(90000, left)),
      });
      if (res.status === 200) {
        streak429 = 0; // 成功清零限流连击
        const j = await res.json();
        // Anthropic 响应体在 content[].text；OpenAI 在 choices[0].message.content
        const text = anthropic
          ? (j.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
          : j.choices?.[0]?.message?.content ?? '';
        if (!text) {
          // 网关把错误包在 200 里（智谱：{"code":500,"msg":"404 NOT_FOUND"}，多为模型名/端点不匹配）。
          // 带错误字段的按配置类错误熔断整轮（重试无意义）；纯粹空响应则走重试。
          const ecode = String(j.code ?? j.error?.code ?? '');
          const emsg = String(j.msg ?? j.error?.message ?? '').slice(0, 160);
          if (ecode || emsg) return trip(res.status, ecode, emsg);
          throw new Error('empty content');
        }
        // 容忍 ```json 围栏（json mode 关闭/Anthropic 端点时模型可能加围栏）
        return String(text).trim()
          .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      }
      // 记状态码 + 服务商错误码/消息（错误体不含密钥；截断防日志膨胀，非 JSON 体静默跳过）
      // Anthropic 错误体 {type:'error',error:{type,message}} 无 code 字段，用 type 顶替
      let ecode = '', emsg = '';
      try {
        const e = (await res.json())?.error ?? {};
        ecode = String(e.code ?? e.type ?? ''); emsg = String(e.message ?? '').slice(0, 160);
      } catch { /* 非 JSON 体 */ }
      console.log(`[llm] http ${res.status}${ecode ? ` code ${ecode}` : ''}${emsg ? ` ${emsg}` : ''}`);
      if (res.status === 400) {
        // 上下文超限：上抛给调用方处理（analyze 减半窗口；minutes 分块尺寸 bug 时会显性暴露）
        if (/context|上下文|too long|超长|过长|token limit/i.test(emsg)) throw new ContextOverflow(emsg);
        if (!anthropic && useJsonMode) { useJsonMode = false; continue; } // response_format 不被支持，去掉重试
      }
      // 熔断判定：欠费(1113，智谱两家端点都可能在 message 里带码)/鉴权(401/402/403) 即停；其余 429 连续 6 次停
      if ([401, 402, 403].includes(res.status) || ecode === '1113' || emsg.includes('1113')) return trip(res.status, ecode, emsg);
      if (res.status === 429 && ++streak429 >= 6) return trip(res.status, ecode, emsg);
    } catch (ex) {
      if (ex instanceof ContextOverflow) throw ex; // 信号不上报为普通错误
      console.log(`[llm] error ${String(ex).slice(0, 80)}`);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 3000)); // 最后一次失败不再空等
  }
  return null;
}

// 新闻条目研判。budgetMs：本条的剩余研判预算（总预算由 main 计算，< workflow 超时，
// 防 LLM 超时重试拖垮整轮）。预算耗尽返回 null，条目降级为规则模式直通输出。
export async function analyze(item, budgetMs = 90000) {
  if (!available()) return null;
  const { base, model, anthropic, headers } = resolveEndpoint();
  const chars = await resolveContentChars(base, anthropic, model, headers);
  for (;;) {
    const userContent = `来源: ${item.source}\n标题: ${item.title}\n内容: ${item.content.slice(0, chars())}`;
    try {
      const raw = await chat(SYSTEM_PROMPT, userContent, budgetMs);
      return raw == null ? null : JSON.parse(raw);
    } catch (ex) {
      // 上下文超限：内容窗口减半后重试，学到的新窗口对本轮后续条目持续生效
      if (ex instanceof ContextOverflow && chars() > 1000) {
        chars(Math.max(1000, Math.floor(chars() / 2)));
        console.log(`[llm] ${item.item_id} 上下文超限，内容窗口减半 → ${chars()} 字符`);
        continue;
      }
      return null; // 其余错误 chat 层已记录
    }
  }
}
