// 价格提取：从帖子文字 / OCR 文字里找出“售价”，排除原价、型号、容量等干扰数字。
// 纯函数，浏览器和 Node 都能用（node test.js 自测）。

const CURRENCY_TOKENS = [
  // [正则片段, 币种]  ——  顺序重要：长的放前面
  // 表情符号当价格标记：“💰 2199”。没指明币种的按“没写币种的数字按”设置算
  ['💷', 'GBP'],
  ['💶', 'EUR'],
  ['💵', 'DOLLAR'],
  ['💴', 'CNY'],
  ['💰|💲|💸|🤑|🏷️|🏷|💳', 'UNMARKED'],
  ['英镑|镑|£|GBP|gbp|英磅', 'GBP'],
  ['澳币|澳元|澳刀|AUD|aud|A\\$', 'AUD'],
  ['加币|加元|CAD|cad|C\\$', 'CAD'],
  ['港币|港元|HKD|hkd|HK\\$', 'HKD'],
  ['日元|円|JPY|jpy|日币', 'JPY'],
  ['欧元|欧|€|EUR|eur', 'EUR'],
  ['美元|美金|USD|usd|US\\$', 'USD'],
  ['刀|🔪|\\$', 'DOLLAR'],
  ['人民币|元|块钱|块|¥|￥|RMB|rmb|CNY|cny|r(?![a-z])|R(?![a-zA-Z])', 'CNY'],
];

const PRE_CTX = /(不刀|不🔪|可刀|可🔪|小刀|小🔪|价格?|售价|出价|卖价|一口价|到手|只要|仅需?|仅售|包邮|出|卖|转|便宜|低价|预算|现价|price|£|\$)/i;
const POST_CTX = /^(.{0,4})(包邮|出|可刀|可小刀|不刀|可🔪|可小🔪|不🔪|不议|可议|秒|自提|面交|带走|拿走|走了|速出|即出|左右|以内|闪)/;
const PRICE_WORD = /(价|售|到手|一口价|只要|仅需?|💰|price)/i;
const POST_STRONG = /^\s*(包邮|可刀|可小刀|不刀|可🔪|可小🔪|不🔪|不议|可议|带走|拿走)/;
// 前面出现这些词说明是原价/购入价，不是现在卖的价格
const EXCLUDE_PRE = /(原价|原来|原售|购入|买入|入手|官网|官方|官价|发票|全新价|首发|专柜|当时|当初|指导价|市场价|国补|京东|天猫|闲鱼上|电池|充电|续航|运行|分辨率|跑分|功率)/;
// 数字后面跟这些单位就不是价格
const BAD_UNIT = /^\s*("|″|”|''|G|GB|g|T|TB|t|M|MB|寸|英寸|吋|inch|Hz|hz|HZ|核|代|年|款|mAh|mah|%|次|天|个月|月|周|cm|mm|斤|kg|KG|W(?![a-z])|瓦|帧|fps|FPS|K屏|k屏|屏|分|小时|h(?![a-z])|岁|楼|号|线|cpu|CPU|位|nm|Mbps|元素|张|件|台|个|部|人|关注|赞)/;

function normalizeOcr(s) {
  // OCR 结果常在汉字间插空格；只删掉非“数字-数字”之间的空格
  return s
    .replace(/(^|[^A-Za-z])[Yy]\s+(?=\d)/g, '$1') // 单独的 “Y ” 多半是没认出来的 ¥，去掉它，数字本身靠 包邮/售价 等语境判断
    .replace(/(?<!\d)\d(?:\s\d(?!\d))+/g, (x) => x.replace(/\s/g, '')) // "2 8 0 0" -> 2800
    .replace(/(\D)\s+(?=\S)/g, '$1')
    .replace(/(\d)\s+(?=\D)/g, '$1');
  // 注意：不再把 OCR 出来的 “Y” 当成 ¥ —— 截图里的型号/软件界面会被误判成价格
}

function toNumber(intPart, decPart, unit, tail) {
  let v = parseFloat(intPart + (decPart ? '.' + decPart : ''));
  if (!unit) return v;
  if (/[kK千]/.test(unit)) {
    v *= 1000;
    if (tail && !decPart) v += parseInt(tail, 10) * (tail.length === 1 ? 100 : tail.length === 2 ? 10 : 1);
  } else if (/[wW万]/.test(unit)) {
    v *= 10000;
    if (tail && !decPart) v += parseInt(tail, 10) * (tail.length === 1 ? 1000 : 100);
  }
  return Math.round(v * 100) / 100;
}

/**
 * @param {string} text
 * @param {object} opt { unmarkedCurrency:'CNY', dollarMeans:'USD', fromOcr:false }
 * @returns {{value:number,currency:string,raw:string,strong:boolean}[]}
 */
function extractPrices(text, opt = {}) {
  if (!text) return [];
  const unmarked = opt.unmarkedCurrency || 'CNY';
  const dollar = opt.dollarMeans || 'USD';
  let s = String(text).replace(/[，,](?=\d{3}(\D|$))/g, ''); // 1,299 -> 1299
  s = s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  if (opt.fromOcr) s = normalizeOcr(s);

  const curAlt = CURRENCY_TOKENS.map((c) => c[0]).join('|');
  const re = new RegExp(
    '(' + curAlt + ')?\\s*' +           // 1 前置币种
    '(\\d{1,6})(?:\\.(\\d{1,2}))?' +     // 2 整数 3 小数
    '\\s*([kK千wW万])?(\\d{1,3})?' +      // 4 k/w 单位 5 尾数(3k5)
    '\\s*(' + curAlt + ')?',            // 6 后置币种
    'g'
  );
  const out = [];
  let m;
  while ((m = re.exec(s))) {
    const [raw, preCur, ip, dp, unit, tail, postCurRaw] = m;
    const start = m.index + raw.indexOf(ip);
    const before = s.slice(Math.max(0, start - 8), start);
    const after = s.slice(m.index + raw.length);
    const prevChar = preCur ? '' : (s[m.index + raw.indexOf(ip) - 1] || '');
    // 型号里的数字：i7-13700、RTX4060、M2 等
    if (!preCur && /[A-Za-z\-_/.:]/.test(prevChar)) continue;
    if (/^[\-_/.:]?\d/.test(after) && !unit) continue;
    let postCur = postCurRaw;
    // 'r'/'R' 后置只在紧跟数字时算人民币（避免 "500 RAM"）
    if (postCur && /^[rR]$/.test(postCur) && /\s/.test(raw.slice(raw.length - postCur.length - 1, -postCur.length))) postCur = undefined;
    // 单独的 'w/W' 是瓦特还是万：数字大于 99 一律当瓦特
    if (unit && /[wW]/.test(unit) && parseFloat(ip) > 99) continue;
    if (!unit && !postCur && BAD_UNIT.test(after)) continue;
    if (unit && /[kK]/.test(unit) && /^\s*(屏|显示|分辨率|高清|HDR|hdr|\d{2,3}\s*hz|视频|电视|投屏|帧|fps|高刷|OLED|oled|IPS|ips)/i.test(after)) continue;
    if (unit && /[kK]/.test(unit) && /(屏幕?|分辨率|显示器?)[:：\s]*\d*[\d.]*$/.test(s.slice(Math.max(0, start - 10), start + ip.length))) continue;

    // “不🔪 300”“可小刀 300”：刀/🔪 前面是 可/不/小/大 时是“砍价”的意思，不是币种
    let pc = preCur;
    if (pc && /^(刀|🔪)$/.test(pc) && /(可|不|小|大|拒|别|议)$/.test(s.slice(0, m.index))) pc = undefined;
    // “💰 1199🔪”：前面的 💰 只是标记，后面的 🔪/刀/镑 才说明币种
    const isGenericMark = (c) => c && /^(💰|💲|💸|🤑|🏷️|🏷|💳)$/.test(c);
    const cur = isGenericMark(pc) && postCur ? postCur : pc || postCur;
    let currency = unmarked;
    if (cur) {
      for (const [pat, c] of CURRENCY_TOKENS) {
        if (new RegExp('^(' + pat + ')$').test(cur)) { currency = c; break; }
      }
    }
    if (currency === 'DOLLAR') currency = dollar;
    if (currency === 'UNMARKED') currency = unmarked;

    const value = toNumber(ip, dp, unit, tail);
    const hasPre = PRE_CTX.test(before.slice(-5));
    const hasPost = POST_CTX.test(after);
    // 只有 k/w 单位不够（“2.5K 240Hz”是分辨率），必须再有币种或价格语境
    const strong = !!cur || ((!!unit) && (hasPre || hasPost));
    const weak = hasPre || hasPost || (opt.sellerContext && !!unit);
    if (!strong && !weak) continue;
    if (EXCLUDE_PRE.test(before)) continue;
    if (!cur && !unit && value >= 1990 && value <= 2035 && Number.isInteger(value)) continue; // 年份
    if (value < 10 || value > 500000) continue;
    // 置信度：3 = 有币种/价格符号；2 = 紧挨着“售价/到手/包邮/可刀”等；1 = 只有“出”之类的弱语境
    const conf = cur ? 3
      : (PRICE_WORD.test(before.slice(-6)) || POST_STRONG.test(after) || (unit && (hasPre || hasPost || opt.sellerContext))) ? 2
      : 1;
    out.push({ value, currency, raw: raw.trim(), strong: strong || hasPre || hasPost, conf });
  }
  // 去重
  const seen = new Set();
  return out.filter((p) => {
    const k = p.value + p.currency;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function convert(value, from, to, fx) {
  if (from === to) return value;
  const a = fx[from], b = fx[to];
  if (!a || !b) return null;
  return Math.round((value * a) / b);
}

// 一帖里有明确标价（💰/🔪/¥/A$/售价…）时，只信这些，忽略零散的弱匹配数字
function bestPrices(prices) {
  if (!prices.length) return prices;
  const top = Math.max(...prices.map((p) => p.conf || 1));
  return prices.filter((p) => (p.conf || 1) === top);
}

// 是不是在卖东西：“出”只在当动词用时算（墨尔本出、出一台、【出】），“出现/出来”不算
const SALE_RE = /(出售|转让|转手|闲置|二手|自用|出物|自提|自取|面交|包邮|可刀|可小刀|不刀|可🔪|不🔪|小🔪|售价|一口价|价格[:：]|💰|清仓|低价出|便宜出|出掉|for\s*sale|selling|(^|[\s【\[#|｜,，。!！:：、(（]|本|城|尼|兰|敦|堡|顿|多|州|区|市|岛)出(?!现|来|去|门|发|行|差|国|生|色|名|品|版|租|圈|片|道|口|彩|众|游|没|入|轨|场|镜|身|街|厂|勤|击|錯|错|问题|于|自)|出[一个台套张件部辆只对副组]|出(全新|九|95|99|自用|闲置|二手))/i;
function detectSale(text, extraWords = []) {
  const s = String(text || '');
  if (SALE_RE.test(s)) return true;
  return extraWords.some((w) => w && w !== '出' && w !== '送' && s.toLowerCase().includes(w.toLowerCase()));
}

// 免费送 / 白送 检测（“免费包邮”“买就送”不算）
const FREE_RE = /(免费送|免费赠|免费给|免费领|免费自取|免费带走|免费出|白送|白给|直接送|无偿|0元送|0元出|零元|送人|送给有缘|送有缘|有缘人|送出去|捡漏送|giveaway|free\s*(to|pick|giveaway|collection)|for\s*free|\bfree\b)/i;
function detectFree(text) {
  if (!text) return false;
  const s = String(text).replace(/免费包邮|包邮免费|免费咨询|免费试用|免费配送|买.{0,6}送|送.{0,2}(充电器|壳|膜|耳机|鼠标|包|赠品|配件)/g, '');
  return FREE_RE.test(s);
}

// 已出 / sold / hold 检测：命中就说明没货了。问句（“已出了吗？”“sold?”）不算。
const SOLD_RE = /(已出(?!过)|已售|已卖|已转(?!发)|已送出|已送走|送出去了|已被领|已领走|被领走|已被?预[定订]|已被?[定订](?!价|制|做|位)|被[定订]了|已被?拍下?|已交易|已成交|出掉了|卖掉了|卖出了|已下架|已有主|有主了|售罄|已截止|已结束|\bsold\b|sold\s*out|\bon\s*hold\b|\bhold(?:ing)?\b(?!\s*(住|不住))|\bpending\b|\breserved\b|\bsale\s*pending\b)/gi;
// extraWords：用户在设置里自己加的“没货关键词”，同样排除问句/否定
function detectSold(text, extraWords = []) {
  if (!text) return '';
  const s = String(text);
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const extra = extraWords.filter(Boolean).map((w) => (/^[a-z ]+$/i.test(w) ? `\\b${esc(w)}\\b` : esc(w)));
  const regs = [SOLD_RE];
  if (extra.length) regs.push(new RegExp(extra.join('|'), 'gi'));
  for (const re of regs) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(s))) {
      const after = s.slice(m.index + m[0].length, m.index + m[0].length + 4);
      const before = s.slice(Math.max(0, m.index - 3), m.index);
      if (/^\s*(了)?\s*(吗|么|嘛|没|没有|否|\?|？)/.test(after)) continue; // 问句
      if (/(未|没|还没|不|尚未|没有)$/.test(before)) continue;              // “还没出”“未售”
      if (/^\s*(住|不住)/.test(after)) continue;                         // hold住
      return m[0];
    }
  }
  return '';
}

// 搜索卡片上的发布时间：“刚刚”“5分钟前”“3小时前”“昨天 14:20”“3天前”“10-28”“2024-10-28”
// 返回毫秒时间戳，认不出返回 0（0 = 不按时间排除）
function parseRelTime(text, now = Date.now()) {
  if (!text) return 0;
  const s = String(text).replace(/\s+/g, ' ');
  let m;
  if (/刚刚|just now/i.test(s)) return now;
  if ((m = s.match(/(\d+)\s*分钟前/))) return now - m[1] * 6e4;
  if ((m = s.match(/(\d+)\s*小时前/))) return now - m[1] * 36e5;
  if ((m = s.match(/(\d+)\s*天前/))) return now - m[1] * 864e5;
  if ((m = s.match(/(\d+)\s*周前/))) return now - m[1] * 7 * 864e5;
  if (/昨天/.test(s)) return now - 864e5;
  if (/前天/.test(s)) return now - 2 * 864e5;
  if ((m = s.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/))) return new Date(+m[1], m[2] - 1, +m[3]).getTime();
  if ((m = s.match(/(?:^|\D)(\d{1,2})[-/月](\d{1,2})日?(?:\D|$)/))) {
    const d = new Date(now);
    let t = new Date(d.getFullYear(), m[1] - 1, +m[2]).getTime();
    if (t > now + 864e5) t = new Date(d.getFullYear() - 1, m[1] - 1, +m[2]).getTime(); // 跨年
    return t;
  }
  return 0;
}

// 不相干的帖子：提问、求推荐、测评、避雷、被骗经历……不是在卖东西
const SALE_HINT = /(出|转|卖|送|闲置|清仓|自取|面交|包邮|¥|￥|£|\$|\d+\s*(元|块|镑|刀|r\b|k\b))/i;
function detectIrrelevant(title, words = [], desc = '') {
  const t = String(title || '').trim();
  const tl = t.toLowerCase();
  for (const w of words) if (w && tl.includes(w.toLowerCase())) return w;
  // 标题是问句，又看不出在卖东西
  if (/([吗嘛么呢]|怎么办|如何|咋样|怎样)[\s?？!！~～。.…]*$|[?？]\s*$/.test(t) && !SALE_HINT.test(t)) return '提问帖';
  // 正文开头就是在问问题
  if (desc && /^\s*(想问|请问|求问|问一下|有没有人|有人知道|求助|求推荐|大家觉得)/.test(desc) && !SALE_HINT.test(t)) return '提问帖';
  return '';
}

if (typeof module !== 'undefined') module.exports = { extractPrices, convert, normalizeOcr, detectFree, detectSold, parseRelTime, detectIrrelevant, bestPrices, detectSale };
