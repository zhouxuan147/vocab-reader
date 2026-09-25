// 生词阅读器 · 本地服务端（零依赖，仅用 Node 内置模块）
// 1) 提供静态页面  2) 代理调用大模型（千问 / DeepSeek）  3) 本地保存各家 API Key
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const PORT = Number(process.env.PORT || 5173);
const REQUEST_TIMEOUT = 120000; // 50 词的长文可能要一两分钟，给足
const MAX_WORDS = 50;           // 输入上限
const MAX_ATTEMPTS = 5;         // 生词没凑齐时的重试上限（重写 + 补写）

// ---------- 供应商：都是 OpenAI 兼容接口，各自存 Key 与模型 ----------
const PROVIDERS = {
  qwen: {
    id: 'qwen',
    name: '阿里云百炼 · 千问',
    short: '千问',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-flash'],
    defaultModel: 'qwen-plus',
    keyHint: 'sk-xxxxxxxxxxxxxxxx',
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    jsonMode: true,
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    short: 'DeepSeek',
    url: 'https://api.deepseek.com/chat/completions',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    keyHint: 'sk-xxxxxxxxxxxxxxxx',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    jsonMode: true,
    // 推理模型（reasoner）对 JSON 模式支持不稳，只在普通模型上开
    jsonModeOffModels: ['deepseek-reasoner'],
  },
};

const DEFAULT_CONFIG = {
  provider: 'qwen',
  qwen: { apiKey: '', model: PROVIDERS.qwen.defaultModel },
  deepseek: { apiKey: '', model: PROVIDERS.deepseek.defaultModel },
  autoOpen: true,
};

// ---------- 配置读写（只存在本机，不上传任何地方） ----------
function readConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    saved = {};
  }
  const cfg = { ...DEFAULT_CONFIG, ...saved };

  // 兼容旧格式：顶层 apiKey / model 迁到千问下
  if (!cfg.qwen || typeof cfg.qwen !== 'object') cfg.qwen = { ...DEFAULT_CONFIG.qwen };
  if (typeof saved.apiKey === 'string' && !cfg.qwen.apiKey) cfg.qwen.apiKey = saved.apiKey;
  if (typeof saved.model === 'string' && PROVIDERS.qwen.models.includes(saved.model)) cfg.qwen.model = saved.model;
  if (!cfg.deepseek || typeof cfg.deepseek !== 'object') cfg.deepseek = { ...DEFAULT_CONFIG.deepseek };
  if (!PROVIDERS[cfg.provider]) cfg.provider = 'qwen';
  return cfg;
}

function writeConfig(patch) {
  const next = { ...readConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// 当前启用的供应商配置
function activeConfig(cfg) {
  const cfgNow = cfg || readConfig();
  const p = PROVIDERS[cfgNow.provider] || PROVIDERS.qwen;
  const own = cfgNow[p.id] || {};
  return {
    id: p.id,
    name: p.name,
    short: p.short,
    url: p.url,
    models: p.models,
    apiKey: String(own.apiKey || '').trim(),
    model: p.models.includes(own.model) ? own.model : p.defaultModel,
    jsonMode: p.jsonMode && !(p.jsonModeOffModels || []).includes(own.model),
  };
}

function maskKey(key) {
  const k = String(key || '');
  return k.length <= 10 ? k : `${k.slice(0, 6)}…${k.slice(-4)}`;
}

// ---------- 小工具 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------- 生词变形匹配（用于校验与兜底高亮） ----------
function wordVariants(word) {
  const w = String(word || '').trim().toLowerCase();
  if (!w) return [];
  if (/\s/.test(w)) return [w]; // 短语：只按原文匹配
  const out = new Set([w]);
  const add = (v) => v && v.length > 2 && out.add(v);
  if (/(s|x|z|ch|sh|o)$/.test(w)) add(w + 'es');
  if (/([^aeiou])y$/.test(w)) {
    const stem = w.slice(0, -1);
    add(stem + 'ies');
    add(stem + 'ied');
    add(stem + 'ying');
  }
  const base = /e$/.test(w) ? w.slice(0, -1) : w;
  add(base + 's');
  add(base + 'ed');
  add(base + 'ing');
  add(base + 'd');
  add(base + 'ly');
  return [...out];
}

function findCoverage(text, words) {
  const hay = ' ' + String(text).toLowerCase().replace(/\s+/g, ' ') + ' ';
  return words.map((w) => {
    const hit = wordVariants(w).some((v) => {
      if (/\s/.test(v)) return hay.includes(' ' + v + ' ');
      const re = new RegExp('[^a-z]' + escapeRegExp(v) + '[^a-z]', 'i');
      return re.test(hay);
    });
    return { word: w, hit };
  });
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------- 长度规划：词越多，文章越长，否则塞不下还不通顺 ----------
function targetLength(n) {
  if (n <= 10) return [200, 300];
  const min = Math.min(200 + (n - 10) * 22, 620);
  return [min, min + Math.min(120, Math.max(60, Math.round(n * 2)))];
}

// ---------- 千问调用 ----------
function buildMessages(words, theme, retryHint) {
  const [minLen, maxLen] = targetLength(words.length);
  const list = words.map((w, i) => `${i + 1}. ${w}`).join('\n');
  const system = [
    'You are an experienced English teacher writing graded reading passages for Chinese adult learners.',
    'You write natural, idiomatic, flowing English — never a list of disconnected sentences.',
    'You also translate your own writing into smooth, natural Chinese (忠实且通顺，不逐字直译).',
    'You always reply with valid JSON only: no markdown fences, no commentary outside the JSON.',
  ].join(' ');

  const user = [
    `Task: write ONE coherent English reading passage, then translate it faithfully into Chinese.`,
    ``,
    `TARGET WORDS (there are exactly ${words.length}; every single one MUST appear in the English passage):`,
    list,
    ``,
    `Requirements:`,
    `1. LENGTH: about ${minLen}-${maxLen} English words. With ${words.length} target words you need enough room to use them all naturally.`,
    `2. Every numbered target word must appear at least once. Keep its meaning; natural inflections are fine (plural, tense, -ing, -ed). Do NOT swap a target word for a synonym.`,
    `3. MARKING (critical): in the English passage write every occurrence of a target word as [[number|surface form]].`,
    `   Example: if word 3 is "orbit" and your sentence says "orbited", write [[3|orbited]]; if it says "orbit", write [[3|orbit]].`,
    `4. Structure: ${Math.max(2, Math.min(6, Math.ceil(words.length / 8)))} short paragraphs of continuous prose. One clear storyline or one clear argument that develops from beginning to end — logically connected, no random sentences glued together.`,
    `   Theme / scenario hint: ${theme || 'choose any everyday, relatable situation that fits the words naturally'}.`,
    `5. Level: upper-intermediate but readable. Common sentence patterns, no rare idioms, no invented proper nouns. No bullet points, no subheadings, no word list appended. Do NOT use ** bold anywhere.`,
    `6. TRANSLATION: translate the whole passage into natural, idiomatic Chinese (忠实且通顺，不逐字直译). Keep the same paragraph breaks as the English.`,
    `7. MARKING THE TRANSLATION: write every occurrence of a target word's Chinese rendering as [[number|中文]]. Use the same number as the target word.`,
    `   Example: word 3 "orbit" rendered as "轨道" must be written [[3|轨道]]. Only Chinese characters go after the pipe, never English.`,
    `8. GLOSSARY: one entry per target word, each with ONE concise Chinese meaning (usually 2-4 characters, no part-of-speech label), and it MUST be the same Chinese phrase you actually used in the translation.`,
    `9. Before outputting, go through the ${words.length} numbered target words one by one and confirm each really appears in your passage; fix any that do not.`,
    retryHint ? `10. IMPORTANT: your previous draft missed these words — they MUST appear this time: ${retryHint}. Write a fresh version; changing the story is fine.` : '',
    ``,
    `Output JSON exactly in this shape:`,
    `{"title": "...", "title_zh": "...", "passage": "...", "translation": "...", "glossary": [{"word": "...", "zh": "..."}]}`,
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function extractJson(content) {
  let text = String(content || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  try {
    return JSON.parse(text);
  } catch (e) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (e2) {
        /* ignore */
      }
    }
    return null;
  }
}

async function requestOnce(p, messages, temperature, useJsonMode) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  try {
    const resp = await fetch(p.url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${p.apiKey}`,
      },
      body: JSON.stringify({
        model: p.model,
        messages,
        temperature: typeof temperature === 'number' ? temperature : 0.8,
        ...(useJsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = data.error?.message || data.message || `HTTP ${resp.status}`;
      const err = new Error(msg);
      err.status = resp.status;
      throw err;
    }
    const content = data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('模型没有返回内容');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// 各家都是 OpenAI 兼容接口；JSON 模式不被支持时自动退回普通模式
async function callLLM(p, messages, temperature) {
  if (!p.apiKey) throw new Error(`还没填 ${p.name} 的 API Key`);
  try {
    return await requestOnce(p, messages, temperature, p.jsonMode);
  } catch (e) {
    const unsupported = e.status === 400 && /response_format|json_object|json mode/i.test(e.message || '');
    if (unsupported) {
      console.log(`  [${p.short}] 不支持 JSON 模式，退回普通模式重试`);
      return await requestOnce(p, messages, temperature, false);
    }
    throw e;
  }
}

// ---------- 解析 [[key|form]] 标记：key = 目标词序号（也接受词本身），form = 文中实际形态 ----------
const MARK_RE = /\[\[([^\[\]|]+)(?:\|([^\]]*))?\]\]/g;

function keyToIndex(key, words) {
  const k = String(key || '').trim();
  if (/^\d+$/.test(k)) {
    const i = Number(k) - 1;
    return i >= 0 && i < words.length ? i : -1;
  }
  const lower = k.toLowerCase();
  return words.findIndex((w) => w.toLowerCase() === lower);
}

// 打平标记得到纯文本：[[3|orbited]] → orbited
function plainEnglish(marked, words) {
  return String(marked || '')
    .replace(MARK_RE, (_, key, form) => {
      const i = keyToIndex(key, words);
      let surface = form !== undefined && form !== '' ? String(form) : i >= 0 ? words[i] : String(key);
      surface = surface.replace(/[一-鿿]/g, '').trim(); // 模型偶尔把中文塞进英文侧
      return surface || (i >= 0 ? words[i] : String(key));
    })
    .replace(/\*\*/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// 打平中文：[[3|轨道]] → 轨道；[[immense|巨大]] 这类也只留汉字部分
function plainChinese(marked, words, dict) {
  return String(marked || '')
    .replace(MARK_RE, (_, key, form) => {
      const i = keyToIndex(key, words);
      let zh = String(form !== undefined ? form : key).replace(/[\x00-\x7F]/g, '');
      if (!zh && i >= 0 && dict && dict[i] && dict[i].zh) zh = dict[i].zh;
      return zh;
    })
    .replace(/\*\*/g, '')
    .trim();
}

function splitSentences(text, isZh) {
  const re = isZh ? /(?<=[。！？；])/g : /(?<=[.!?])\s+/g;
  return String(text).split(re).map((s) => s.trim()).filter(Boolean);
}

function chunkEven(arr, n, isZh) {
  n = Math.max(1, Math.min(n, arr.length));
  const base = Math.floor(arr.length / n);
  let extra = arr.length % n;
  const out = [];
  let i = 0;
  for (let k = 0; k < n; k++) {
    const take = base + (extra-- > 0 ? 1 : 0);
    out.push(arr.slice(i, i + take).join(isZh ? '' : ' '));
    i += take;
  }
  return out;
}

// 左右两栏要逐段对齐：模型给的段落对不上时，退回按句子切成等份
function splitParas(en, zh) {
  const norm = (t) => String(t || '').replace(/\r\n/g, '\n').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  let A = norm(en);
  let B = norm(zh);

  if (A.length !== B.length || A.length < 2) {
    const ea = splitSentences(String(en || '').replace(/\n+/g, ' ').trim(), false);
    const eb = splitSentences(String(zh || '').replace(/\n+/g, '').trim(), true);
    const n = Math.min(ea.length, eb.length);
    if (n >= 2) {
      const groups = Math.max(2, Math.min(8, Math.ceil(n / 2.5)));
      A = chunkEven(ea, groups, false);
      B = chunkEven(eb, groups, true);
    }
  }

  const n = Math.max(A.length, B.length, 1);
  const out = [];
  for (let i = 0; i < n; i++) out.push({ en: A[i] || '', zh: B[i] || '' });
  return out;
}

function buildDict(parsed, words) {
  const map = new Map();
  (Array.isArray(parsed?.glossary) ? parsed.glossary : []).forEach((g) => {
    if (g && g.word) map.set(String(g.word).toLowerCase().trim(), String(g.zh || '').replace(/\[\[|\]\]/g, '').trim());
  });
  return words.map((w, i) => ({ i: i + 1, word: w, zh: map.get(w.toLowerCase()) || '' }));
}

function countMarks(paras) {
  let n = 0;
  paras.forEach((p) => {
    n += (String(p.en).match(MARK_RE) || []).length;
    n += (String(p.zh).match(MARK_RE) || []).length;
  });
  return n;
}

// 模型偶尔「用了词却忘了打标记」→ 服务端按词形补上，保证每个目标词在文中都是可点的 token
function ensureMarks(paras, dict, words) {
  const inEn = new Set();
  const inZh = new Set();
  paras.forEach((p) => {
    String(p.en).replace(MARK_RE, (_, key) => { inEn.add(String(keyToIndex(key, words))); });
    String(p.zh).replace(MARK_RE, (_, key) => { inZh.add(String(keyToIndex(key, words))); });
  });

  dict.forEach((d) => {
    const i = d.i - 1;
    if (i < 0 || i >= words.length) return;

    if (!inEn.has(String(i))) {
      const re = new RegExp('(?<![A-Za-z])(' + wordVariants(words[i]).map(escapeRegExp).join('|') + ')(?![A-Za-z])', 'gi');
      paras.forEach((p) => {
        p.en = String(p.en)
          .split(/(\[\[[^\[\]]*\]\])/g)
          .map((seg, k) => (k % 2 ? seg : seg.replace(re, `[[${d.i}|$1]]`)))
          .join('');
      });
    }

    if (d.zh && !inZh.has(String(i))) {
      const reZ = new RegExp('(' + escapeRegExp(d.zh) + ')', 'g');
      paras.forEach((p) => {
        p.zh = String(p.zh)
          .split(/(\[\[[^\[\]]*\]\])/g)
          .map((seg, k) => (k % 2 ? seg : seg.replace(reZ, `[[${d.i}|$1]]`)))
          .join('');
      });
    }
  });
  return paras;
}

// 由 paras/dict 反推完整结果：纯文本、词数、覆盖率都在这里统一算
function finalize(paras, dict, words, meta) {
  ensureMarks(paras, dict, words);
  const passage = paras.map((p) => plainEnglish(p.en, words)).filter(Boolean).join('\n\n');
  const translation = paras.map((p) => plainChinese(p.zh, words, dict)).filter(Boolean).join('\n\n');
  return {
    title: String(meta.title || '').replace(/\[\[|\]\]/g, '').trim() || 'Untitled',
    titleZh: String(meta.titleZh || '').replace(/\[\[|\]\]/g, '').trim(),
    words,
    paras,
    dict,
    passage,
    translation,
    wordCount: passage.split(/\s+/).filter(Boolean).length,
    coverage: findCoverage(passage, words),
  };
}

function normalizeResult(parsed, words) {
  const dict = buildDict(parsed, words);
  const paras = splitParas(parsed.passage, parsed.translation);
  return finalize(paras, dict, words, {
    title: parsed.title,
    titleZh: parsed.title_zh,
  });
}

async function generateOnce(words, theme, cfg, retryHint) {
  // 词越多越要"听话"，温度调低
  const temp = words.length > 35 ? 0.4 : words.length > 25 ? 0.5 : words.length > 12 ? 0.65 : 0.8;
  const content = await callLLM(cfg, buildMessages(words, theme, retryHint), temp);
  const parsed = extractJson(content);
  if (!parsed || !parsed.passage) throw new Error('模型返回格式异常，请再点一次生成');
  return normalizeResult(parsed, words);
}

function score(r) {
  const hits = r.coverage.filter((c) => c.hit).length;
  const gloss = r.dict.filter((g) => g.zh).length;
  return hits * 1000 + Math.min(countMarks(r.paras), 500) + gloss;
}

// ------- 兜底还不够时用「确定性补写」：只写几句嵌进去，由服务端拼装，确保目标词真的进文章 -------
async function generateInsert(words, theme, cfg, current, missing) {
  const system = [
    'You are an experienced English teacher. You reply with valid JSON only, no markdown fences.',
  ].join(' ');
  const user = [
    `Below is an English reading passage and its Chinese translation.`,
    ``,
    `Below are the target words that still have to appear (number → word):`,
    missing.map((w) => `${words.indexOf(w) + 1} → ${w}`).join('\n'),
    ``,
    `PASSAGE:`,
    `<<<${current.passage}>>>`,
    ``,
    `TRANSLATION:`,
    `<<<${current.translation}>>>`,
    ``,
    `Write 1-2 English sentences that naturally continue the END of this passage and use each missing word exactly once (keep the given spelling; inflection is fine).`,
    `Match the tone, tense and characters of the passage; the sentences must read as a natural closing, not as filler.`,
    `Also give the Chinese translation of those same sentences, and the Chinese meaning of each inserted word.`,
    `Marking: every occurrence of a target word must be written as [[number|surface form]] in English and [[number|中文]] in Chinese, e.g. [[${words.indexOf(missing[0]) + 1}|${missing[0]}]].`,
    ``,
    `Output JSON exactly: {"sentences": "...", "sentences_zh": "...", "glossary": [{"word": "...", "zh": "..."}]}`,
  ].join('\n');

  const content = await callLLM(
    cfg,
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    0.4
  );
  const parsed = extractJson(content);
  const sentences = String(parsed?.sentences || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  if (!sentences) return null;
  const sentencesZh = String(parsed?.sentences_zh || '').replace(/\*\*/g, '').trim();

  const glossMap = new Map();
  (Array.isArray(parsed?.glossary) ? parsed.glossary : []).forEach((g) => {
    if (g && g.word) glossMap.set(String(g.word).toLowerCase(), String(g.zh || '').replace(/\[\[|\]\]/g, '').trim());
  });

  // 保留标记，追加到最后一个英/中段落，再统一 finalize 重算覆盖率
  const paras = JSON.parse(JSON.stringify(current.paras));
  paras[paras.length - 1].en = `${paras[paras.length - 1].en.trim()} ${sentences}`;
  paras[paras.length - 1].zh = `${paras[paras.length - 1].zh.trim()}${sentencesZh}`;

  const dict = current.dict.map((d) =>
    glossMap.has(d.word.toLowerCase()) ? { ...d, zh: glossMap.get(d.word.toLowerCase()) } : d
  );

  return finalize(paras, dict, words, { title: current.title, titleZh: current.titleZh });
}

// 生成 → 校验 → 没凑齐就重写，最多 MAX_ATTEMPTS 次，取覆盖最好的一版
async function generate(words, theme, cfg) {
  let best = await generateOnce(words, theme, cfg, '');
  let attempts = 1;

  while (attempts < MAX_ATTEMPTS) {
    const missing = best.coverage.filter((c) => !c.hit).map((c) => c.word);
    if (!missing.length) break;
    attempts += 1;
    let next;
    if (missing.length > 3) {
      // 漏得多：整篇重写更合理，硬塞句子会把文章写散
      next = await generateOnce(
        words, theme, cfg,
        `Your previous draft missed these target words: ${missing.map((w) => `"${w}"`).join(', ')}. They MUST all appear this time.`
      );
    } else {
      // 漏得少：写几句收尾嵌进原文，服务端拼装，必然生效
      next = (await generateInsert(words, theme, cfg, best, missing)) || best;
    }
    if (score(next) > score(best)) best = next;
  }

  return { ...best, attempts, requested: words.length };
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/api/config' && req.method === 'GET') {
      const cfg = readConfig();
      const act = activeConfig(cfg);
      return sendJson(res, 200, {
        provider: act.id,
        configured: Boolean(act.apiKey),
        model: act.model,
        models: act.models,
        maxWords: MAX_WORDS,
        providers: Object.values(PROVIDERS).map((p) => {
          const own = cfg[p.id] || {};
          return {
            id: p.id,
            name: p.name,
            short: p.short,
            models: p.models,
            model: p.models.includes(own.model) ? own.model : p.defaultModel,
            configured: Boolean(String(own.apiKey || '').trim()),
            keyMasked: maskKey(own.apiKey),
            keyHint: p.keyHint,
            keyUrl: p.keyUrl,
          };
        }),
      });
    }

    if (url.pathname === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = readConfig();
      const pid = PROVIDERS[body.provider] ? body.provider : cfg.provider;
      const own = { ...(cfg[pid] || {}) };

      if (body.clear === true) {
        own.apiKey = '';
      } else if (typeof body.apiKey === 'string' && body.apiKey.trim() && body.apiKey !== maskKey(own.apiKey)) {
        // 只在真的填了新 Key 时覆盖（留空或保持脱敏串 = 不改动）
        own.apiKey = body.apiKey.trim();
      }
      if (typeof body.model === 'string' && PROVIDERS[pid].models.includes(body.model)) {
        own.model = body.model;
      }
      if (!own.model) own.model = PROVIDERS[pid].defaultModel;

      const next = writeConfig({ provider: pid, [pid]: own });
      const act = activeConfig(next);
      return sendJson(res, 200, {
        ok: true,
        provider: act.id,
        configured: Boolean(act.apiKey),
        model: act.model,
        models: act.models,
      });
    }

    if (url.pathname === '/api/generate' && req.method === 'POST') {
      const body = await readBody(req);
      const cfg = activeConfig();
      if (!cfg.apiKey) {
        return sendJson(res, 400, {
          error: 'NO_KEY',
          message: `还没填 ${cfg.name} 的 API Key，点右上角齿轮填一下。`,
        });
      }
      console.log(`  [${cfg.short}] ${cfg.model} · ${String(body.words || '').split(/[,，;；\n、\/|]+/).filter(Boolean).length} 个词`);
      const raw = String(body.words || '')
        .split(/[,，;；\n、\/|]+/)
        .map((w) => w.trim())
        .filter(Boolean);
      if (!raw.length) {
        return sendJson(res, 400, { error: 'NO_WORDS', message: '先输入今天学的单词。' });
      }
      if (raw.length > MAX_WORDS) {
        return sendJson(res, 400, {
          error: 'TOO_MANY',
          message: `这次有 ${raw.length} 个词，最多 ${MAX_WORDS} 个——词太多文章会散，建议分两批读。`,
        });
      }
      const words = raw;
      const theme = String(body.theme || '').trim().slice(0, 60);
      const result = await generate(words, theme, cfg);
      return sendJson(res, 200, result);
    }

    // 静态文件
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    });
  } catch (err) {
    const msg = err.name === 'AbortError' ? '请求超时，再点一次生成试试。' : err.message || '服务端出错了';
    sendJson(res, 500, { error: 'SERVER', message: msg });
  }
});

// 首次运行（比如刚 clone 下来）时，从示例文件生成一份空的 config.json
function ensureConfigFile() {
  if (fs.existsSync(CONFIG_PATH)) return;
  const example = path.join(ROOT, 'config.example.json');
  try {
    fs.copyFileSync(example, CONFIG_PATH);
    console.log('  已生成 config.json（Key 为空，到页面右上角齿轮里填）');
  } catch (e) { /* 没示例文件也没关系，页面里填完会自己存 */ }
}

server.listen(PORT, () => {
  ensureConfigFile();
  console.log('');
  console.log('  生词阅读器已启动');
  console.log(`  在浏览器打开： http://localhost:${PORT}`);
  console.log('  停止服务：在这个窗口按 Ctrl + C');
  console.log('');
  if (readConfig().autoOpen && process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}`], { stdio: 'ignore', detached: true }).unref();
  }
});
