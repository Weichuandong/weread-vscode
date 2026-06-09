# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)，所有重要变更都会记录在这里。

## [2.0.0] - 2026-06-09

> **重大版本：模块化架构重构 + 新增知乎摸鱼模块 + 微信读书章节预缓存。**

### Added

#### 知乎摸鱼模块 (Curio)
- 🆕 **全新知乎推荐流** —— 独立的 Activity Bar 图标 `Curio`，在 VSCode 侧边栏刷知乎推荐流
- 🔐 **知乎 Cookie 登录** —— 粘贴知乎 Cookie（`z_c0` 长期令牌），通过 SecretStorage 安全存储
- 📋 **推荐流卡片** —— 可展开/折叠的卡片式布局，显示标题、摘要、作者，点击展开正文
- 📖 **分段阅读** —— `zhihu.readChunkSize` 配置，长回答每次显示 N 字符，看完再点"继续阅读"加载下一段
- 🎬 **视频/专栏链接** —— 点击自动跳浏览器；纯文本/图片类回答就地展开
- 🚫 **四层去重** —— session_token轮替 + read 上报 + 会话内 Set + 持久化 targetKey，翻页不重不漏
- 🧹 **已读历史管理** —— `zhihu.clearReadHistory` 命令，清空跨重启的去重记录，推荐流从头来过
- ⚙️ **知乎专属配置** —— `zhihu.requestTimeout` / `zhihu.userAgent` / `zhihu.pageSize` / `zhihu.reportRead` / `zhihu.readChunkSize`

#### 微信读书章节预缓存 (Folio)
- 💾 **本地章节缓存** —— `ChapterCache` 层 (内存 LRU + 磁盘持久化)，趁 cookie 有效时后台静默预拉后续章节，cookie 过期/断网后仍能继续阅读
- ⚡ **智能预缓存策略** —— 翻到某一章时自动 `prefetchAround`：向后预拉 N 章 + 向前预拉 M 章（离散输入框配置），串行拉取不压服务器，切书自动 cancel
- 📊 **缓存可视化** —— `weread.chapterCacheStats` 命令，两级 QuickPick 下钻浏览：Level 1 按占用倒序列所有缓存书，Level 2 按目录顺序展示每本书的各章节（标题/大小/时间），支持就地清理整本
- ⚙️ **预缓存配置 UI** —— `weread.configurePrefetch` 命令，连续两个 InputBox 分别设 ahead/behind 章数，两端填 0 自动判定关闭；也嵌入「查看缓存」面板顶部快捷入口
- 🗑️ **缓存清理** —— `weread.clearChapterCache` 清空全部；`chapterCacheStats` 下钻面板内可清空单本
- 📁 **离线章节目录** —— `ChapterCache.loadOfflineChapters()` 仅在 _meta.json 快照重建目录，cookie 失效时 reader 仍能展示章节抽屉、翻已缓存章节
- 📝 **缓存元信息** —— 每本缓存书自动维护 `_meta.json`（书名/作者/章节标题/目录顺序），即使缓存了百来章也能按真实书中目录顺序展示

#### 阅读偏好设置 (Folio)
- 🎨 **排版偏好** —— 字号(7档)、行距(3档)、段距(3档)、页宽(4档)、字体(黑体/宋体/等宽/编辑器) 五个维度，全部离散档位，CSS 变量驱动实时更新，零闪烁

#### 微信读书诊断工具增强
- 🏥 **Cookie 健康诊断** —— `weread.diagnoseCookie` 新增现场实测 `/web/login/renewal`，一次诊断能力项完整性检测（wr_vid/wr_skey/wr_rt）+ 续命实测
- 🩺 **renewal 死锁检测** —— `client.isRenewalDead()` 检测到 cookie 被 server 彻底判死后自动停止心跳，跳提示引导用户重新导入

### Changed
- 🏗️ **模块化架构重构** —— 引入 `src/core/` 框架层 (`Module` / `ModuleContext` / `ModuleRegistry`)，把微信读书从单块 `extension.ts` 拆到 `src/modules/weread/`，知乎新增到 `src/modules/zhihu/`；`extension.ts` 精简为启动器 (10 行)。新增模块只需实现 `Module` 接口 → 注册到 `ALL_MODULES` → 在 `package.json` 里贡献视图/命令/配置
- 🔄 **扩展重命名** —— 从 `weread-vscode` / `TouchPlus for VSCode` 升级为双模块套件：Activity Bar 分图标 `Folio`(微信读书) + `Curio`(知乎)
- ♻️ **文件结构重组** —— 微信读书所有代码从 `src/api/` / `src/auth/` / `src/services/` / `src/views/` 统一搬入 `src/modules/weread/` 同名子目录下
- 🔧 **Cookie 保活增强** —— 从纯 HEAD / 兜底升级为 `POST /web/login/renewal` 主力 + HEAD / 兜底的双路径策略，聚焦续+定时续(5min)双重触发，节流阈值 2min
- 🧹 **知乎去重持久化** —— 跨 VSCode 重启的去重集合存到 `globalState`，不再每次重启都重新刷一遍已经看过的内容

### Fixed
- 🩹 知乎推荐流翻页大量重复 —— 新增 session_token 轮替 + read 上报 + 双重 Set 去重

### Removed
- ❌ 旧 `src/auth/AuthService.ts` 顶部单文件（已迁移到 `src/modules/weread/auth/AuthService.ts`），无功能删除

## [1.0.2] - 2026-06-05

### Added
- 🔔 **启动检查新版本** —— 本插件未发到微软 VS Code Marketplace（只发了 Open VSX），原版 VSCode 安装 vsix 后自身不会推升级。新增 [`src/services/UpdateChecker.ts`](src/services/UpdateChecker.ts) 在 `activate()` 末尾异步调一次 `https://open-vsx.org/api/weichuandong/weread-vscode/latest`，跟当前 `package.json` version 做 semver 比对，有新版弹通知三按钮「查看新版 / 不再提醒此版本 / 稍后再说」，点击「查看新版」直接打开 GitHub Releases 最新页下 vsix
- ⚙️ **配置项 `weread.checkForUpdates`** —— 默认 `true`，不想被打扰可在设置里关掉
- 网络失败 / 超时 / 接口异常一律静默，不阻塞启动

## [1.0.1] - 2026-06-05

### Docs
- 📖 **README 功能描述刷新到与代码一致** —— 重写功能特性章节: 准确列出书架双 Tab / 分组折叠 / 阅读器图片代理 + 缓存 + 两阶段渲染 / entity 反解 / 脚注 CSS 化 / 翻章节 / 目录抽屉 / 想法-划线-书评三 Tab 抽屉 / 正文 inline 划线 + 按 range 拉想法 popover; 修正登录方式段(原"三种登录" → "唯一 Cookie 登录"); 补全命令面板一览表; Releases / Issues 链接修正到正确大小写 `Weichuandong/weread-vscode`

## [1.0.0] - 2026-06-05

> 首个正式版。在 0.0.4 公开 Beta 之上完成了一轮渲染管线重构 + 登录方式收敛，行为稳定可日常使用。

### Fixed
- 🖼️ **章节图片无法显示** —— 加入图片后端代理: 把章节 HTML 内 `<img src="https://...">` (含 SVG `<image xlink:href>`) 走 axios + cookie + 正确 Referer 拉成 base64 dataURL 内嵌，绕开 weread CDN 防盗链(`res.weread.qq.com` 等)与 webview CSP 限制
- 🧩 **章节图片显示一段后突然变成一长串 base64 文本** —— 根因是渲染管线顺序错位: `loadCurrentChapter` 内同步把图换 base64 → HTML 膨胀几百 KB → `injectHotUnderlinesIntoHtml` 按 weread API 的字符偏移 range 切片时，切到 base64 字符串中间，破坏 `<img>` 标签结构，后半段 base64 + 属性被浏览器当文本节点渲染。修复: 新增 `preparedChapterHtml` 缓存 + `prepareChapterHtml` 异步流水线，严格顺序 `decode → injectUnderlines → sanitize → transformFootnotes → rewriteImage`；`buildReaderHtml` 双层渲染(无图首屏快 → 完整版回填)
- 💬 **划线 popover 一直空** —— `getReadReviewsByRange` 之前用 GET `/web/review/list`，weread 实际生效的是 POST `/web/book/readReviews`(touchFish 同款，结构 `reviews[].pageReviews[].review`)，改正后 popover 正常显示对应段落想法
- 🖼️ **正常文字章节被误判成"图片章节"** —— 删掉 `looksLikeImageOnlyChapter` 占位卡兜底逻辑，正文统一走 inline pipeline
- 📝 **章节文字变成 `<p>` 字面量** —— 微信读书部分章节 HTML 是整段被 HTML entity 转义过的字符串(`&lt;p&gt;`)，新增 `decodeEntityEscapedHtmlIfNeeded` 在渲染前反解，章节图片也能被浏览器正确识别为标签
- 🔖 **正文里没有"热门划线"** —— 之前用 `/web/book/bestbookmarks`，但该接口大多数情况下不返回 `range` 字段导致所有划线被跳过。改成同时调用 touchFish 实测在用的 `/web/book/underlines`(`range` 稳定 + `count` 直观)，两接口结果按 range 去重合并喂给注入
- 🔣 **脚注图标显示为黑色空白** —— 不再依赖 `cdn.weread.qq.com/...zhu_black.png` 远程 PNG (任何 CDN/CSP/网络环节卡住都会黑空白)，改用纯 CSS 画圆圈 + 字符 `i` 的伪元素方案，零网络依赖，自动跟随 VSCode 主题前景色

### Added
- ⚡ **图片 dataURL 缓存** —— `WereadClient.imageDataUrlCache: Map<url, Promise<dataURL|null>>`，章节二次渲染不再重复下载同一张图
- 🎯 **点击划线按需弹想法** —— inline popover 终于走 `getReadReviewsByRange` 按 range 单独拉，命中精准(此前 popover 在全章 reviews 里用 indexOf 命中 markText，underlines 接口没 markText 时直接落空)
- 📊 **章节社交数据加载诊断日志** —— DevTools Console 直接输出三路数据条数(`reviews / bestbookmarks / underlines`)，便于排查"没看到划线"问题
- 🆕 **章节级 underlines 状态** —— `MainViewProvider.currentChapterUnderlines` 独立保存 `/web/book/underlines` 结果，专门给正文 inline 高亮用，与抽屉里的 `bestbookmarks`(带 `markText`) 分工清晰

### Changed
- `injectHotUnderlinesIntoHtml` 改成接受任意 `{range, markText?}` 对象，内部按 range 去重并优先保留带 `markText` 的条目(`markText` 给 popover indexOf 检索更可靠)
- `getReadReviewsByRange` 接口从 GET `/web/review/list` 切换到 POST `/web/book/readReviews`(touchFish 同款，结构 `reviews[].pageReviews[].review`)

### Removed
- 🧹 **微信扫码登录(Beta)** —— `weread.qrLogin` 命令 / `QrLoginSession` / `buildQrCardHtml` 全部移除。OAuth qrconnect 在实测中频繁被微信开放平台拒，体验不稳定
- 🧹 **浏览器登录助手** —— `weread.browserLogin` 命令 / `startBrowserLogin` / `finishBrowserLogin` / `buildBrowserLoginCardHtml` 全部移除。读剪贴板路径在多种环境下失败
- 🧹 收敛后唯一登录入口: `weread.importCookie`(命令面板 `微信读书: 导入 Cookie 登录` + 侧栏登录卡「导入 Cookie」按钮)，对应配套清理 `AuthService.setCookieString`、QR/Browser 卡 ~110 行 CSS

## [0.0.4] - 2026-06-04

### Added
- 🔐 **微信扫码登录（Beta）** —— 通过微信开放平台 OAuth 拿登录态，免去手动粘贴 Cookie
- 🌐 **浏览器登录助手** —— 一键打开 `weread.qq.com` 登录页 + 一行 `copy(document.cookie)` + 自动读剪贴板导入 Cookie，扫码失败的兜底方案
- 📑 **目录抽屉 UI** —— 阅读时右侧滑出目录抽屉，支持搜索过滤、当前章节高亮 + 自动定位、ESC 关闭、点击外部 backdrop 关闭
- 📖 **顶部 tab 显示当前书名** —— 阅读时顶部"在读"tab 自动显示当前书名（长书名自动 ellipsis 截断）
- 🔽 **底部 footer 集成目录入口** —— 上一章 / 章节名 / 下一章 一行搞定，点击章节名即弹出目录

### Changed
- 阅读区 reader-header 整块移除，纵向多出空间给正文
- footer 中的章节信息从纯文字升级为可点按钮（hover 才显边框）

### Fixed
- 目录抽屉搜索过滤无效的 bug（`.toc-item` 的 `display:block` 覆盖了 UA `[hidden]` 默认样式）

## [0.0.3] - 2026-05-xx

### Added
- 💾 **章节正文真接口对接** —— 改用微信读书 web 端 `/web/book/chapter/e_*`、`/web/book/chapter/t_*` 真接口
- 🔓 **签名 + 解密支持** —— 新增 `wereadSign.ts` (calcHash + sign 算法) 与 `wereadDecrypt.ts`，正确解析加密后的 epub / txt 章节内容
- ☁️ **云端阅读进度** —— 接入 `/web/book/getProgress` + `/web/book/read`，与手机端 / 网页端阅读位置实时同步

### Removed
- ❌ 移除老的 web 静态页面解析 + 字体解密路径（已不再可用）

## [0.0.2] - 2026-05-xx

### Changed
- 🎨 **UI 大改造** —— 删掉旧的 TreeView 实现，整合为单一 `weread.main` Webview
- 📌 顶部 tab 在"书架"/"在读"之间切换
- 📁 书架按用户在微信读书里自建的「archive 分组」分桶，替代书的 `category` 字段
- ⌨️ 书架默认折叠，新增「全部展开 ▾ / 全部折叠 ▸」按钮

## [0.0.1] - 2026-05-xx

### Added
- 🎉 MVP 首版骨架：AuthService / WereadClient / BookshelfProvider / ReaderViewProvider
- 📚 侧边栏书架 TreeView（按服务器 category 展示）
- 📖 阅读 Webview（章节下拉切换 / 上一章 / 下一章 / 浏览器打开）
- 🍪 Cookie 通过 VSCode SecretStorage 安全存储
