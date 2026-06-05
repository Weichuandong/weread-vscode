# WeRead for VSCode

> 在 VSCode 侧边栏阅读 [微信读书](https://weread.qq.com) — 书架 / 章节目录 / 正文 / 想法划线书评 / 云端进度多端同步。

[![Version](https://img.shields.io/badge/version-1.0.1-blue.svg)](https://github.com/Weichuandong/weread-vscode/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## ✨ 功能特性

### 书架

- 顶部双 Tab 切换：「**书架**」/「**在读**」
- 书架按照你在微信读书 APP 里自建的「分组（archive）」分桶展示
- 支持 **单组折叠/展开**、**全部展开**、**全部折叠**，分组折叠状态本地持久化
- 「在读」列表来自微信读书云端最近阅读

### 阅读器

- 章节正文直接在 VSCode 侧栏内 inline 渲染（不开 iframe，不跳浏览器）
- **图片后端代理** —— 章节内 `<img>` / SVG `<image xlink:href>` 走 axios + Cookie + 正确 Referer 拉成 base64 dataURL 内嵌，绕开 `res.weread.qq.com` 等 CDN 防盗链与 webview CSP 限制
- **图片缓存** —— 同一张图按 URL 缓存为 Promise，章节二次进入或切回不会重复下载
- **两阶段渲染** —— 先发一版无图骨架快速可读，再发完整图文版回填，长章节首屏不会卡白
- **HTML entity 反解** —— 微信读书部分章节是被整段实体转义的字符串（`&lt;p&gt;`），渲染前自动反解
- **脚注图标 CSS 化** —— 不依赖远端 PNG，脚注圆圈用 CSS 伪元素画，自动跟随主题前景色
- **上一章 / 下一章** 按钮按目录顺序翻页，状态走云端同步

### 目录抽屉

- 右侧滑出抽屉，长目录支持搜索过滤
- 自动定位高亮当前章节
- ESC 关闭，遮罩点击关闭

### 想法 / 划线 / 书评抽屉

- 一个抽屉三 Tab：「**想法**」「**划线**」「**书评**」可切换
- 数据来自微信读书云端，支持下拉刷新
- 「想法」来自全章 `reviews`、「划线」来自 `/web/book/bestbookmarks` + `/web/book/underlines` 合并、「书评」走 POST `/web/book/readReviews`

### 正文 inline 划线 + 想法 popover

- 正文中**热门划线**直接 inline 高亮（按 weread 字符 offset range 切片注入，去重并优先保留带 `markText` 的条目）
- 点击高亮段弹出 popover，**按 range 精准拉对应想法**（POST `/web/book/readReviews`，touchFish 同款），不再依赖 markText 全章 indexOf

### 同步 & 登录

- ☁️ **云端进度同步** —— 章节切换、读到哪儿都走微信读书接口，与手机 / 网页端实时互通
- 🔐 **唯一登录方式：粘贴 Cookie** —— 从浏览器 DevTools → Application → Cookies → 复制 `weread.qq.com` 全部 Cookie → 命令面板「微信读书: 导入 Cookie 登录」粘贴一次即可
- 🛡️ Cookie 通过 VSCode `SecretStorage` 加密存储到本地系统钥匙串，**不上传任何远端**

### 体验细节

- 🎨 完全使用 `--vscode-*` 主题变量，浅色 / 深色无缝切换
- 🧰 顶栏内置「刷新书架」「导入 Cookie 登录」「退出登录」「清除在读缓存（卡死时用）」按钮
- 🔬 命令面板 `微信读书: 诊断当前章节(导出 HTML/CSS)` 一键导出当前章节 HTML/CSS 到临时文件，方便排错

---

## 📦 安装

### 通过编辑器内市场安装

- **Cursor / VSCodium / Gitpod**：扩展面板搜索 `weread` 即可
- **原版 VSCode**：在 `settings.json` 加上下面两行后重启，再搜索 `weread`
  ```json
  {
    "extensions.gallery.serviceUrl": "https://open-vsx.org/vscode/gallery",
    "extensions.gallery.itemUrl": "https://open-vsx.org/vscode/item"
  }
  ```

### 通过 vsix 离线安装

1. 到 [Releases](https://github.com/Weichuandong/weread-vscode/releases) 下载最新 `weread-vscode-x.x.x.vsix`
2. VSCode → 扩展面板 → 右上 `…` → **从 VSIX 安装…**
   或命令行：`code --install-extension weread-vscode-x.x.x.vsix`

---

## 🚀 使用

1. 安装后点击 Activity Bar 左侧的 📖 微信读书 图标
2. **登录**：命令面板（`Cmd+Shift+P`）→ `微信读书: 导入 Cookie 登录` → 粘贴 Cookie
   - Cookie 获取：浏览器登录 [weread.qq.com](https://weread.qq.com) → DevTools → Application → Cookies → 全选 `weread.qq.com` 域下所有 Cookie 复制
   - 也可侧栏登录卡上的「导入 Cookie」按钮
3. 书架加载后，点任意书进入阅读
4. 阅读页：
   - 顶部 ← / → 翻章节
   - 中部章节正文，inline 看高亮划线，**点高亮段**查看对应想法
   - 底部点章节名打开**目录抽屉**；点想法/划线/书评图标打开**社交抽屉**
5. 顶栏命令：刷新书架 / 切登录账号 / 清除在读缓存（极少数情况下章节卡住时使用）

---

## 🧭 命令一览

| 命令 ID | 标题 |
|---|---|
| `weread.importCookie` | 微信读书: 导入 Cookie 登录 |
| `weread.logout` | 微信读书: 退出登录 |
| `weread.refreshBookshelf` | 微信读书: 刷新书架 |
| `weread.openBook` | 微信读书: 打开书籍 |
| `weread.openInBrowser` | 微信读书: 在浏览器中打开 |
| `weread.resetReadingState` | 微信读书: 清除在读缓存(卡死时使用) |
| `weread.diagnoseChapter` | 微信读书: 诊断当前章节(导出 HTML/CSS) |

---

## ⚙️ 配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `weread.requestTimeout` | number | `15000` | HTTP 请求超时时间（毫秒） |
| `weread.userAgent` | string | macOS Chrome 120 UA | 自定义请求 User-Agent |

---

## ⚠️ 免责声明

- 本插件**仅供个人使用**，不得用于商业用途、批量抓取或公开分发付费内容
- 微信读书的接口、签名算法、加密算法**版权归腾讯所有**，本插件不对接口稳定性、版权合规性、账号安全做任何承诺
- 使用本插件即表示你已阅读并同意 [微信读书服务条款](https://weread.qq.com/)，**因使用本插件产生的任何账号封禁、版权纠纷、数据丢失由使用者自行承担**
- 章节内容解密相关实现仅出于互操作目的研究，**请勿用于绕过付费内容的版权保护**。付费章节请到正版渠道购买阅读
- 本项目不存储、不上传你的 Cookie 或阅读数据到任何第三方服务器，所有 HTTP 请求直接面向 `weread.qq.com`

---

## 🙏 致谢

- 章节内容接口、签名与解密算法实现，参考了 [touchFish](https://github.com/ylw1997/touchFish) 等优秀开源项目
- 感谢微信读书提供这么棒的阅读体验

---

## 🐛 反馈 & 贡献

- Bug / 建议：[GitHub Issues](https://github.com/Weichuandong/weread-vscode/issues)
- PR 欢迎，但请先开 issue 沟通避免重复工作
- 想为本插件发布新版本？参见 [发布流程文档](RELEASING.md)

---

## 📄 License

[MIT](LICENSE) © weichuandong
