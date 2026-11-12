// 包一层 tesseract 的 worker：屏蔽它往控制台刷的无害提示（扩展错误页会把它们显示成一大片警告）
// 真正的错误照常输出
const NOISE = /Parameter not found|Image too small to scale|Line cannot be recognized|Empty page|Estimating resolution|Detected \d+ diacritics|Invalid resolution|Warning: .*(params|parameter)/i;
for (const k of ['log', 'warn', 'error', 'info', 'debug']) {
  const orig = console[k].bind(console);
  console[k] = (...args) => {
    const first = args.length ? String(args[0]) : '';
    if (NOISE.test(first)) return;
    orig(...args);
  };
}
importScripts('worker.min.js');
