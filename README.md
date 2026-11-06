# 骑马钉打印器 · Saddle-stitch Booklet Printer

一个离线单文件网页：把普通 PDF 按骑马钉（saddle stitch）拼版，两面各印半张、对折成册。
所有处理都在浏览器本地完成，不上传文件、不加任何水印。

**在线使用 / Live demo**

- Cloudflare Worker: <https://booklet.xszx.cc.cd/>
- GitHub Pages: <https://w32394045-dotcom.github.io/booklet/>

## 功能

- A4→A5、A3→A4、Letter→半 Letter 拼版，自动补齐空白面（4 的倍数）
- 页码范围、自动分册（每册最大张数），支持几百页 PDF 只印其中一段
- 三遍打印：正面 → 翻面 → 背面 → 护封单独最后打印
- 两种打印方式：矢量 PDF（文字保持矢量、直接调起打印对话框）与渲染打印（兼容异常 PDF）
- 中缝留白可调（滑块 / 数字），翻面镜像、背面反序两个校准开关
- 三种封面方案：① 首页当封面（不打护封，只打两遍）② 自定义护封（封面 / 封底分开上传，支持 JPG / PNG / PDF）③ 空白护封（第 3 遍只出一张空白纸）
- 版面缩略图预览（真实纸张比例 + 折叠线 + 中缝），打印计数，7 种界面语言

## 打印流程

1. **第 1 遍 · 正面**：点「打印」，打印对话框里选：纸张 A4、横向、边距「无」、缩放 100%、单面。
2. **第 2 遍 · 背面**：整叠纸翻面后重新放回，点「打印」。
3. **第 3 遍 · 护封**（仅方案 ②/③）：单独印一张护封纸（右半封面 / 左半封底），折好套在正文外。

不同打印机的翻面方向不一样：先用 2 张废纸试一次，若背面上下颠倒或顺序反了，
在「翻面校准」里切换「镜像背面 / 背面反序」。

## English

Offline single-file web app that imposes a PDF for saddle-stitch booklets (fold A4 to A5).
Print in three passes (fronts → flip the stack → backs → jacket), with page ranges,
auto split, adjustable center gutter, separate front/back covers and a vector or rendered print engine.
No upload, no watermark.

## 开发

```bash
node tools/build.js        # 从 src/ + locales/ + vendor/ 生成 index.html
node tools/test-core.js    # 拼版数学单测
node tools/gate.js         # 单文件结构 / CSP / 安全静态检查
node tools/browser-test.js # 无头 Chrome 端到端测试（需本机 Chrome）
node tools/build_worker.js # 生成 Cloudflare Worker（worker-booklet.js，不入库）
```

`index.html` 是构建产物，也直接提交到仓库供 GitHub Pages 直接托管。
CSP 只允许内联脚本与本地 blob，`connect-src` 为 none，页面完全离线可用。

## 许可

MIT；内置 PDF.js（Apache-2.0）与 pdf-lib（MIT），见 THIRD-PARTY.md。
