// node test.js  —— 价格提取自测
const { extractPrices } = require('./price.js');
const cases = [
  ['出一台联想拯救者 i7-13700H RTX4060 16G 512G 原价8999 现价4500包邮', [4500]],
  ['伦敦自提 MacBook Air M2 8+256 £450 可小刀', [450]],
  ['出二手电脑 3k5 带走', [3500]],
  ['到手价2.3k，2023款，15.6寸 144Hz', [2300]],
  ['显示器 4K 屏幕 出 800r', [800]],
  ['售价：1,299元', [1299]],
  ['回国出闲置 ipad 200镑 macbook 600刀', [200, 600]],
  ['电池续航8小时 买入价12000 现在6000出', [6000]],
  ['100W充电器 送', []],
  ['Y 2 8 0 0 包 邮', [2800], true],
  ['一口价 1.2w', [12000]],
  ['支持现场检查电脑外观、硬件配置和运行情况。\n价格可合理商量，不接受大刀，诚心出。\n💰 2199\n#墨尔本闲置 #墨尔本二手 #墨尔本出闲置 #墨尔本笔记本', [2199]],
  ['💲450 自取', [450]],
  ['🏷️1,299', [1299]],
  ['💷 80 曼城', [80]],
  ['宜家书桌 50🔪 自取', [50]],
  ['显示器 不🔪 300', [300]],
  ['出 iPad 260 可小🔪', [260]],
  ['📦 机器情况\n* 自用约2年，原价A$1,600\n* 因准备升级新电脑，所以出售\n* 32GB大内存 + 2TB固态，日常使用非常方便\n* 支持现场开机检查、测试游戏\n* 仅出售主机，不包含显示器及其他外设\n📍 墨尔本自提，具体地点私聊\n有兴趣可以私信，诚心购买价格可以商量！', []],
  ['📦 机器情况\n* 自用约2年，原价A$1,600\n💰 A$900\n📍 墨尔本自提', [900]],
  ['售价 A$1,100 墨尔本自提', [1100]],
  ['墨尔本出omen游戏本\n惠普暗影精灵9\n💻 配置：\n处理器：Intel i9-13900HX → 24核32线程，睿频最高5.4ghz，性能对标台式机。\n显卡：RTX 4060 8g显存 支持独显直连\n内存：16G 原装ddr5 5600mhz（8+8双通道）\n硬盘：1TB PCIe SSD\n屏幕：16寸 2.5K 240Hz 高刷 打 FPS 不撕裂。\n电池健康度 80%，循环0次。23年中购买 去年过保\n⚠️ 键盘A键右下角缺了一块 不影响使用 整体成色还行\n瓦罗兰特2k分辨率 400帧\n💰 1199🔪\n有诚意可支持面交 / 自提，欢迎现场测试电脑，键盘功能等 不着急出。\n#墨尔本闲置 #墨尔本 #墨尔本游戏本', [1199]],
  ['2K屏 显示器 出 600', [600]],
  ['毕业出闲置电脑\n配置如图 带显示器$1300#留学生落地 #二手 #墨尔本 #电脑', [1300]],
  ['鲁大师 B760M D4 Y42 i5-12400F', [], true],
];
let fail = 0;
for (const [t, want, ocr] of cases) {
  const got = extractPrices(t, { fromOcr: !!ocr }).map((p) => p.value);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(ok ? 'PASS' : 'FAIL', JSON.stringify(got), '<-', t);
}
const { detectFree } = require('./price.js');
for (const [t, want, extra] of [
  ['回国了 锅碗瓢盆免费送 曼城自取', true],
  ['宜家书桌 白送 先到先得', true],
  ['耳机 300 免费包邮', false],
  ['买显示器送鼠标', false],
  ['Free to collect, sofa in Leeds', true],
]) {
  const ok = detectFree(t) === want;
  if (!ok) fail++;
  console.log(ok ? 'PASS' : 'FAIL', 'free=' + detectFree(t), '<-', t);
}
const { detectSold } = require('./price.js');
for (const [t, want, extra] of [
  ['【已出】显示器 300', true],
  ['已出，谢谢大家', true],
  ['宝 已出了吗？', false],
  ['还没出，欢迎私信', false],
  ['SOLD 宜家沙发', true],
  ['on hold for a buyer', true],
  ['sold?', false],
  ['被定了 不好意思', true],
  ['未售出 还在', false],
  ['hold不住这个价格', false],
  ['已定价 不刀', false],
  ['卖掉了', true],
  ['出二手显示器 300 包邮', false],
  ['已送出～', true],
  ['这个已经出啦', true, ['已经出']],
  ['已经出了吗', false, ['已经出']],
]) {
  const got = !!detectSold(t, extra || []);
  const ok = got === want;
  if (!ok) fail++;
  console.log(ok ? 'PASS' : 'FAIL', 'sold=' + got, '<-', t);
}
const { detectIrrelevant, parseRelTime } = require('./price.js');
const IW = ['靠谱吗', '求推荐', '值得买吗', '避雷', '被骗', '骗子', '测评', '评测', '攻略', '教程', '开箱', '选哪个', '哪个好', '求助', '请问'];
for (const [t, want, d] of [
  ['咸鱼低价游戏本靠谱吗', true],
  ['5000预算笔记本求推荐', true],
  ['二手显示器怎么选？', true],
  ['还有人要吗？出宜家书桌 £20', false],
  ['出一台天选6pro 5360包邮', false],
  ['回国清仓 锅碗瓢盆', false],
  ['游戏本', true, '想问一下，在闲鱼上看到了卖天选的游戏本'],
  ['闲鱼被骗经历', true],
]) {
  const got = !!detectIrrelevant(t, IW, d || '');
  const ok = got === want; if (!ok) fail++;
  console.log(ok ? 'PASS' : 'FAIL', 'irrelevant=' + got, '<-', t);
}
const N = new Date(2026, 10, 12, 15, 0).getTime(), day = 864e5;
for (const [t, want] of [['3天前', N - 3 * day], ['5小时前', N - 5 * 36e5], ['刚刚', N], ['昨天 14:20', N - day], ['04-13', new Date(2026, 3, 13).getTime()], ['12-30', new Date(2025, 11, 30).getTime()], ['2025-10-28', new Date(2025, 9, 28).getTime()], ['', 0]]) {
  const got = parseRelTime(t, N); const ok = got === want; if (!ok) fail++;
  console.log(ok ? 'PASS' : 'FAIL', 'time', t, Math.round((N - got) / day) + 'd');
}
const { detectSale, bestPrices } = require('./price.js');
for (const [t, want] of [
  ['连澳洲都被AI卷疯了？IT朋友的真心话 今天在阳朔遇到从AU墨尔本来度假的Andrew', false],
  ['反而呢我来澳洲读博一分钱没花还赚了66w', false],
  ['今天出门遇到', false],
  ['墨尔本出omen游戏本', true],
  ['【墨尔本出二手游戏主机 | RTX 4060', true],
  ['出一台联想', true],
]) { const ok = detectSale(t) === want; if (!ok) fail++; console.log(ok ? 'PASS' : 'FAIL', 'sale=' + detectSale(t), '<-', t); }
{
  const t = '微星 16" 屏幕 出 i7 自用一年\n💰 1199🔪';
  const got = bestPrices(extractPrices(t, { dollarMeans: 'AUD' })).map((p) => p.value + p.currency).join(',');
  const ok = got === '1199AUD'; if (!ok) fail++; console.log(ok ? 'PASS' : 'FAIL', 'best=' + got);
}
console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
