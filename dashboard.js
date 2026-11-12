/* global Engine, pushAll */
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
let cfg;
let filter = 'all';
const fresh = new Set();
const MAX_LOG = 400;
const SYM = { CNY: '¥', GBP: '£', USD: '$', EUR: '€', AUD: 'A$', CAD: 'C$', HKD: 'HK$', JPY: 'JP¥' };

// ---------- 日志 ----------
function log(msg, cls = '') {
  const row = el('div', 'l ' + cls);
  const t = el('time', null, new Date().toLocaleTimeString('zh-CN', { hour12: false }));
  row.append(t, el('span', null, msg));
  const box = $('#log');
  box.prepend(row);
  while (box.childElementCount > MAX_LOG) box.lastChild.remove();
  $('#logLast').textContent = msg;
  renderStats();
}

const engine = new Engine(log, async (m) => {
  const { matches = [] } = await chrome.storage.local.get('matches');
  matches.unshift(m);
  fresh.add(m.id);
  await chrome.storage.local.set({ matches: matches.slice(0, 300) });
  renderMatches();
});

// ---------- 命中墙 ----------
function kindOf(m) { return m.free ? 'free' : m.unknown ? 'unknown' : 'price'; }

function sticker(m) {
  const k = kindOf(m);
  if (k === 'free') return el('div', 'sticker free', '免费送');
  if (k === 'unknown') return el('div', 'sticker unknown', '价格未知');
  const s = el('div', 'sticker');
  if (m.price) {
    s.append(el('span', 'cur', SYM[m.price.currency] || m.price.currency + ' '), document.createTextNode(m.price.value.toLocaleString('en-US')));
  } else {
    s.textContent = m.priceText; // 旧记录
  }
  return s;
}

function ago(ts) {
  if (!ts) return '';
  const d = (Date.now() - ts) / 60000;
  if (d < 60) return `${Math.max(1, Math.round(d))} 分钟前`;
  if (d < 1440) return `${Math.round(d / 60)} 小时前`;
  if (d < 1440 * 30) return `${Math.round(d / 1440)} 天前`;
  return new Date(ts).toLocaleDateString('zh-CN');
}

function tagCard(m) {
  const a = el('a', `tag is-${kindOf(m)}` + (fresh.has(m.id) ? ' fresh' : ''));
  a.href = m.url; a.target = '_blank'; a.rel = 'noopener';
  const top = el('div', 'tag-top');
  top.append(el('span', null, m.task || ''));
  const img = el('img', 'tag-img');
  img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; img.alt = ''; img.src = m.cover || '';
  img.onerror = () => { img.removeAttribute('src'); };
  const body = el('div', 'tag-body');
  body.append(sticker(m));
  if (m.price && (m.price.currency !== m.price.budgetCurrency || m.price.ocr || m.price.fromComment)) {
    const parts = [];
    if (m.price.currency !== m.price.budgetCurrency && m.price.budget != null) parts.push(`约 ${SYM[m.price.budgetCurrency] || ''}${m.price.budget.toLocaleString('en-US')}`);
    if (m.price.ocr) parts.push('价格来自图片');
    if (m.price.fromComment) parts.push('价格来自楼主评论');
    body.append(el('div', 'conv', parts.join('，')));
  }
  body.append(el('div', 'tag-title', m.title || (m.desc || '').slice(0, 60) || '（无标题）'));
  const meta = el('div', 'tag-meta');
  if (m.ip) meta.append(el('span', null, m.ip));
  meta.append(el('span', null, ago(m.time || m.foundAt)));
  if (m.collected) meta.append(el('span', 'saved', m.board ? `已收藏到「${m.board}」` : '已收藏'));
  body.append(meta);
  a.append(top, img, body);
  a.title = [m.title, m.author && `卖家：${m.author}`].filter(Boolean).join('\n');
  return a;
}

function emptyState(all) {
  const box = el('div', 'empty');
  box.innerHTML = `<svg viewBox="0 0 120 96" aria-hidden="true"><path d="M8 14h70l34 34-34 34H8z" fill="none" stroke="var(--line)" stroke-width="3" stroke-dasharray="7 6" stroke-linejoin="round"/><circle cx="26" cy="32" r="6" fill="none" stroke="var(--line)" stroke-width="3"/></svg>`;
  const txt = el('div');
  if (all) {
    txt.append(el('p', null, '还没捡到东西'));
    const p = el('p', 'sub');
    p.innerHTML = '第一次用：先在这个浏览器里 <a href="https://www.xiaohongshu.com" target="_blank">登录小红书</a>（建议用小号），在右边写好要盯的东西，再点「开始监控」。符合预算的帖子会挂到这里，同时推送给你。';
    txt.append(p, el('p', 'sub', '监控期间这个标签页要一直开着。'));
  } else {
    txt.append(el('p', null, '这一类暂时没有'), el('p', 'sub', '换个筛选看看。'));
  }
  box.append(txt);
  return box;
}

async function renderMatches() {
  const { matches = [] } = await chrome.storage.local.get('matches');
  const list = filter === 'all' ? matches : matches.filter((m) => kindOf(m) === filter);
  $('#hitCount').textContent = matches.length || '';
  const wall = $('#matches');
  wall.replaceChildren(...(list.length ? list.map(tagCard) : [emptyState(!matches.length)]));
  fresh.clear();
}

document.querySelectorAll('.filter button').forEach((b) => {
  b.onclick = () => {
    filter = b.dataset.f;
    document.querySelectorAll('.filter button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderMatches();
  };
});
$('#btnClear').onclick = async () => { if (confirm('清空捡到的列表？已收藏的帖子不受影响。')) { await chrome.storage.local.set({ matches: [] }); renderMatches(); } };
$('#btnResetSeen').onclick = async () => { await chrome.storage.local.set({ seen: {} }); log('已重置已读记录，下一轮会重新检查所有帖子'); };

// ---------- 任务 ----------
function taskSummary(t) {
  const parts = [];
  parts.push(t.queries.length ? t.queries.slice(0, 2).join('、') + (t.queries.length > 2 ? ` 等 ${t.queries.length} 个词` : '') : '还没填搜索词');
  const sym = SYM[cfg.budgetCurrency] || '';
  parts.push(t.max > 0 ? (t.min ? `${sym}${t.min}–${t.max}` : `${sym}${t.max} 以内`) : (t.includeFree ? '只要免费的' : '没设预算'));
  if (t.regions.length) parts.push(t.regions[0]);
  return parts.join('，');
}

function renderTasks() {
  const box = $('#tasks');
  box.replaceChildren();
  if (!cfg.tasks.length) box.append(el('p', 'task-sum', '还没有任务。点「新增」写下想捡的东西。'));
  cfg.tasks.forEach((t, i) => {
    const node = $('#taskTpl').content.firstElementChild.cloneNode(true);
    const name = node.querySelector('.task-name');
    const sum = node.querySelector('.task-sum');
    const refresh = () => { name.textContent = t.name || '未命名'; sum.textContent = taskSummary(t); node.classList.toggle('off', !t.enabled); };
    node.querySelectorAll('[data-k]').forEach((inp) => {
      const k = inp.dataset.k;
      if (inp.type === 'checkbox') inp.checked = !!t[k];
      else if ('list' in inp.dataset) inp.value = (t[k] || []).join(', ');
      else inp.value = t[k] ?? '';
      inp.addEventListener('input', () => {
        if (inp.type === 'checkbox') t[k] = inp.checked;
        else if ('list' in inp.dataset) t[k] = inp.value.split(/[,，、;；\n]/).map((s) => s.trim()).filter(Boolean);
        else if (inp.type === 'number') t[k] = Number(inp.value) || 0;
        else t[k] = inp.value;
        refresh(); dirty();
      });
    });
    node.querySelector('.switch').addEventListener('click', (e) => e.stopPropagation());
    node.querySelector('.del').onclick = () => { if (confirm(`删除「${t.name}」？`)) { cfg.tasks.splice(i, 1); renderTasks(); dirty(); } };
    refresh();
    box.append(node);
  });
}

$('#btnAddTask').onclick = () => {
  cfg.tasks.push({ id: 't' + Date.now(), enabled: true, name: '新任务', queries: [], regions: [], min: 0, max: 500, requireSecondhand: true, includeFree: true, mustInclude: [], exclude: [] });
  renderTasks();
  const last = $('#tasks').lastElementChild;
  last.open = true;
  last.querySelector('input[data-k="name"]').select();
  dirty();
};

// ---------- 设置 ----------
const SETTINGS = [
  ['concurrency', '同时搜索的线程数', 'number', '1–5，每个线程一个后台标签页。越多越快，但同一账号也越容易被要求验证，建议 2–3'],
  ['intervalMin', '每轮间隔（分钟）', 'number', '一轮搜完所有词后歇多久。太频繁容易触发验证码，建议 5 以上'],
  ['maxDetailPerQuery', '每个词每轮最多看几帖', 'number'],
  ['scrollPages', '搜索结果往下翻几屏', 'number'],
  ['maxAgeDays', '只看最近几天的帖子', 'number', '填 0 表示不限'],
  ['budgetCurrency', '预算用什么币', 'cur'],
  ['unmarkedCurrency', '没写币种的数字按', 'cur', '在英国大家常只写“450”，可选 GBP'],
  ['dollarMeans', '“$”和“刀”指', 'cur'],
  ['fx', '汇率', 'json', '1 单位外币 = 多少人民币，格式 GBP=9.2 USD=7.2'],
  ['soldWords', '没货关键词', 'list', '标题、正文、评论、图片里出现就跳过；“已出了吗？”这类问句不算'],
  ['irrelevantWords', '不相干帖子的标题词', 'list', '标题里有这些词就不点进去看（提问、测评、避雷之类）。问句标题且看不出在卖东西的也会排除'],
  ['excludeWords', '全局排除词', 'list'],
  ['secondhandWords', '判断“像二手帖”的词', 'list'],
  ['sortLatest', '优先看最新发布的', 'bool'],
  ['readComments', '读评论区，检查是否已出', 'bool'],
  ['ocr', '识别图片上的价格', 'bool'],
  ['ocrAlways', '正文有价格也识别图片', 'bool'],
  ['ocrMaxImages', '每帖最多识别几张图', 'number'],
  ['autoCollect', '捡到后自动收藏到小红书', 'bool'],
  ['collectBoard', '收藏到哪个专辑', 'text', '填专辑名，要先在小红书里建好；留空就放默认收藏。每个任务也能单独指定'],
];
const PUSH = [
  ['desktopNotify', '捡到东西时弹 Windows 系统通知（需要人工验证时总会弹）', 'bool'],
  ['ntfyTopic', 'ntfy 主题名', 'text', '手机装 ntfy 订阅同名主题，海外最好用；名字取复杂一点'],
  ['barkUrl', 'Bark 地址（iPhone）', 'text', '形如 https://api.day.app/你的key'],
  ['tgToken', 'Telegram Bot Token', 'text'],
  ['tgChat', 'Telegram Chat ID', 'text'],
  ['serverChanKey', 'Server酱 SendKey（推到微信）', 'text'],
];
const CURS = ['CNY', 'GBP', 'USD', 'EUR', 'AUD', 'CAD', 'HKD', 'JPY'];

function field(obj, [k, label, type, help]) {
  const wrap = el('label', type === 'bool' ? 'chk' : '');
  let inp;
  if (type === 'bool') { inp = el('input'); inp.type = 'checkbox'; inp.checked = !!obj[k]; }
  else if (type === 'cur') { inp = el('select'); inp.innerHTML = CURS.map((c) => `<option value="${c}">${SYM[c]} ${c}</option>`).join(''); inp.value = obj[k]; }
  else if (type === 'json') { inp = el('input'); inp.value = Object.entries(obj[k]).filter(([a]) => a !== 'CNY').map(([a, b]) => `${a}=${b}`).join(' '); }
  else { inp = el('input'); inp.type = type === 'number' ? 'number' : 'text'; inp.value = type === 'list' ? obj[k].join(', ') : obj[k]; }
  inp.addEventListener('input', () => {
    if (type === 'bool') obj[k] = inp.checked;
    else if (type === 'number') obj[k] = Number(inp.value) || 0;
    else if (type === 'list') obj[k] = inp.value.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    else if (type === 'json') { const o = { CNY: 1 }; inp.value.split(/\s+/).forEach((p) => { const [a, b] = p.split('='); if (a && +b) o[a.toUpperCase()] = +b; }); obj[k] = o; }
    else obj[k] = inp.value.trim();
    if (k === 'budgetCurrency') renderTasks();
    dirty();
  });
  if (type === 'bool') wrap.append(inp, label);
  else { wrap.append(label); if (help) wrap.append(el('small', null, help)); wrap.append(inp); }
  return wrap;
}
function renderSettings() {
  $('#settings').replaceChildren(...SETTINGS.map((s) => field(cfg, s)));
  $('#push').replaceChildren(...PUSH.map((s) => field(cfg.push, s)));
}

function dirty() {
  $('.savebar').classList.add('dirty');
  $('#btnSave').disabled = false;
  $('#saveMsg').textContent = '有改动没保存';
}
async function save() {
  await Engine.saveCfg(cfg);
  $('.savebar').classList.remove('dirty');
  $('#btnSave').disabled = true;
  $('#saveMsg').textContent = engine.running ? '已保存，下一轮生效' : '已保存';
}
$('#btnSave').onclick = save;
$('#btnTestPush').onclick = async () => {
  await save();
  const errs = await pushAll(cfg, '捡漏雷达测试', '能看到这条，说明推送配好了', 'https://www.xiaohongshu.com/');
  log(errs.length ? '测试推送有失败的：' + errs.join('；') : '测试推送已发出，去手机上看看', errs.length ? 'warn' : 'ok');
};

// ---------- 运行 ----------
function renderStats() {
  const s = engine.stats;
  $('#stRounds').textContent = s.rounds;
  $('#stScanned').textContent = s.scanned;
  $('#stMatched').textContent = s.matched;
  const st = $('#state');
  st.className = 'state' + (engine.paused ? ' paused' : engine.running ? ' on' : '');
  $('#statusText').textContent = engine.paused ? '等你完成验证' : engine.running ? (s.threads > 1 ? `监控中，${s.threads} 个线程` : '监控中') : '未运行';
  $('#btnStart').hidden = engine.running;
  $('#btnStop').hidden = !engine.running;
  document.title = engine.running ? `捡漏雷达（监控中）` : '捡漏雷达';
}
$('#btnStart').onclick = async () => {
  await save();
  engine.start().catch((e) => { log('出错停止：' + e.message, 'err'); engine.stop(); }).finally(renderStats);
  renderStats();
};
$('#btnStop').onclick = () => { engine.stop(); renderStats(); renderThreads(); };
window.addEventListener('beforeunload', (e) => { if (engine.running) { e.preventDefault(); e.returnValue = ''; } });
setInterval(() => { if (!document.hidden) renderMatches(); }, 60000); // 刷新“几分钟前”

// ---------- 线程面板：每个线程在搜什么 ----------
const PHASE = {
  search: () => '搜索中',
  open: (s) => `看第 ${s.i}/${s.n} 帖`,
  ocr: (s) => `识别图片价格 ${s.i}/${s.n}`,
  rest: () => '歇一会',
  idle: () => '本轮做完了',
  blocked: () => '等你完成验证',
  held: () => '暂停中',
};
function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${String(s % 60).padStart(2, '0')}`;
}
function renderThreads() {
  const box = $('#threads');
  box.hidden = !engine.running;
  if (!engine.running) return;
  const r = engine.round;
  const info = $('#roundInfo');
  if (r && r.nextAt && r.nextAt > Date.now()) info.innerHTML = `本轮 <b>${r.total}</b> 个词都搜完了，下一轮 <b>${Math.ceil((r.nextAt - Date.now()) / 60000)}</b> 分钟后`;
  else if (r) info.innerHTML = `本轮已搜完 <b>${r.done}</b>/<b>${r.total}</b> 个词`;
  else info.textContent = '';

  const rows = engine.workers.map((w) => {
    const s = w.state || { phase: 'rest' };
    const li = el('li', `th is-${s.phase}`);
    li.append(el('span', 'th-no', String(w.idx)));
    li.append(el('span', 'th-phase', (PHASE[s.phase] || (() => s.phase))(s)));
    const q = el('span', 'th-q');
    if (s.q) { q.append(document.createTextNode(`${s.phase === 'rest' ? '刚搜完' : ''}「${s.q}」`)); if (s.task) q.append(el('small', null, s.task)); }
    li.append(q);
    const t = el('span', 'th-title', s.phase === 'open' || s.phase === 'ocr' ? s.title || '' : s.phase === 'blocked' ? '去这个线程的小红书标签页里完成验证' : '');
    t.title = t.textContent;
    li.append(t, el('span', 'th-time', s.since ? dur(Date.now() - s.since) : ''));
    return li;
  });
  $('#threadList').replaceChildren(...rows);
}
setInterval(() => { if (!document.hidden) renderThreads(); }, 1000);

(async () => {
  cfg = await Engine.loadCfg();
  // 记下控制台自己的标签页：关掉控制台时，后台脚本会把小红书标签页一起关掉
  chrome.tabs.getCurrent((t) => { if (t) chrome.storage.local.set({ dashTab: t.id }); });
  const left = await engine.closeAllTabs();
  renderTasks(); renderSettings(); renderMatches(); renderStats();
  if (left) log(`关掉了上次留下的 ${left} 个小红书标签页`, 'dim');
  log('就绪。在右边写好要盯的东西，然后点「开始监控」');
})();
