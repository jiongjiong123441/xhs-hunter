#!/usr/bin/env bash
# 打包扩展：检查 → 自测 → 生成可直接“加载已解压的扩展程序”的 zip
# 用法：scripts/pack.sh [提交号]    产物在 dist/
set -euo pipefail
cd "$(dirname "$0")/.."
SHA="${1:-$(git rev-parse --short=7 HEAD 2>/dev/null || echo dev)}"

echo "== 语法检查"
for f in price.js engine.js dashboard.js background.js lib/worker-quiet.js; do node --check "$f"; done
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"

echo "== 自测"
node test.js > /tmp/xhs-test.log || { cat /tmp/xhs-test.log; exit 1; }
tail -1 /tmp/xhs-test.log

echo "== 打包"
VERSION=$(node -p "require('./manifest.json').version")
rm -rf dist && mkdir -p dist/xhs-hunter
cp -r manifest.json background.js dashboard.html dashboard.css dashboard.js engine.js price.js icon.png lib README.md dist/xhs-hunter/
# 在 Chrome 扩展页显示“1.0.0 (提交号)”，方便分辨是哪一版
SHA="$SHA" node -e "
const fs=require('fs');const f='dist/xhs-hunter/manifest.json';
const m=JSON.parse(fs.readFileSync(f,'utf8'));m.version_name=m.version+' ('+process.env.SHA+')';
fs.writeFileSync(f,JSON.stringify(m,null,2));"
ZIP="xhs-hunter-$VERSION-$SHA.zip"
if command -v zip >/dev/null; then (cd dist && zip -qr "$ZIP" xhs-hunter)
else (cd dist && powershell -NoProfile -Command "Compress-Archive -Path xhs-hunter -DestinationPath '$ZIP'"); fi
echo "dist/$ZIP"
