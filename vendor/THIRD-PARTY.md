# 本地前端依赖

运行时不从 CDN 加载代码。以下资源已随程序提供，具体 SHA-256 见 integrity.json。

| 项目 | 版本 | 来源 | 许可证 |
| --- | --- | --- | --- |
| pdf-lib | 1.17.1 | npm 官方注册表 pdf-lib 包 dist/pdf-lib.min.js | MIT，见 licenses/pdf-lib-LICENSE.md |
| JSZip | 3.10.1 | npm 官方注册表 jszip 包 dist/jszip.min.js | 采用 MIT 许可，见 licenses/jszip-LICENSE.md |
| PDF.js | 3.11.174 | npm 官方注册表 pdfjs-dist 包 build/pdf.min.js、pdf.worker.min.js | Apache-2.0，见 licenses/pdfjs-LICENSE.txt |

Acorn 8.15.0 仅用于构建期语法解析，不在浏览器运行。Node SQLite 使用本机 Node.js 自带模块。

PDF.js 采用兼容原生前端的旧版接口；所有解析入口明确设置 isEvalSupported:false，并由页面 CSP 禁止动态代码执行，落实 Mozilla 对 CVE-2024-4367 的官方缓解方案：https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq 。后续可单独进行新版模块接口迁移，不应移除此安全选项。
