// 搜索引擎：在几个后台标签页里并行打开小红书搜索页 → 读结果 → 逐个打开新帖子读正文/IP属地/图片 → OCR → 判断 → 推送
/* global extractPrices, convert, detectFree, detectSold, parseRelTime, detectIrrelevant, bestPrices, detectSale, Tesseract */

const XHS = 'https://www.xiaohongshu.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

const DEFAULT_CFG = {
  intervalMin: 6,          // 每轮之间等待(分钟)，实际会 ±30% 随机
  detailDelay: [4, 9],     // 打开每个帖子之间等待(秒)
  maxDetailPerQuery: 12,   // 每个搜索词每轮最多点开几个新帖子
  scrollPages: 2,          // 搜索页往下滚几屏
  maxAgeDays: 7,           // 只看最近 N 天的帖子（0 = 不限）
  sortLatest: true,        // 尝试切换到“最新”排序
  ocr: true,
  ocrAlways: false,        // false：正文已识别到价格就不 OCR
  ocrMaxImages: 3,
  budgetCurrency: 'CNY',
  unmarkedCurrency: 'CNY', // 没写币种的数字按什么算（在英国可改 GBP）
  dollarMeans: 'USD',      // “$/刀”指什么（澳洲改 AUD，加拿大改 CAD）
  fx: { CNY: 1, GBP: 9.2, USD: 7.2, EUR: 7.8, AUD: 4.7, CAD: 5.2, HKD: 0.92, JPY: 0.048 },
  autoCollect: true,       // 命中的帖子自动点“收藏”（价格未知的不收藏）
  collectBoard: '',        // 收藏到哪个专辑（要先在小红书里建好）；留空 = 默认收藏。任务里可以单独指定
  // 标题/正文/评论/图片里出现这些词 = 没货了，不推送不收藏（另有内置的 已售/卖掉了/on hold/reserved 等）
  soldWords: ['已出', 'hold', 'sold'],
  readComments: true,
  // 标题里有这些词 = 不是在卖东西（提问/测评/避雷等），搜索卡片上就排除，不点进去。标题是问句也会排除
  irrelevantWords: ['靠谱吗', '求推荐', '推荐一下', '值得买吗', '值不值', '能买吗', '怎么选', '选哪个', '哪个好', '求助', '请问', '求问', '避雷', '被骗', '骗子', '防骗', '测评', '评测', '攻略', '教程', '开箱', '对比', '种草', '晒单', '体验'],
  concurrency: 2,          // 同时开几个后台标签页搜索（1-5）。越多越快，但同一账号越容易触发验证码
  push: { desktopNotify: false, ntfyTopic: '', barkUrl: '', tgToken: '', tgChat: '', serverChanKey: '' },
  // 额外的“在卖东西”信号词（内置已认 出售/闲置/二手/自提/包邮/可刀/💰 以及 “墨尔本出”“出一台” 这类用法）
  secondhandWords: ['成新', '成色', '回国', '搬家', '毕业', '诚心出', '急出'],
  excludeWords: ['求购', '收一', '收个', '求收', '回收', '高价收', '租房', '招聘', '代购', '批发', '全新未拆 现货', '店铺'],
  tasks: [
    { id: 't1', enabled: true, name: '二手电脑', queries: ['二手电脑', '出 笔记本电脑'], regions: [], min: 0, max: 3000, requireSecondhand: true, includeFree: true, mustInclude: ['电脑', '笔记本', '游戏本', '主机', '台式', 'MacBook', 'ThinkPad', 'laptop'], exclude: [] },
    { id: 't2', enabled: false, name: '免费送（填你的城市）', queries: ['伦敦 免费送', '伦敦 回国 送'], regions: ['伦敦', 'London', '英国'], min: 0, max: 0, requireSecondhand: false, includeFree: true, mustInclude: [], exclude: [] },
  ],
};

class Engine {
  constructor(log, onMatch) {
    this.log = log;
    this.onMatch = onMatch;
    this.running = false;
    this.paused = false;        // 任一标签页遇到验证码时，所有线程一起暂停
    this.workers = [];          // [{ idx, tabId }]
    this.seen = null;           // 内存里的已读表，定时写回 storage（多线程不会互相覆盖）
    this.claimed = new Set();   // 本轮正在被某个线程处理的帖子，防止两个标签页点开同一帖
    this.tabIds = new Set();    // 本程序开过的所有后台标签页
    this.gen = 0;               // 每次开始/停止 +1，旧线程据此知道自己该退出了
    this.ocrWorker = null;
    this.ocrInit = null;
    this.stats = { rounds: 0, scanned: 0, matched: 0, threads: 0 };
  }

  // ---------- 存储 ----------
  static async loadCfg() {
    const { cfg } = await chrome.storage.local.get('cfg');
    return deepMerge(structuredClone(DEFAULT_CFG), cfg || {});
  }
  static async saveCfg(cfg) { await chrome.storage.local.set({ cfg }); }
  async loadSeen() {
    const { seen = {} } = await chrome.storage.local.get('seen');
    const cut = Date.now() - 30 * 864e5;
    for (const k in seen) if (seen[k] < cut) delete seen[k];
    this.seen = seen;
  }
  isSeen(id) { return !!this.seen[id] || this.claimed.has(id); }
  markSeen(id) {
    this.seen[id] = Date.now();
    this.claimed.delete(id);
    clearTimeout(this.seenTimer);
    this.seenTimer = setTimeout(() => chrome.storage.local.set({ seen: this.seen }), 1500);
  }

  // ---------- 标签页（每个线程一个） ----------
  // 线程是否还该干活：停止/重新开始后，旧线程的 gen 对不上，就不再开新标签页
  alive(w) { return this.running && (!w || w.gen === this.gen); }
  async ensureTab(w) {
    if (!this.alive(w)) throw new Error('已停止');
    if (w.tabId != null) {
      try { await chrome.tabs.get(w.tabId); return w.tabId; } catch { w.tabId = null; }
    }
    const t = await chrome.tabs.create({ url: 'about:blank', active: false, pinned: true });
    if (!this.alive(w)) { chrome.tabs.remove(t.id).catch(() => {}); throw new Error('已停止'); }
    w.tabId = t.id;
    this.tabIds.add(t.id);
    chrome.storage.local.set({ workerTabs: [...this.tabIds] }); // 记下来，控制台被刷新后也能找回来关掉
    return t.id;
  }
  // 关掉这个程序开过的所有后台标签页（包括控制台刷新前留下的）
  async closeAllTabs() {
    const { workerTabs = [] } = await chrome.storage.local.get('workerTabs');
    const ids = new Set([...workerTabs, ...this.tabIds]);
    for (const w of this.workers) { if (w.tabId != null) ids.add(w.tabId); w.tabId = null; }
    this.tabIds.clear();
    await chrome.storage.local.set({ workerTabs: [] });
    await Promise.all([...ids].map((id) => chrome.tabs.remove(id).catch(() => {})));
    return ids.size;
  }
  async load(w, url) {
    while (this.paused && this.alive(w)) await sleep(2000);
    const id = await this.ensureTab(w);
    await chrome.tabs.update(id, { url });
    await new Promise((resolve) => {
      const done = () => { chrome.tabs.onUpdated.removeListener(fn); clearTimeout(to); resolve(); };
      const fn = (tid, info) => { if (tid === id && info.status === 'complete') done(); };
      const to = setTimeout(done, 25000);
      chrome.tabs.onUpdated.addListener(fn);
    });
    await sleep(rand(2500, 4000)); // 等 SPA 渲染
    return id;
  }
  async exec(w, func, args = []) {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: w.tabId }, world: 'MAIN', func, args });
    return r && r.result;
  }

  // 登录 / 验证码：所有线程暂停，提醒用户手动处理
  async checkBlocked(w) {
    const tab = await chrome.tabs.get(w.tabId);
    const blocked = /captcha|website-login|verify|login/i.test(tab.url || '') || (await this.exec(w, pageBlockedProbe));
    if (!blocked) return false;
    const prev = w.state;
    if (this.paused) { // 别的线程已经在等了
      this.setState(w, { phase: 'held', q: prev?.q, task: prev?.task });
      while (this.paused && this.running) await sleep(2000);
      w.state = prev;
      return true;
    }
    this.paused = true;
    this.setState(w, { phase: 'blocked', q: prev?.q, task: prev?.task });
    try { return await this.waitUnblocked(w); } finally { this.paused = false; w.state = prev; }
  }
  async waitUnblocked(w) {
    this.log('需要登录或人工验证：已切到小红书标签页，请手动完成，完成后所有线程自动继续', 'warn');
    await chrome.tabs.update(w.tabId, { active: true });
    await pushAll(await Engine.loadCfg(), '小红书需要人工验证', '请到浏览器里登录 / 完成验证，程序已暂停', XHS, { forceDesktop: true });
    while (this.running) {
      await sleep(10000);
      const t = await chrome.tabs.get(w.tabId).catch(() => null);
      if (!t) return true;
      const still = /captcha|website-login|verify/i.test(t.url || '') || (await this.exec(w, pageBlockedProbe).catch(() => true));
      if (!still) { this.log('验证完成，继续'); return true; }
    }
    return true;
  }

  // ---------- 主循环 ----------
  async start() {
    if (this.running) return;
    this.running = true;
    const gen = ++this.gen;
    this.workers = [];
    const leftover = await this.closeAllTabs(); // 上次没关掉的
    if (leftover) this.log(`关掉了上次留下的 ${leftover} 个标签页`, 'dim');
    await this.loadSeen();
    this.log('开始监控');
    while (this.running && gen === this.gen) {
      const cfg = await Engine.loadCfg();
      const jobs = [];
      for (const task of cfg.tasks.filter((t) => t.enabled)) for (const q of task.queries) jobs.push({ q, task });
      if (!jobs.length) { this.log('没有启用的任务，或任务里没填搜索词', 'warn'); this.stop(); break; }

      const n = Math.max(1, Math.min(5, cfg.concurrency || 1, jobs.length));
      while (this.workers.length < n) this.workers.push({ idx: this.workers.length + 1, tabId: null, gen });
      for (const w of this.workers.splice(n)) if (w.tabId != null) chrome.tabs.remove(w.tabId).catch(() => {});
      this.stats.threads = n;
      const t0 = Date.now();
      this.log(`第 ${this.stats.rounds + 1} 轮：${jobs.length} 个搜索词，${n} 个线程同时搜`);

      // 每个线程从共享队列里领搜索词，错开几秒启动
      const queue = jobs.slice();
      this.round = { total: jobs.length, started: 0, done: 0, nextAt: 0 };
      await Promise.all(this.workers.map(async (w, i) => {
        this.setState(w, { phase: 'rest' });
        await sleep(i * rand(2000, 5000));
        while (this.alive(w) && queue.length) {
          const { q, task } = queue.shift();
          this.round.started++;
          try { await this.runQuery(w, q, task, cfg); } catch (e) { if (this.alive(w)) this.log(`${this.tagOf(w)}搜索「${q}」出错：${e.message}`, 'err'); }
          this.round.done++;
          if (queue.length && this.alive(w)) { this.setState(w, { phase: 'rest', q, task: task.name }); await sleep(rand(5000, 12000)); }
        }
        this.setState(w, { phase: 'idle' });
      }));
      if (!this.running || gen !== this.gen) break;

      this.stats.rounds++;
      const wait = cfg.intervalMin * 60000 * rand(0.7, 1.3);
      // 一轮做完先把后台标签页全关掉，下一轮再开新的
      await this.closeAllTabs();
      this.log(`第 ${this.stats.rounds} 轮完成，用时 ${Math.round((Date.now() - t0) / 60000)} 分钟，${Math.round(wait / 60000)} 分钟后下一轮（后台标签页已关闭）`);
      const end = Date.now() + wait;
      this.round.nextAt = end;
      while (this.running && gen === this.gen && Date.now() < end) await sleep(1000);
    }
  }
  stop() {
    this.running = false;
    this.paused = false;
    this.gen++; // 让还在跑的旧线程全部退出、不再开新标签页
    this.log('已停止，后台标签页已全部关闭');
    this.closeAllTabs();
    this.workers = [];
    this.claimed.clear();
    if (this.seen) chrome.storage.local.set({ seen: this.seen });
  }
  tagOf(w) { return this.workers.length > 1 ? `[线程${w.idx}] ` : ''; }
  // 每个线程现在在干什么，控制台每秒读一次
  // phase: search 搜索中 | open 看帖子 | ocr 识别图片 | rest 歇一会 | idle 本轮做完 | blocked 等验证 | held 被别的线程的验证挡住
  setState(w, s) { w.state = { ...s, since: Date.now() }; }

  async runQuery(w, q, task, cfg) {
    const tg = this.tagOf(w);
    this.setState(w, { phase: 'search', q, task: task.name });
    const searchUrl = `${XHS}/search_result?keyword=${encodeURIComponent(q)}&source=web_search_result_notes`;
    await this.load(w, searchUrl);
    if (await this.checkBlocked(w)) await this.load(w, searchUrl);
    if (cfg.sortLatest) { await this.exec(w, pageSortLatest); await sleep(rand(2000, 3500)); }
    const list = (await this.exec(w, pageScrapeSearch, [cfg.scrollPages])) || [];
    // 先看搜索结果卡片：能直接判掉的（太旧/排除词/已出/标题价格全超预算）不点进去
    for (const n of list) n.time = parseRelTime(n.timeText);
    const unseen = list.filter((n) => !this.isSeen(n.id));
    const skipped = {};
    const toOpen = [];
    for (const n of unseen) {
      const why = this.cardFilter(n, task, cfg);
      if (why) { skipped[why] = (skipped[why] || 0) + 1; this.markSeen(n.id); } else toOpen.push(n);
    }
    const fresh = toOpen.slice(0, cfg.maxDetailPerQuery);
    fresh.forEach((n) => this.claimed.add(n.id));
    const skipTxt = Object.entries(skipped).map(([k, v]) => `${k} ${v}`).join('、');
    this.log(`${tg}「${q}」${list.length} 条结果，新帖 ${unseen.length}` + (skipTxt ? `，卡片上直接排除 ${unseen.length - toOpen.length}（${skipTxt}）` : '') + `，点开看 ${fresh.length}`);

    for (const [i, n] of fresh.entries()) {
      if (!this.alive(w)) { this.claimed.delete(n.id); continue; }
      this.setState(w, { phase: 'open', q, task: task.name, i: i + 1, n: fresh.length, title: n.title, skipped: unseen.length - toOpen.length });
      const url = `${XHS}/explore/${n.id}` + (n.token ? `?xsec_token=${encodeURIComponent(n.token)}&xsec_source=pc_search` : '');
      await this.load(w, url);
      if (await this.checkBlocked(w)) await this.load(w, url);
      const d = await this.exec(w, pageScrapeDetail, [n.id, !!cfg.readComments]);
      this.markSeen(n.id);
      this.stats.scanned++;
      if (!d) { this.log(`${tg}读取失败 ${n.id}`, 'warn'); continue; }
      const note = { ...n, ...d, title: d.title || n.title, cover: n.cover || (d.images || [])[0], url };
      const res = await this.evaluate(note, task, cfg, w);
      if (res.ok) {
        this.stats.matched++;
        let collected = '';
        let collectedBoard = '';
        if (cfg.autoCollect && !res.unknown) {
          await sleep(rand(800, 2000));
          collected = (await this.exec(w, pageCollect).catch((e) => 'error:' + e.message)) || 'error';
          const board = (task.board || cfg.collectBoard || '').trim();
          if (collected === 'done' && board) {
            await sleep(rand(600, 1200));
            const b = (await this.exec(w, pageAddToBoard, [board]).catch((e) => 'error:' + e.message)) || 'error';
            const why = { 'no-entry': '没找到“添加到专辑”的入口', 'no-board': `专辑列表里没有「${board}」，请先在小红书里建好这个专辑`, unconfirmed: '点了但没确认成功' }[b] || b;
            if (b === 'done') this.log(`${tg}已收藏到专辑「${board}」`, 'ok');
            else this.log(`${tg}已收藏，但放进专辑「${board}」失败：${why}（帖子在默认收藏里）`, 'warn');
            collectedBoard = b === 'done' ? board : '';
          } else if (collected === 'done' || collected === 'already') this.log(`${tg}${collected === 'done' ? '已自动收藏' : '之前已收藏过'}`, 'ok');
          else this.log(`${tg}自动收藏失败（${collected}），可能页面改版了`, 'warn');
        }
        const m = { ...note, task: task.name, priceText: res.priceText, price: res.price, free: res.free, unknown: res.unknown, collected: collected === 'done' || collected === 'already', board: collectedBoard, foundAt: Date.now() };
        this.log(res.unknown ? `${tg}价格未知（不推送）[${task.name}] ${note.title}` : `${tg}捡到 [${task.name}] ${res.priceText}，${note.ip || '?'}，${note.title}`, res.unknown ? 'dim' : 'ok');
        await this.onMatch(m);
        if (!res.unknown) await pushAll(cfg, `${res.priceText} · ${note.ip || ''} · ${task.name}`, note.title || note.desc.slice(0, 60), url);
      } else {
        this.log(`${tg}跳过：${res.why}，${note.title}`, 'dim');
      }
      await sleep(rand(cfg.detailDelay[0], cfg.detailDelay[1]) * 1000);
    }
  }

  // 只用搜索卡片上的信息（标题、发布时间）判断，返回排除原因或 ''
  // 地区没法在卡片上判断：IP 属地只有点进帖子才看得到
  cardFilter(n, task, cfg) {
    const title = norm(n.title);
    if (cfg.maxAgeDays && n.time && Date.now() - n.time > cfg.maxAgeDays * 864e5) return '太旧';
    if (hasAny(title, [...cfg.excludeWords, ...task.exclude])) return '排除词';
    if (detectSold(title, cfg.soldWords)) return '已出';
    if (detectIrrelevant(n.title, cfg.irrelevantWords)) return '不相干';
    if (task.requireSecondhand && n.title && !detectSale(n.title, cfg.secondhandWords) && !detectFree(n.title) &&
        !hasAny(n.title, itemTerms(task)) &&
        !extractPrices(n.title, { unmarkedCurrency: cfg.unmarkedCurrency, dollarMeans: cfg.dollarMeans }).some((p) => p.conf >= 2)) return '标题不相干';
    if (task.max > 0 || !task.includeFree) {
      const ps = extractPrices(title, { unmarkedCurrency: cfg.unmarkedCurrency, dollarMeans: cfg.dollarMeans })
        .filter((p) => p.conf >= 2)
        .map((p) => convert(p.value, p.currency, cfg.budgetCurrency, cfg.fx))
        .filter((v) => v != null);
      if (ps.length && !detectFree(title) && ps.every((v) => v > task.max || v < (task.min || 0))) return '标题价格超预算';
    }
    return '';
  }

  // ---------- 判断 ----------
  async evaluate(note, task, cfg, w) {
    const text = norm(`${note.title}\n${note.desc}\n${(note.tags || []).join(' ')}`);
    if (cfg.maxAgeDays && note.time && Date.now() - note.time > cfg.maxAgeDays * 864e5) return { why: '太旧' };
    if (hasAny(text, [...cfg.excludeWords, ...task.exclude])) return { why: '含排除词' };
    const irr = detectIrrelevant(note.title, cfg.irrelevantWords, note.desc);
    if (irr) return { why: `不相干（${irr}）` };
    const terms = itemTerms(task);
    if (terms.length && !hasAny(text, terms)) return { why: `没提到「${terms.slice(0, 3).join('/')}」` };
    if (task.regions.length) {
      const where = `${note.ip || ''} ${text}`;
      if (!hasAny(where, task.regions)) return { why: `地区不符(${note.ip || '无IP'})` };
    }
    // 没货了：标题/正文/标签/评论里有 已出 / hold / sold 等
    const sold = detectSold(text, cfg.soldWords) || (note.comments || []).map((c) => detectSold(c, cfg.soldWords)).find(Boolean);
    if (sold) return { why: `已出/没货（“${sold}”）` };
    const free = task.includeFree && detectFree(text);
    if (!free && task.requireSecondhand && !detectSale(text, cfg.secondhandWords)) return { why: '不像在卖东西' };

    const opt = { unmarkedCurrency: cfg.unmarkedCurrency, dollarMeans: cfg.dollarMeans };
    let prices = bestPrices(extractPrices(text, opt));
    if (!prices.length && note.authorComments?.length) {
      prices = bestPrices(extractPrices(note.authorComments.join('\n'), { ...opt, sellerContext: true }).map((p) => ({ ...p, fromComment: true })));
    }
    let ocrText = '';
    if (cfg.ocr && (cfg.ocrAlways || (!prices.length && !free)) && note.images?.length) {
      if (w) this.setState(w, { ...w.state, phase: 'ocr' });
      ocrText = await this.ocr(note.images.slice(0, cfg.ocrMaxImages));
      // 图片上的数字很杂（型号、跑分、屏幕参数），只认带 ¥/$/💰/售价 这类标记的
      const fromImg = extractPrices(ocrText, { ...opt, fromOcr: true }).filter((p) => p.conf >= 2).map((p) => ({ ...p, ocr: true }));
      // 文字（正文/楼主评论）里写了价格就以文字为准，图片价格只在文字完全没写时才用
      if (!prices.length) prices = bestPrices(fromImg);
    }
    const soldImg = ocrText && detectSold(ocrText, cfg.soldWords);
    if (soldImg) return { why: `图片上写了已出/没货（“${soldImg}”）` };
    const freeAny = free || (task.includeFree && ocrText && detectFree(ocrText));
    if (freeAny) return { ok: true, free: true, priceText: '免费送' };

    const inBudget = prices
      .map((p) => ({ ...p, b: convert(p.value, p.currency, cfg.budgetCurrency, cfg.fx) }))
      .filter((p) => p.b != null && p.b >= (task.min || 0) && p.b <= task.max);
    if (inBudget.length) {
      const p = inBudget[0];
      const tag = p.currency === cfg.budgetCurrency ? '' : `≈${p.b}${cfg.budgetCurrency}`;
      return {
        ok: true,
        price: { value: p.value, currency: p.currency, budget: p.b, budgetCurrency: cfg.budgetCurrency, ocr: !!p.ocr, fromComment: !!p.fromComment },
        priceText: `${p.value}${p.currency === 'CNY' ? '元' : ' ' + p.currency}${tag}${p.ocr ? '(图)' : ''}`,
      };
    }
    // 没写价格：记到列表里标“价格未知”，但不推送、不收藏
    if (!prices.length) return { ok: true, unknown: true, priceText: '价格未知' };
    return { why: `超预算(${prices.map((p) => p.value + p.currency).join(',')})` };
  }

  // 多个线程共用一个 OCR 模型，排队识别
  ocr(urls) {
    const job = (this.ocrQueue || Promise.resolve()).then(() => this.ocrNow(urls));
    this.ocrQueue = job.catch(() => {});
    return job;
  }
  async ocrNow(urls) {
    try {
      if (!this.ocrWorker) {
        this.log('加载 OCR 模型（首次约 10 秒）…', 'dim');
        this.ocrWorker = await Tesseract.createWorker('chi_sim+eng', 1, {
          workerPath: chrome.runtime.getURL('lib/worker-quiet.js'),
          corePath: chrome.runtime.getURL('lib/core/'),
          langPath: chrome.runtime.getURL('lib/lang'),
          workerBlobURL: false,
          gzip: true,
        });
      }
      let all = '';
      for (const u of urls) {
        const blob = await (await fetch(u)).blob();
        const bmp = await createImageBitmap(blob);
        const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
        const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        const png = await c.convertToBlob({ type: 'image/png' });
        const { data } = await this.ocrWorker.recognize(png);
        all += '\n' + data.text;
      }
      return all;
    } catch (e) {
      this.log('OCR 失败：' + e.message, 'warn');
      return '';
    }
  }
}

// ---------- 注入到小红书页面里执行的函数（MAIN world，必须自包含） ----------
function pageBlockedProbe() {
  const t = document.body ? document.body.innerText.slice(0, 3000) : '';
  return !!document.querySelector('.login-container, .login-modal, #captcha-div, .red-captcha') ||
    /(扫码登录|安全验证|请完成验证|登录后查看更多)/.test(t);
}

async function pageSortLatest() {
  const byText = (txt) => [...document.querySelectorAll('span,div,button,li')].find((e) => e.childElementCount === 0 && e.textContent.trim() === txt);
  let el = byText('最新');
  if (!el) {
    const f = byText('筛选');
    if (f) {
      f.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      f.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      f.click();
      await new Promise((r) => setTimeout(r, 800));
      el = byText('最新');
    }
  }
  if (el) { el.click(); return true; }
  return false;
}

async function pageScrapeSearch(pages) {
  const un = (x) => { let i = 0; while (x && typeof x === 'object' && i++ < 5 && ('_rawValue' in x || '_value' in x)) x = x._rawValue ?? x._value; return x; };
  const out = new Map();
  const grab = () => {
    // 1) 页面状态
    try {
      const feeds = un(un(window.__INITIAL_STATE__?.search)?.feeds) || [];
      for (const f of feeds) {
        const c = f.noteCard || f.note_card || {};
        if (!f.id || (f.modelType || f.model_type) && (f.modelType || f.model_type) !== 'note') continue;
        const corner = (c.cornerTagInfo || c.corner_tag_info || []).find((t) => /time/i.test(t.type || '')) || {};
        out.set(f.id, {
          id: f.id, token: f.xsecToken || f.xsec_token || '',
          timeText: corner.text || '',
          title: c.displayTitle || c.display_title || '',
          author: c.user?.nickname || c.user?.nickName || '',
          cover: c.cover?.urlDefault || c.cover?.url_default || c.cover?.url || '',
        });
      }
    } catch (e) { /* ignore */ }
    // 2) DOM 兜底
    document.querySelectorAll('section.note-item, .feeds-container .note-item').forEach((s) => {
      const a = [...s.querySelectorAll('a[href]')].find((x) => /\/(explore|search_result|discovery\/item)\/[0-9a-f]{24}/.test(x.getAttribute('href')));
      if (!a) return;
      const href = a.getAttribute('href');
      const id = href.match(/[0-9a-f]{24}/)[0];
      const token = new URL(href, location.href).searchParams.get('xsec_token') || '';
      const prev = out.get(id) || {};
      const timeEl = s.querySelector('.time, .date, .publish-time, [class*="time"]');
      const timeText = (timeEl?.textContent || (s.innerText.match(/(刚刚|\d+\s*(分钟|小时|天|周)前|昨天[\s\d:]*|前天|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2})/) || [])[0] || '').trim();
      out.set(id, {
        id, token: prev.token || token,
        timeText: prev.timeText || timeText,
        title: prev.title || (s.querySelector('.title, .footer .title span')?.textContent || '').trim(),
        author: prev.author || (s.querySelector('.author .name, .name')?.textContent || '').trim(),
        cover: prev.cover || s.querySelector('img')?.src || '',
      });
    });
  };
  grab();
  for (let i = 0; i < pages; i++) {
    window.scrollBy(0, window.innerHeight * 1.8);
    await new Promise((r) => setTimeout(r, 1800 + Math.random() * 1500));
    grab();
  }
  return [...out.values()];
}

async function pageScrapeDetail(id, withComments) {
  const un = (x) => { let i = 0; while (x && typeof x === 'object' && i++ < 5 && ('_rawValue' in x || '_value' in x)) x = x._rawValue ?? x._value; return x; };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 评论：滚动评论区让它加载，再从页面状态 + DOM 里读
  const comments = [];
  const authorComments = []; // 楼主自己在评论区说的话（常在置顶评论里写价格）
  if (withComments) {
    for (let i = 0; i < 3; i++) {
      const sc = document.querySelector('.note-scroller, .interaction-container, .comments-el') || document.scrollingElement;
      sc.scrollTop = sc.scrollHeight;
      await wait(900 + Math.random() * 700);
    }
    try {
      const entry = un(un(un(window.__INITIAL_STATE__?.note)?.noteDetailMap)?.[id]) || {};
      const list = un(un(entry.comments)?.list) || [];
      const ownerId = un(entry.note)?.user?.userId || un(entry.note)?.user?.user_id || '';
      const isOwner = (c) => {
        const uid = c.userInfo?.userId || c.user_info?.user_id || '';
        const tags = (c.showTags || c.show_tags || []).join(' ');
        return (ownerId && uid === ownerId) || /author/i.test(tags);
      };
      for (const c of list) {
        if (c.content) { comments.push(c.content); if (isOwner(c)) authorComments.push(c.content); }
        for (const s of c.subComments || c.sub_comments || []) if (s.content) { comments.push(s.content); if (isOwner(s)) authorComments.push(s.content); }
      }
    } catch (e) { /* ignore */ }
    document.querySelectorAll('.comment-item .content, .comment-item .note-text, .comments-container .content').forEach((e) => {
      const t = (e.innerText || '').trim();
      if (!t) return;
      comments.push(t);
      const item = e.closest('.comment-item, .comment-inner-container, .parent-comment');
      if (item && /作者/.test(item.querySelector('.author .tag, .tag, .author-tag')?.textContent || '')) authorComments.push(t);
    });
  }
  let n = null;
  try {
    const map = un(un(window.__INITIAL_STATE__?.note)?.noteDetailMap) || {};
    n = un(map[id])?.note || un(Object.values(map)[0])?.note || null;
  } catch (e) { /* ignore */ }
  const imgUrl = (im) => im.urlDefault || im.url_default || (im.infoList || im.info_list || []).find((x) => /DFT|dft/.test(x.imageScene || x.image_scene))?.url || (im.infoList || [])[0]?.url || im.url || '';
  if (n && (n.desc != null || n.title != null)) {
    return {
      title: n.title || '',
      desc: n.desc || '',
      ip: n.ipLocation || n.ip_location || '',
      time: n.time || n.lastUpdateTime || 0,
      author: n.user?.nickname || '',
      tags: (n.tagList || n.tag_list || []).map((t) => t.name),
      images: (n.imageList || n.image_list || []).map(imgUrl).filter(Boolean),
      type: n.type,
      comments: [...new Set(comments)], authorComments: [...new Set(authorComments)],
    };
  }
  // DOM 兜底
  const q = (s) => document.querySelector(s);
  const title = (q('#detail-title')?.textContent || '').trim();
  const desc = (q('#detail-desc')?.innerText || q('.note-text')?.innerText || '').trim();
  if (!title && !desc) return null;
  const date = (q('.bottom-container .date, .date')?.textContent || '').trim();
  const imgs = [...document.querySelectorAll('.swiper-slide img, .note-slider-img, .media-container img')].map((i) => i.src).filter((s) => s && !s.startsWith('data:'));
  return {
    title, desc, ip: (date.match(/([一-龥A-Za-z]+)\s*$/) || [])[1] || '', time: 0,
    author: (q('.author-wrapper .username, .author .name')?.textContent || '').trim(),
    tags: [], images: [...new Set(imgs)], comments: [...new Set(comments)], authorComments: [...new Set(authorComments)],
  };
}

// 在帖子详情页点“收藏”。返回 'done' | 'already' | 'notfound' | 'unconfirmed'
async function pageCollect() {
  const root = document.querySelector('.note-container, #noteContainer, .interact-container, .engage-bar') || document;
  const btn =
    root.querySelector('.engage-bar .collect-wrapper, .interact-container .collect-wrapper, #note-page-collect-board-guide .collect-wrapper') ||
    root.querySelector('#note-page-collect-board-guide, .collect-wrapper, [class*="collect-wrapper"]') ||
    [...root.querySelectorAll('svg use')].find((u) => /#collect/.test(u.getAttribute('xlink:href') || u.getAttribute('href') || ''))?.closest('span,div,button');
  if (!btn) return 'notfound';
  const state = () => {
    const use = btn.querySelector('use');
    const href = use ? use.getAttribute('xlink:href') || use.getAttribute('href') || '' : '';
    if (/#collected/.test(href)) return true;
    if (/\b(collected|active|is-collected)\b/.test(btn.className + ' ' + (btn.firstElementChild?.className?.baseVal ?? btn.firstElementChild?.className ?? ''))) return true;
    return false;
  };
  const count = () => (btn.querySelector('.count')?.textContent || '').trim();
  if (state()) return 'already';
  const before = count();
  (btn.querySelector('.reds-icon, svg, .collect-icon') || btn).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 300));
    if (state()) return 'done';
    if (before && count() && count() !== before) return 'done';
  }
  return 'unconfirmed';
}

// 收藏成功后，把帖子放进指定专辑。小红书网页版收藏后会弹出“收藏成功 / 添加到专辑”之类的提示，
// 点进去是专辑列表。页面结构可能会变，这里按文字找，不依赖具体 class。
// 返回 'done' | 'no-entry'（找不到“专辑”入口）| 'no-board'（列表里没有这个专辑名）| 'unconfirmed'
async function pageAddToBoard(board) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, '').toLowerCase();
  const target = norm(board);
  const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const click = (e) => {
    const c = e.closest('button, a, li, [role="button"], [role="option"], [class*="item"], [class*="board"], [class*="album"]') || e;
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) c.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
  };
  const leaves = () => [...document.querySelectorAll('body *')].filter((e) => e.childElementCount === 0 && visible(e));
  const findBoard = () => leaves().find((e) => norm(e.textContent) === target) ||
    leaves().find((e) => norm(e.textContent).startsWith(target) && /^\d*$/.test(norm(e.textContent).slice(target.length).replace(/[()（）篇个]/g, '')));
  const poll = async (fn, ms = 3000) => { for (let t = 0; t < ms; t += 250) { const r = fn(); if (r) return r; await wait(250); } return null; };

  // 1. 有的版本收藏后直接弹专辑列表；否则找“添加到专辑 / 收藏到专辑 / 选择专辑”入口
  let item = findBoard();
  if (!item) {
    const entry = await poll(() => leaves().find((e) => /(添加|收藏|移动|加入|选择|放入).{0,2}专辑|专辑.{0,2}(选择|管理)/.test(e.textContent.trim()) && e.textContent.trim().length <= 12));
    if (!entry) return 'no-entry';
    click(entry);
    item = await poll(findBoard);
  }
  if (!item) {
    // 关掉弹窗，帖子仍在默认收藏里
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return 'no-board';
  }
  click(item);
  await wait(600);
  // 2. 有确认按钮就点
  const ok = leaves().find((e) => /^(完成|确定|确认|保存|收藏)$/.test(e.textContent.trim()) && e.closest('[class*="modal"], [class*="dialog"], [role="dialog"], [class*="board"], [class*="album"], [class*="popup"]'));
  if (ok) { click(ok); await wait(600); }
  // 3. 看提示里有没有专辑名，或者列表已经关掉
  const toast = await poll(() => leaves().find((e) => norm(e.textContent).includes(target) && /(已|成功|收藏到|添加到)/.test(e.textContent)), 2000);
  if (toast || !findBoard()) return 'done';
  return 'unconfirmed';
}

// ---------- 推送 ----------
// opt.forceDesktop：不管设置，都弹系统通知（用于“需要人工验证”这种必须马上知道的事）
async function pushAll(cfg, title, body, url, opt = {}) {
  const p = cfg.push || {};
  const tasks = [];
  if (p.desktopNotify || opt.forceDesktop) tasks.push(chrome.notifications.create(url + '#' + Date.now(), { type: 'basic', iconUrl: 'icon.png', title, message: body || '', priority: 2, requireInteraction: true }));
  if (p.ntfyTopic) tasks.push(fetch('https://ntfy.sh/', { method: 'POST', body: JSON.stringify({ topic: p.ntfyTopic, title, message: body, click: url, priority: 4 }) }));
  if (p.barkUrl) tasks.push(fetch(`${p.barkUrl.replace(/\/$/, '')}/${encodeURIComponent(title)}/${encodeURIComponent(body || ' ')}?url=${encodeURIComponent(url)}&group=xhs`));
  if (p.tgToken && p.tgChat) tasks.push(fetch(`https://api.telegram.org/bot${p.tgToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: p.tgChat, text: `${title}\n${body}\n${url}` }) }));
  if (p.serverChanKey) tasks.push(fetch(`https://sctapi.ftqq.com/${p.serverChanKey}.send`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ title, desp: `${body}\n\n[打开帖子](${url})` }) }));
  const r = await Promise.allSettled(tasks);
  return r.filter((x) => x.status === 'rejected').map((x) => x.reason?.message);
}

// ---------- 工具 ----------
// 任务的物品关键词：填了就用填的；没填就从搜索词里去掉 地区/二手/出 等字样自动取（“出 笔记本电脑”→ 笔记本电脑、笔记本、电脑）
function itemTerms(task) {
  if (task.mustInclude && task.mustInclude.length) return task.mustInclude;
  const strip = new RegExp('(二手|闲置|出售|转让|免费送|白送|回国|低价|便宜|自用|全新|九成新|成新|清仓|出物|出|送|求|' +
    (task.regions || []).map((r) => r.replace(/[.*+?^${}()|[]\]/g, '\// ---------- 工具 ----------')).filter(Boolean).join('|') + ')', 'gi');
  const out = new Set();
  for (const q of task.queries || []) {
    for (const tok of q.replace(strip, ' ').split(/s+/)) {
      const t = tok.trim();
      if (t.length < 2) continue;
      out.add(t);
      if (/^[一-龥]{4,}$/.test(t)) { out.add(t.slice(0, 3)); out.add(t.slice(-2)); }
    }
  }
  return [...out];
}
function norm(s) { return String(s || '').replace(/\s+/g, ' ').toLowerCase(); }
function hasAny(text, words) { const t = norm(text); return words.some((w) => w && t.includes(norm(w))); }
function deepMerge(a, b) {
  for (const k in b) {
    if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])) deepMerge(a[k], b[k]);
    else a[k] = b[k];
  }
  return a;
}
