const $ = (id) => document.getElementById(id);

const els = {
  home: $('home'), read: $('read'),
  form: $('form'), words: $('words'), theme: $('theme'), go: $('go'), goLabel: $('go-label'),
  chips: $('chips'), counter: $('counter'), hint: $('hint'),
  status: $('status'), statusText: $('status-text'), statusSub: $('status-sub'),
  homeError: $('home-error'), spinner: $('spinner'), useName: $('use-name'), useSwitch: $('use-switch'),
  histList: $('hist-list'), histEmpty: $('hist-empty'), histClear: $('hist-clear'),
  back: $('back'), topTitle: $('r-top-title'),
  title: $('r-title'), titleZh: $('r-title-zh'), meta: $('r-meta'), readWords: $('r-words'),
  body: $('r-body'), count: $('r-count'), again: $('again'),
  pop: $('pop'), gear: $('gear'), rgear: $('r-gear'),
  modal: $('modal'), providers: $('providers'), apiKey: $('apiKey'), model: $('model'),
  keyState: $('key-state'), keyUrl: $('key-url'), keyClear: $('key-clear'),
  save: $('save'), cancel: $('cancel'),
};

let MAX_WORDS = 50;
let timer = null;
let mode = 'split';          // split / en / zh / gloss —— 四种视图都来自同一份 PARAS
let PARAS = [];              // [{en, zh}]
let DICT = {};               // '3' -> {i, word, zh}
let counts = {};             // 每个 key 在文中出现次数
let CURRENT = null;          // {id, words, theme, data}

// ---------- 历史记录（只存本机 localStorage） ----------
const HKEY = 'vocab-reader-history-v1';
let HIST = [];

function loadHist() {
  try { HIST = JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch (e) { HIST = []; }
  if (!Array.isArray(HIST)) HIST = [];
}
function saveHist() {
  try { localStorage.setItem(HKEY, JSON.stringify(HIST.slice(0, 30))); } catch (e) { /* 满了就不管 */ }
}
function pushHist(entry) {
  const i = HIST.findIndex((h) => h.id === entry.id);
  if (i >= 0) HIST[i] = entry; else HIST.unshift(entry);
  HIST = HIST.slice(0, 30);
  saveHist();
  renderHist();
}
function dropHist(id) {
  HIST = HIST.filter((h) => h.id !== id);
  saveHist();
  renderHist();
  if (CURRENT && CURRENT.id === id) goHome();
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60e3) return '刚刚';
  if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前';
  const t = new Date(ts), n = new Date();
  const sameDay = t.toDateString() === n.toDateString();
  if (sameDay) return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  return `${t.getMonth() + 1}月${t.getDate()}日`;
}

function renderHist() {
  const has = HIST.length > 0;
  els.histEmpty.classList.toggle('hidden', has);
  els.histClear.classList.toggle('hidden', !has);
  els.histList.innerHTML = HIST.map((h) => {
    const w = (h.words || []).slice(0, 4).map((x) => escapeHtml(x)).join('、');
    const more = (h.words || []).length > 4 ? ` 等 ${h.words.length} 个` : '';
    return `<div class="hrow" data-id="${h.id}" role="button" tabindex="0">
      <div class="hrow-main">
        <b class="hrow-title">${escapeHtml(h.title || '未命名')}</b>
        <span class="hrow-sub">${w}${more}</span>
        <span class="hrow-time">${h.theme ? escapeHtml(h.theme) + ' · ' : ''}${timeAgo(h.ts)}</span>
      </div>
      <button class="hrow-del" data-del="${h.id}" title="删除" aria-label="删除">×</button>
    </div>`;
  }).join('');
}

els.histList.addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) { e.stopPropagation(); dropHist(del.dataset.del); return; }
  const row = e.target.closest('.hrow');
  if (!row) return;
  const h = HIST.find((x) => x.id === row.dataset.id);
  if (h) openResult(h.data, { id: h.id, words: h.words, theme: h.theme }, false);
});
els.histList.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.hrow');
  if (!row) return;
  e.preventDefault();
  const h = HIST.find((x) => x.id === row.dataset.id);
  if (h) openResult(h.data, { id: h.id, words: h.words, theme: h.theme }, false);
});
els.histClear.addEventListener('click', () => {
  if (!HIST.length) return;
  if (!confirm('清空全部历史记录？此操作只影响本机存档。')) return;
  HIST = []; CURRENT = null; saveHist(); renderHist();
});

// ---------- 视图切换（hash 路由，浏览器返回键也能用） ----------
function showView(name) {
  const isRead = name === 'read';
  els.home.classList.toggle('hidden', isRead);
  els.read.classList.toggle('hidden', !isRead);
  if (!isRead) { closePop(); clearActive(); }
  window.scrollTo(0, 0);
}
function goRead() { location.hash = '#/read'; showView('read'); }
function goHome() { location.hash = '#/'; showView('home'); }
window.addEventListener('hashchange', () => {
  if (location.hash === '#/read' && CURRENT) showView('read');
  else showView('home');
});
els.back.addEventListener('click', goHome);

// ---------- 输入 ----------
function parseWords(raw) {
  return String(raw || '')
    .split(/[,，;；、\/|\n]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

function autoGrow() {
  els.words.style.height = 'auto';
  els.words.style.height = Math.min(els.words.scrollHeight, 260) + 'px';
}

els.words.addEventListener('input', () => { autoGrow(); updateInputState(); });
els.words.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); els.form.requestSubmit(); }
});

function updateInputState() {
  const words = parseWords(els.words.value);
  const over = words.length > MAX_WORDS;
  els.counter.textContent = `${words.length} / ${MAX_WORDS}`;
  els.counter.className = 'counter' + (over ? ' over' : words.length ? ' ok' : '');
  els.hint.className = 'hint' + (over ? ' over' : '');
  els.hint.textContent = over
    ? `已超出 ${words.length - MAX_WORDS} 个，删掉多余的词才能生成`
    : words.length ? '按 Enter 也能生成' : '最多 50 个；词越多，文章越长';
  els.go.disabled = over || words.length === 0;
  els.chips.innerHTML = words
    .map((w, i) => `<span class="chip${i >= MAX_WORDS ? ' over' : ''}">${escapeHtml(w)}</span>`)
    .join('');
}

// ---------- 工具 ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function resolveKey(key) {                       // key 可以是序号，也可以是词本身
  const k = String(key).trim();
  if (/^\d+$/.test(k)) return DICT[k] || null;
  return Object.values(DICT).find((d) => d.word.toLowerCase() === k.toLowerCase()) || null;
}

// ---------- [[key|form]] → 可点击的 span ----------
function tokenize(text, isZh) {
  const re = /\[\[([^\[\]|]+)(?:\|([^\]]*))?\]\]/g;
  let out = '', last = 0, m;
  while ((m = re.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, m.index));
    const entry = resolveKey(m[1]);
    let form = m[2] !== undefined ? m[2] : m[1];
    if (isZh) form = String(form).replace(/[\x00-\x7F]/g, '') || (entry && entry.zh) || '';
    if (entry) out += `<span class="w${isZh ? ' zh' : ''}" data-k="${entry.i}">${escapeHtml(form)}</span>`;
    else out += escapeHtml(form);
    last = m.index + m[0].length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

// ---------- 兜底：模型没写标记时按词形 / 词条自己染 ----------
function variantsOf(word) {
  const w = word.trim().toLowerCase();
  if (!w) return [];
  if (/\s/.test(w)) return [w];
  const out = new Set([w]);
  const add = (v) => v && v.length > 2 && out.add(v);
  if (/(s|x|z|ch|sh|o)$/.test(w)) add(w + 'es');
  if (/([^aeiou])y$/.test(w)) {
    const stem = w.slice(0, -1);
    add(stem + 'ies'); add(stem + 'ied'); add(stem + 'ying');
  }
  const base = /e$/.test(w) ? w.slice(0, -1) : w;
  add(base + 's'); add(base + 'ed'); add(base + 'ing'); add(base + 'd'); add(base + 'ly');
  return [...out];
}

function fallback(text, terms, isZh) {
  const list = [...new Set(terms.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!list.length) return escapeHtml(text);
  const re = isZh
    ? new RegExp('(' + list.map(escapeRe).join('|') + ')', 'g')
    : new RegExp('(?<![A-Za-z])(' + list.map(escapeRe).join('|') + ')(?![A-Za-z])', 'gi');
  const byLower = new Map();
  Object.values(DICT).forEach((d) => {
    const k = String(isZh ? d.zh : d.word).toLowerCase();
    if (k) byLower.set(k, d);
  });
  let out = '', last = 0, m;
  while ((m = re.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, m.index));
    const entry = byLower.get(String(m[0]).toLowerCase());
    if (entry) out += `<span class="w${isZh ? ' zh' : ''}" data-k="${entry.i}">${escapeHtml(m[0])}</span>`;
    else out += escapeHtml(m[0]);
    last = m.index + m[0].length;
    if (m[0].length === 0) re.lastIndex++;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

function paraEn(p) {
  return /\[\[/.test(p.en)
    ? tokenize(p.en, false)
    : fallback(p.en, Object.values(DICT).flatMap((d) => variantsOf(d.word)), false);
}
function paraZh(p) {
  return /\[\[/.test(p.zh)
    ? tokenize(p.zh, true)
    : fallback(p.zh, Object.values(DICT).map((d) => d.zh), true);
}

// ---------- 四种视图都来自同一份 PARAS ----------
function render() {
  document.querySelectorAll('#modes .mode').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  let html = '';

  if (mode === 'gloss') {
    html = '<div class="gloss">' + Object.values(DICT).map((d) => {
      const n = counts[String(d.i)] || 0;
      return `<button class="grow" data-k="${d.i}" type="button"><b>${escapeHtml(d.word)}</b>` +
        `<span>${escapeHtml(d.zh || '—')}</span><i>${n ? '文中 ' + n + ' 处' : '未出现'}</i></button>`;
    }).join('') + '</div>';
  } else if (mode === 'en') {
    html = '<div class="prose">' + PARAS.map((p) => `<p class="en">${paraEn(p)}</p>`).join('') + '</div>';
  } else if (mode === 'zh') {
    html = '<div class="prose">' + PARAS.map((p) => `<p class="zhline">${paraZh(p)}</p>`).join('') + '</div>';
  } else {
    html = PARAS.map((p, i) =>
      `<div class="prow" data-row="${i}">
         <div class="col col-en"><p class="en">${paraEn(p)}</p></div>
         <div class="col col-zh"><p class="zhline">${paraZh(p)}</p></div>
       </div>`
    ).join('');
  }

  els.body.innerHTML = html;
}

function computeCounts() {
  counts = {};
  let total = 0;
  PARAS.forEach((p) => {
    const re = /\[\[([^\[\]|]+)(?:\|[^\]]*)?\]\]/g;
    let m;
    while ((m = re.exec(String(p.en))) !== null) {
      const entry = resolveKey(m[1]);
      if (entry) { counts[String(entry.i)] = (counts[String(entry.i)] || 0) + 1; total += 1; }
    }
  });
  if (!total) {
    const plain = PARAS.map((p) => p.en).join(' ');
    Object.values(DICT).forEach((d) => {
      const re = new RegExp('(?<![A-Za-z])(' + variantsOf(d.word).map(escapeRe).join('|') + ')(?![A-Za-z])', 'gi');
      const n = (plain.match(re) || []).length;
      if (n) counts[String(d.i)] = n;
    });
  }
}

// ---------- 点词查词 ----------
function showPop(entry, anchor) {
  if (!entry) return;
  const n = counts[String(entry.i)] || 0;
  els.pop.innerHTML =
    `<b>${escapeHtml(entry.word)}</b>` +
    (entry.zh ? `<span class="pz">${escapeHtml(entry.zh)}</span>` : '') +
    `<i>${n ? '文中 ' + n + ' 处 · 两侧已同时点亮' : '文中未出现'}</i>`;
  els.pop.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const pr = els.pop.getBoundingClientRect();
  let left = r.left + window.scrollX;
  left = Math.max(10, Math.min(left, window.scrollX + document.documentElement.clientWidth - pr.width - 14));
  let top = r.bottom + window.scrollY + 8;
  if (r.bottom + pr.height + 20 > window.innerHeight) top = r.top + window.scrollY - pr.height - 8;
  els.pop.style.left = left + 'px';
  els.pop.style.top = top + 'px';
}
function closePop() { els.pop.classList.add('hidden'); }
function clearActive() { els.body.querySelectorAll('.w.act, .prow.lit').forEach((el) => el.classList.remove('act', 'lit')); }
function setMode(next) { mode = next; closePop(); clearActive(); render(); }

document.addEventListener('click', function (e) {
  const row = e.target.closest('.grow');
  if (row) {                                   // 词表行 → 回对照视图并点亮全文
    if (mode !== 'split') setMode('split');
    const k = row.dataset.k;
    clearActive();
    els.body.querySelectorAll(`.w[data-k="${k}"]`).forEach((el) => {
      el.classList.add('act');
      const prow = el.closest('.prow');
      if (prow) prow.classList.add('lit');
    });
    const first = els.body.querySelector(`.w[data-k="${k}"]`);
    if (first) { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); showPop(DICT[k], first); }
    return;
  }

  const w = e.target.closest('.w');
  if (w) {                                     // 点词 → 查词 + 左右两侧一起亮
    const key = w.dataset.k;
    if (w.classList.contains('act')) { clearActive(); closePop(); return; }
    clearActive();
    els.body.querySelectorAll(`.w[data-k="${key}"]`).forEach((el) => {
      el.classList.add('act');
      const prow = el.closest('.prow');
      if (prow) prow.classList.add('lit');
    });
    showPop(DICT[key], w);
    return;
  }

  if (!e.target.closest('#pop')) { clearActive(); closePop(); }
});

document.querySelectorAll('#modes .mode').forEach((b) => {
  b.addEventListener('click', () => setMode(b.dataset.mode));
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!els.pop.classList.contains('hidden')) { closePop(); clearActive(); return; }
    if (!els.modal.classList.contains('hidden')) { closeSettings(); return; }
    if (location.hash === '#/read') goHome();
  }
});

window.addEventListener('scroll', closePop, { passive: true });

// ---------- 加载状态 ----------
function startLoading(n) {
  els.status.classList.remove('hidden');
  els.homeError.classList.add('hidden');
  els.go.disabled = true;
  els.goLabel.textContent = '生成中';
  els.spinner.classList.remove('hidden');
  const t0 = Date.now();
  const tick = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    els.statusText.textContent = `正在写文章… ${s}s`;
    els.statusSub.textContent = `${n} 个词，通常十几秒到一分钟`;
  };
  tick();
  clearInterval(timer);
  timer = setInterval(tick, 1000);
}
function stopLoading() {
  clearInterval(timer);
  els.status.classList.add('hidden');
  els.spinner.classList.add('hidden');
  els.goLabel.textContent = '生成';
  els.go.disabled = false;
  updateInputState();
}
function showError(msg) {
  stopLoading();
  els.homeError.textContent = msg;
  els.homeError.classList.remove('hidden');
}

// ---------- 结果 ----------
function openResult(data, meta, save) {
  CURRENT = { id: meta.id, words: meta.words, theme: meta.theme, data };

  els.title.textContent = data.title || 'Untitled';
  els.titleZh.textContent = data.titleZh || '';
  els.topTitle.textContent = data.title || '短文';

  const miss = (data.coverage || []).filter((c) => !c.hit);
  const okCount = (data.coverage || []).length - miss.length;
  els.meta.innerHTML = miss.length
    ? `命中 <b>${okCount}/${data.coverage.length}</b> 个词 · 这次没出现的：<span class="bad">${escapeHtml(miss.map((c) => c.word).join('、'))}</span>`
    : `全部 <b class="good">${data.coverage.length}</b> 个词都出现了 · 点词可查意思`;

  els.readWords.innerHTML = (meta.words || [])
    .map((w) => `<span class="rw${miss.some((c) => c.word === w) ? ' miss' : ''}">${escapeHtml(w)}</span>`)
    .join('');

  DICT = {};
  (data.dict || []).forEach((d) => { DICT[String(d.i)] = d; });
  PARAS = data.paras || [];
  computeCounts();
  setMode(mode);

  els.count.textContent =
    `${data.wordCount} 词 · 经过 ${data.attempts} 轮校订` +
    (miss.length ? '（仍有漏词，可减少词数或换一篇）' : '');

  if (save !== false) {
    pushHist({
      id: meta.id,
      ts: Date.now(),
      title: data.title,
      theme: meta.theme,
      words: meta.words,
      data,
    });
  }
  goRead();
}

async function generate(opts) {
  const o = opts || {};
  const words = o.words || parseWords(els.words.value);
  const theme = o.theme !== undefined ? o.theme : els.theme.value.trim();
  if (!words.length) { els.words.focus(); return; }
  if (words.length > MAX_WORDS) { showError(`最多 ${MAX_WORDS} 个词，现在 ${words.length} 个。`); return; }

  startLoading(words.length);
  closePop();
  try {
    const resp = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ words: words.join(','), theme }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      if (data.error === 'NO_KEY') { stopLoading(); openSettings(); return; }
      throw new Error(data.message || '生成失败');
    }
    stopLoading();
    openResult(data, { id: o.id || 'g-' + Date.now(), words, theme }, true);
  } catch (e) {
    showError(e.message || '生成失败，检查一下网络或 API Key。');
  }
}

els.form.addEventListener('submit', (e) => { e.preventDefault(); generate(); });
els.again.addEventListener('click', () => {
  if (!CURRENT) return;
  generate({ words: CURRENT.words, theme: CURRENT.theme, id: 'g-' + Date.now() });
});

// ---------- 设置：多家供应商，各自存 Key 与模型 ----------
let CFG = null;               // /api/config 的返回
let curProvider = 'qwen';

function renderProviders() {
  els.providers.innerHTML = (CFG.providers || [])
    .map((p) => `<button class="prov${p.id === curProvider ? ' on' : ''}" data-p="${p.id}" type="button">` +
      `${escapeHtml(p.short)}${p.configured ? '<i class="dot"></i>' : ''}</button>`)
    .join('');
}

function syncProviderForm() {
  const p = (CFG.providers || []).find((x) => x.id === curProvider);
  if (!p) return;
  els.apiKey.value = p.configured ? p.keyMasked : '';
  els.apiKey.placeholder = p.keyHint || 'sk-xxxxxxxxxxxxxxxx';
  els.keyUrl.href = p.keyUrl || '#';
  els.keyState.textContent = p.configured ? `已保存：${p.keyMasked}` : '还没填 Key';
  els.keyState.className = p.configured ? 'ok' : '';
  els.keyClear.classList.toggle('hidden', !p.configured);
  els.model.innerHTML = p.models
    .map((m) => `<option value="${m}"${m === p.model ? ' selected' : ''}>${m}</option>`)
    .join('');
  renderProviders();
}

async function loadConfig() {
  CFG = await (await fetch('/api/config')).json();
  MAX_WORDS = CFG.maxWords || 50;
  if (CFG.provider && (CFG.providers || []).some((p) => p.id === CFG.provider)) curProvider = CFG.provider;
  syncProviderForm();
  syncUseNote();
  updateInputState();
  return CFG;
}

function syncUseNote() {
  const act = (CFG.providers || []).find((p) => p.id === CFG.provider);
  if (!act) return;
  els.useName.textContent = act.configured
    ? `${act.name} · ${act.model}`
    : `${act.name} · 未填 Key`;
}

function openSettings() { els.modal.classList.remove('hidden'); els.apiKey.focus(); }
function closeSettings() { els.modal.classList.add('hidden'); }
els.gear.addEventListener('click', openSettings);
els.rgear.addEventListener('click', openSettings);
els.useSwitch.addEventListener('click', openSettings);
els.cancel.addEventListener('click', closeSettings);
els.modal.addEventListener('click', (e) => { if (e.target === els.modal) closeSettings(); });

els.providers.addEventListener('click', (e) => {
  const b = e.target.closest('.prov');
  if (!b) return;
  curProvider = b.dataset.p;
  syncProviderForm();
});

els.keyClear.addEventListener('click', async () => {
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: curProvider, clear: true }),
  });
  await loadConfig();
});

els.save.addEventListener('click', async () => {
  await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: curProvider, apiKey: els.apiKey.value.trim(), model: els.model.value }),
  });
  await loadConfig();                     // 重新拉一次，拿新的脱敏串
  closeSettings();
  if (parseWords(els.words.value).length) generate();
});

// ---------- 启动 ----------
(async function init() {
  loadHist();
  renderHist();
  updateInputState();
  autoGrow();
  if (location.hash === '#/read' && !CURRENT) location.hash = '#/';
  showView(location.hash === '#/read' ? 'read' : 'home');
  try {
    const cfg = await loadConfig();
    if (!cfg.configured) openSettings();
  } catch (e) { /* ignore */ }
})();
