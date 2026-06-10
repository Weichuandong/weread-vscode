# TouchPlus for VSCode

> 在 VSCode 侧边栏看书 + 刷推荐流的双模块"摸鱼"套件。微信读书、知乎一个插件搞定，**零跳转、零打扰、零上传**。

[![Version](https://img.shields.io/badge/version-2.0.1-blue.svg)](https://github.com/Weichuandong/weread-vscode/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## 🌟 为什么选 TouchPlus

> 市面上同类插件不少，但下面这些是 TouchPlus 真正不同的地方。

| 亮点 | 一句话 |
|---|---|
| 🧩 **一插双模块** | 微信读书 (Folio) + 知乎 (Curio) 共享同一份代码框架，Activity Bar 一边一个图标，不用装两个插件 |
| 🪟 **原生侧栏 inline 阅读** | 章节正文直接在 VSCode webview 里渲染，**不开 iframe、不跳浏览器**，看着像在读文档，老板路过零破绽 |
| 🤫 **零打扰静默 UX** | Cookie 失效不弹 toast / modal，只在 view 顶部挂一条被动 banner，点"重新导入"即可，再也不用一直点关闭弹窗 |
| 📡 **完整离线能力** | 微信读书章节预缓存层（内存 LRU + 磁盘持久化），翻章自动后台静默预拉后续 N 章，**cookie 过期/断网/飞机上仍能继续看** |
| ☁️ **真实云端进度同步** | 翻章 / 进度直走微信读书官方接口，与手机端 / 网页端**实时互通**，换设备无缝接续 |
| 🔐 **隐私优先** | Cookie 通过 VSCode `SecretStorage` 加密存储到系统钥匙串，**从不上传任何第三方服务器**，所有 HTTP 直连原站 |
| 🎨 **5 维排版自定义** | 字号 / 行距 / 段距 / 页宽 / 字体五个维度共 20 档，CSS 变量驱动**零闪烁**实时切换，每个人都能找到自己的阅读舒适区 |
| 🚫 **智能四层去重（知乎）** | session_token 轮替 + read 上报 + 会话内 Set + 持久化 targetKey，刷推荐流**不重不漏**，跨重启都不会刷到看过的 |
| 💡 **精准想法 popover** | 微信读书正文 inline 划线点击后，按 weread 字符 offset range 精准拉对应想法（而非全章 markText 模糊匹配），命中率显著提升 |
| ⌨️ **键盘党友好** | 阅读页 ↑/↓/PgUp/PgDn/Space 翻页，←/→ 切章，Home/End 跳本章首尾，**视线不离正文** |
| 🍃 **摸鱼细节** | 图片默认关闭（同事路过看不到知乎封面图），A-/A+ 调字号，分段加载长回答，开关一律持久到 workspaceState 不同项目可不同 |
| 🩺 **诊断工具齐全** | `weread.diagnoseCookie` 现场实测 Cookie 续命健康度，`weread.chapterCacheStats` 下钻浏览缓存，排障不靠猜 |

---

## ✨ 功能模块

### 📖 Folio — 微信读书

在 VSCode 侧边栏阅读微信读书：书架 / 章节目录 / 正文 / 想法划线书评 / 云端进度多端同步。

#### 书架

- 顶部双 Tab 切换：「**书架**」/「**在读**」
- 书架按照你在微信读书 APP 里自建的「分组（archive）」分桶展示
- 支持 **单组折叠/展开**、**全部展开**、**全部折叠**，分组折叠状态本地持久化
- 「在读」列表来自微信读书云端最近阅读

#### 阅读器

- 章节正文直接在 VSCode 侧栏内 inline 渲染（不开 iframe，不跳浏览器）
- **图片后端代理** —— 章节内 `<img>` / SVG 走 axios + Cookie + 正确 Referer 拉成 base64 dataURL 内嵌
- **图片缓存** —— 同一张图按 URL 缓存为 Promise，章节二次进入不会重复下载
- **两阶段渲染** —— 先发无图骨架快速可读，再发完整图文版回填
- **HTML entity 反解** —— 微信读书部分章节实体转义字符串渲染前自动反解
- **脚注图标 CSS 化** —— 不依赖远端 PNG，CSS 伪元素画圆圈
- **上一章 / 下一章** 按钮按目录顺序翻页，状态走云端同步

#### 章节预缓存

- 💾 **本地缓存 + 后台预拉** —— 翻章时自动后台预拉后续 N 章到本地，cookie 过期/断网仍能继续看
- ⚙️ **灵活配置** —— `weread.configurePrefetch` 命令设置前后预缓存章数，两端填 0 即关闭
- 📊 **可视化浏览** —— `weread.chapterCacheStats` 下钻查看每本书缓存了哪些章节
- 🗑️ **一键清空** —— `weread.clearChapterCache` 清空全部缓存

#### 排版偏好

- 🎨 **5 维可调** —— 字号(7档)、行距(3档)、段距(3档)、页宽(4档)、字体(黑体/宋体/等宽/编辑器)，CSS 变量驱动实时生效

#### 目录 / 社交抽屉

- 右侧滑出目录抽屉，长目录支持搜索过滤，自动定位高亮当前章节
- 社交抽屉三 Tab：「**想法**」「**划线**」「**书评**」，数据来自微信读书云端

#### 正文 inline 划线 + 想法 popover

- 正文热门划线直接 inline 高亮（按 weread 字符 offset range 切片注入）
- 点击高亮段弹出 popover，按 range 精准拉对应想法

#### 同步 & 登录

- ☁️ **云端进度同步** —— 章节切换、读到哪里都走微信读书接口，与手机/网页端实时互通
- 🔐 **唯一登录方式：粘贴 Cookie** —— 浏览器 DevTools → Application → Cookies → 复制 `weread.qq.com` 全部 Cookie → 命令面板粘贴一次
- 🛡️ Cookie 通过 VSCode `SecretStorage` 加密存储到本地系统钥匙串，不上传任何远端

---

### 🧩 Curio — 知乎推荐流

在 VSCode 侧边栏刷知乎推荐流：卡片式浏览、就地展开阅读、智能去重。

#### 推荐流浏览

- 📋 **卡片式展示** —— 标题、摘要、作者一目了然，点击展开正文
- 📖 **分段加载** —— 长回答每次显示 N 字符（可配），看完再点"继续阅读"
- 🎬 **视频/专栏** —— 点击自动跳浏览器打开
- 🔄 **刷新推荐流** —— 顶栏按钮一键刷新

#### 智能去重

- 🚫 **四层去重** —— session_token 轮替 + read 上报 + 会话内 Set + 持久化 targetKey，翻页不重不漏
- 🧹 **已读历史** —— `zhihu.clearReadHistory` 清空跨重启去重记录，推荐流从头来过

#### 登录

- 🔐 **粘贴 Cookie** —— 复制知乎 Cookie（`z_c0` 长期令牌），命令面板粘贴登录
- 🛡️ SecretStorage 安全存储

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

### Folio（微信读书）

1. 点击 Activity Bar 左侧 📖 图标
2. 命令面板 `Folio: 导入 Cookie 登录` → 粘贴 Cookie
3. 书架加载后，点任意书进入阅读
4. 阅读页：
   - 顶部 ← / → 翻章节
   - 中部章节正文，inline 看高亮划线，点高亮段查看想法
   - 底部点章节名打开目录抽屉；点想法/划线/书评图标打开社交抽屉

### Curio（知乎）

1. 点击 Activity Bar 左侧 💡 图标
2. 命令面板 `Curio: 导入 Cookie 登录` → 粘贴 Cookie
3. 推荐流自动加载，点击卡片展开正文
4. 看完了点"继续阅读"加载下一段

---

## 🧭 命令一览

### Folio（微信读书）

| 命令 ID | 标题 |
|---|---|
| `weread.importCookie` | Folio: 导入 Cookie 登录 |
| `weread.logout` | Folio: 退出登录 |
| `weread.refreshBookshelf` | Folio: 刷新书架 |
| `weread.openBook` | Folio: 打开书籍 |
| `weread.openInBrowser` | Folio: 在浏览器中打开 |
| `weread.resetReadingState` | Folio: 清除在读缓存(卡死时使用) |
| `weread.diagnoseChapter` | Folio: 诊断当前章节(导出 HTML/CSS) |
| `weread.diagnoseCookie` | Folio: 诊断 Cookie 续命健康度 |
| `weread.chapterCacheStats` | Folio: 查看已缓存章节 (下钻浏览) |
| `weread.configurePrefetch` | Folio: 章节预缓存配置 (开关/章数) |
| `weread.clearChapterCache` | Folio: 清空章节缓存 |

### Curio（知乎）

| 命令 ID | 标题 |
|---|---|
| `zhihu.importCookie` | Curio: 导入 Cookie 登录 |
| `zhihu.logout` | Curio: 退出登录 |
| `zhihu.refreshRecommend` | Curio: 刷新推荐流 |
| `zhihu.openInBrowser` | Curio: 在浏览器中打开 |
| `zhihu.clearReadHistory` | Curio: 清空已看过记录 |

---

## ⚙️ 配置

### Folio（微信读书）

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `weread.requestTimeout` | number | `15000` | HTTP 请求超时时间（毫秒） |
| `weread.userAgent` | string | macOS Chrome 120 UA | 自定义请求 User-Agent |
| `weread.checkForUpdates` | boolean | `true` | 启动时检查 Open VSX 是否有新版本 |
| `weread.chapterPrefetch.enabled` | boolean | `true` | 是否开启章节预缓存 |
| `weread.chapterPrefetch.ahead` | number | `10` | 向后预缓存的章节数 (0~50) |
| `weread.chapterPrefetch.behind` | number | `1` | 向前预缓存的章节数 (0~10) |

### Curio（知乎）

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `zhihu.requestTimeout` | number | `15000` | 知乎 HTTP 请求超时时间（毫秒） |
| `zhihu.userAgent` | string | macOS Chrome 120 UA | 自定义请求 User-Agent |
| `zhihu.pageSize` | number | `6` | 推荐流每页拉取条数 |
| `zhihu.reportRead` | boolean | `true` | 是否向知乎上报"已读"（去重用） |
| `zhihu.readChunkSize` | number | `400` | 展开正文时每次显示的字符数 |

---

## ⚠️ 免责声明

- 本插件**仅供个人使用**，不得用于商业用途、批量抓取或公开分发付费内容
- 微信读书 / 知乎的接口、签名算法、加密算法**版权归各自平台所有**，本插件不对接口稳定性、版权合规性、账号安全做任何承诺
- 使用本插件即表示你已阅读并同意各平台的服务条款，**因使用本插件产生的任何账号封禁、版权纠纷、数据丢失由使用者自行承担**
- 本项目不存储、不上传你的 Cookie 或阅读数据到任何第三方服务器，所有 HTTP 请求直接面向目标平台

---

## 🙏 致谢

- 章节内容接口、签名与解密算法实现，参考了 [touchFish](https://github.com/ylw1997/touchFish) 等优秀开源项目
- 感谢微信读书和知乎提供优质的内容平台

---

## 🐛 反馈 & 贡献

- Bug / 建议：[GitHub Issues](https://github.com/Weichuandong/weread-vscode/issues)
- PR 欢迎，但请先开 issue 沟通避免重复工作
- 发布新版本？参见 [发布流程文档](RELEASING.md)

---

## 📄 License

[MIT](LICENSE) © weichuandong