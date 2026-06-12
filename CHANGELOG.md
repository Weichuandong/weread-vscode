# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)，所有重要变更都会记录在这里。

## [3.1.0] - 2026-06-12

> **三模块统一升级体验：图片一键放大查看 + 键盘滚动快捷键 + 小黑盒楼中楼分页 + 摸鱼场景去除"在浏览器打开"按钮。** 同时修复知乎正文图片在 `<figure><noscript>` 结构下重复显示的 bug，新增小黑盒"被动发现全新板块"通知。

### Added — 三模块共享 (新增 `src/core/` 公共组件)

- 🔍 **图片一键放大查看器** —— 新增 [`src/core/imageLightbox.ts`](src/core/imageLightbox.ts) 公共组件，weread / zhihu / xiaoheihe 三模块全部接入。任意可放大图片点击后弹模态层：
  - **滚轮缩放**，以鼠标位置为缩放原点（PDF 阅读器同款体验）
  - **拖拽平移**（放大态下 `cursor: grab`），**双击切换 1x ↔ 2x**
  - **工具栏**：关闭 × / 缩小 − / 还原 ⤢ / 放大 + ；**键盘**：Esc 关 / +/- 缩放 / 0 还原 / ←/→ 上下张
  - **左下"缩放百分比"提示** + **顶部"X / N"计数**，同帖多图时清晰知道在第几张
  - **智能黑名单**：头像 / 小封面 / 工具按钮图标 / 脚注小图标 / `data-no-lightbox` / 自然尺寸 < 60px 一律跳过，避免误触
  - **CSP 兼容**：纯 `addEventListener`、无 inline 事件 / 无外链资源，在 zhihu / xiaoheihe 的 `script-src 'nonce-xxx'` 严格策略下也能跑
- ⌨️ **键盘滚动快捷键** —— 新增 [`src/core/keyboardScroll.ts`](src/core/keyboardScroll.ts) 公共组件，三模块统一接入：
  - **↑ / ↓** 平滑滚动一段固定距离（100px，约 4-5 行正文）—— "小步走" 体感，跟 webview 原生方向键滚动手感接近但走 smooth 平滑过渡
  - **Space** 平滑滚到 *最底部*（长贴快速跳到评论尾巴）
  - **Shift + Space** 平滑滚到 *最顶部*（跟 Web 端 PageDown / PageUp 一对的直觉）
  - **自动让位**：焦点在 input / textarea / contentEditable / 带 Ctrl/Meta/Alt 修饰键 / lightbox 模态打开中 / weread 阅读 tab（有更精细的章节切换逻辑）—— 一律不抢

### Added — Arena (小黑盒)

- 💬 **楼中楼（子评论）分页展示** —— 主评论原本只显示"💬 N 条回复"提示，现在直接渲染服务端预加载的前 N 条子评论（缩进 + 左竖线 + 头像/正文略小拉开层级感）；超出预加载部分挂"💬 查看更多回复 (X/N)" 按钮，点击走 [`fetchSubCommentsPage`](src/modules/xiaoheihe/api/XiaoheiheClient.ts:836-921) 游标接口 `/bbs/app/comment/sub/comments` 分页累加：
  - 新增类型 [`XiaoheiheSubCommentsPage`](src/modules/xiaoheihe/types/index.ts:571-578) + [`XiaoheiheCommentForView.children`](src/modules/xiaoheihe/types/index.ts:546-549) / `hasMoreChildren` 字段
  - 游标分页：`lastVal` 传容器内最后一条 commentId，服务端返回严格大于该游标的下一批 append 到末尾
  - 失败容错：reqId 路由按"楼-加载按钮"粒度独立维护（`subCommentReqIdMap`），切板块/折叠卡片时回包过期直接丢弃；加载失败按钮文案改"加载失败, 点击重试"
- 🔔 **被动发现全新板块通知** —— 用户浏览过程中服务端 `link.topics[]` 出现 BUILTIN_SECTIONS 没收录、字典里也没有的全新板块时，攒一波（**3s debounce 合并多次累积** + **30 分钟冷却**避免打扰）后弹一条 information："发现新板块 XX、YY、ZZ ... 等 N 个, 是否切换查看?"，点"切换查看"直接进入 `xiaoheihe.switchToTopic` QuickPick 限定本次新发现的板块

### Changed — Arena (小黑盒)

- 🚪 **移除详情区"在浏览器打开"按钮** —— 卡片就地展开后底部 `actions` 区不再放"在浏览器打开"按钮（**摸鱼场景禁忌**，老板路过侧栏弹出全屏知乎更刺激）；详情区无正文的视频/图集帖文案也去掉"可点 在浏览器打开 查看"引导，改为简洁的"该帖子无正文文本 (可能是视频或图集帖)"

### Fixed — Curio (知乎)

- 🖼️ **正文同一张图重复渲染** —— 知乎正文 HTML 内 `<figure>` 常见形态是 `<noscript><img src="小图缩略"></noscript>` + 同级 `<img src="小图" data-original="大图">`。此前 [`stripHtmlPreserveBreaks`](src/modules/zhihu/api/ZhihuClient.ts:1053-1100) 没剥 noscript，主 `<img>` 命中 `data-original` 正则生成 `[IMG:大图]`、紧接着 noscript 内的 `<img src>` 又命中第二个正则生成 `[IMG:小图]`，同一张图被渲染成两个 inline-img 节点（webview 上视觉重复）。现修复为：
  - **先剥 noscript 整段** —— `<noscript>` 本是给禁用 JS 环境的回退，webview 里有 JS 不需要
  - **兜底合并相邻同 url 占位符** —— 严格"完全相邻 + 完全同 url"才合并（`/(\[IMG:[^\]]+\])(\s*\1)+/g`），避免误杀业务里"故意贴两次同图"的极端场景

### Removed

- ❌ **`xiaoheihe.openInBrowser` 命令** —— v3.0.0 卡片就地展开 + 评论分页落地后该命令实际已无入口（详情区也已去除按钮），从 [`package.json`](package.json) `contributes.commands` 移除该条目；旧用户配置自动忽略不报错

## [3.0.0] - 2026-06-11

> **小黑盒 (Arena) 模块大升级：133 个内置板块 + 主页本地混排 + 卡片就地展开 + 评论分页 + 登录态个性化推荐。** 同时移除 v2.x 草稿态的"手写自定义板块"配置，统一改走"反馈到内置池"路径，避免乱填 tag 触发服务端风控。

### Added — Arena 模块 (重头戏)

#### 多板块体系
- 🎮 **133 个内置板块** —— [`BUILTIN_SECTIONS`](src/modules/xiaoheihe/types/index.ts:130-285) 一次性硬编码：
  - **17 个英文 slug 板块**：守望先锋 / 三角洲行动 / CS:GO / APEX / 英雄联盟 / 绝地求生 (6 个 vscode-maxPlus 原版同款) + 原神 / 永劫无间 / 无畏契约 / DOTA2 / 艾尔登法环 / 和平精英 / GTA5 / 暗黑破坏神4 / 星穹铁道 / 鸣潮 / 其它
  - **116 个话题派生板块**：来源是用户 2026/06 运行时累积的 `xiaoheihe.topicMap` 字典，命名 `t<topicId>`、tag 用 `topic_<topicId>` 兜底；覆盖星露谷、博德 3、赛博 2077、黑神话悟空、怪物猎人荒野、雀魂、王者荣耀，连"沙雕日常 / 校园生活 / 杂谈吐槽"非游戏板块一并收录
- ⚙ **tab 栏 + 设置面板** —— 顶部 tab 栏只展示用户启用的板块；右上 ⚙ 按钮打开侧边设置面板，复选框勾选内置板块即时生效，关闭后从 tab 栏移除（数据不丢，重新勾回自动恢复）
- 🔎 **`xiaoheihe.switchToTopic` 命令** —— QuickPick 模糊搜索全部内置板块 + 运行时累积的话题字典；选中后自动 push 进 `enabledSections` 并切过去，比 ⚙ 勾选更快一步直达
- 📤 **`xiaoheihe.dumpTopicMap` 命令** —— 把当前自动累积的 topicMap 字典输出到 VSCode 新文档（JSON + Markdown 双格式），方便反馈给作者补进下个版本的 BUILTIN_SECTIONS

#### 主页推荐流
- 🏠 **`home` tab (主页) 永远在第一位** —— 不可禁用，避免空 tab；用户没启用任何其它板块时也至少有一条流
- 🔀 **本地混排策略 (`xiaoheihe.homeMixStrategy`)**：
  - `roundrobin` (默认) —— 按启用板块依次轮询取一条，循环拼到目标条数，"雨露均沾"
  - `interleave` —— 每个板块取整页后按顺序穿插，"每个板块给我看几条连续的"
- 🎯 **登录后切官方个性化推荐** —— `home` 在登录态下直接走小黑盒 `/bbs/app/feeds/news` 接口，按用户画像排序，效果与官方 APP 首屏一致；未登录降级为本地混排
- 🧩 **单板块 tab 也用官方推荐流** —— 登录态下单板块走 `/bbs/app/topic/feeds?topic_id=` 个性化推荐，未登录走 APP `tag` 路径按时间序

#### 卡片就地展开
- 📋 **卡片视图** —— 封面 + 标题 + 摘要 + 作者 + 标签 + 评论/点赞数 + 发布时间；视频帖角标 ▶；home 混排时显示来源板块角标"来自 守望先锋"
- 📖 **正文 inline 展开** —— 点卡片在侧栏内就地展开（不跳浏览器），图文混排，`[IMG:url]` 占位符按原位渲染；展开后**标题 sticky 置顶**贴在 tab-bar 下方（参照 zhihu 的体验，ResizeObserver 同步高度）
- 💬 **评论分页** —— "查看评论 (N)" 按钮加载主楼层，每页 N 条，"加载更多"按服务端分页累加；含用户名 / 头像 / 等级 / 点赞 / IP 属地 / 楼层号 / 楼中楼条数提示
- 🖼️ **图片摸鱼默认关 + 一键开图** —— 卡片图、正文图、评论图全部默认隐藏占位符（老板路过零暴露），工具栏 🖼️ 按钮一键全局切换
- 🔄 **滚到底自动加载** —— 距底 200px 自动追加；会话内 `linkId` 去重，服务端偶发重复也只显示一次

#### 签名 / 鉴权
- 🔏 **APP 协议** —— [`utils/sign.ts`](src/modules/xiaoheihe/utils/sign.ts) 内置 HMAC-SHA512 + CRC32 算法（参考 vscode-maxPlus），伪 `imei` 自动生成并持久化
- 🔐 **Web 协议 v2.2.4 `ov` hash** —— [`utils/webSign.ts`](src/modules/xiaoheihe/utils/webSign.ts) 实现 Nuxt bundle 逆向后的新版 hash 算法，通过官方 3 个 test case + 真实抓包验证；登录态下优先走 web 协议拿个性化推荐流
- 🛡️ **signedGetLinkTree helper** —— 登录态优先 web、`captcha`/网络错误不 fallback，仅"非法请求"/"登录态被拒"回落 APP 匿名，避免接口异常时盲目降级丢登录权益

#### 登录
- 🔐 **`xiaoheihe.importCookie` / `xiaoheihe.logout`** —— 粘贴 `pkey` / `heybox_id` cookie 登录、退出登录命令，登录态通过 `SecretStorage` 加密存储
- 🛠 **`xiaoheihe.api.cookieInjectMode` 配置** —— `header` (默认) / `query` (早期 APP 风格兜底) / `off` (强制匿名排障)，接口报"非法请求"时切 `off` 立刻恢复匿名内容
- 🔄 **`xiaoheihe.resetImei` 命令** —— 重置伪设备 ID，解小黑盒服务端风控

#### 板块字典累积
- 📊 **自动累积 topicMap** —— 每次 `fetchTopicRecommendFeed` / `fetchRecommendFeed` / `fetchHomeFeed` 返回 link 数组后，旁路扫描 `link.topics[]` 把"中文板块名 → topicId/picUrl/appId/gameType" 写进 globalState `xiaoheihe.topicMap` 字典
- 🔁 **字典反查 fallback** —— `fetchFeed` 找不到硬编码 topicId 时反查字典，用得越多字典越完整，越多板块自动获得"推荐流"待遇
- 📤 **`xiaoheihe.dumpTopicMap` 命令导出** —— 一键把字典输出到 VSCode 新文档 (JSON + Markdown 双格式) 供反馈

### Changed — Arena

- 🏗️ **类型从 `XiaoheiheGameId` 升级为 `XiaoheiheSectionId`** —— 旧 union literal `'ow' | 'sjz' | ...` 改为 `string` 接纳运行时发现的板块；`XiaoheiheGameMeta` / `GAMES` 等旧名保留为 `@deprecated` alias 平稳过渡
- ⚙ **配置项重命名** —— `xiaoheihe.defaultGame` → `xiaoheihe.defaultSection` (语义升级为"板块"而非"游戏"，默认值从 `"ow"` 改为 `"home"`)
- 🏠 **首屏默认显示 `home` 而不是某个具体游戏** —— 新用户开箱即得本地混排流，而不是某一款游戏的单板块流
- 🔄 **`xiaoheihe.switchGame` 命令保留但分流** —— 仍可 QuickPick 切板块，新增 `xiaoheihe.switchToTopic` 提供"含字典发现板块"的全集搜索入口

### Removed — Arena

- ❌ **`xiaoheihe.customSections` 配置项** —— v2.x 草稿态曾允许用户手写 `{id, label, tag}` 数组自定义板块，实际使用中**普通用户根本猜不到 tag 是 'overwatchtwo' 还是 'topic_611472'**，乱填触发服务端"非法请求"。v3.0.0 直接移除该配置项 (旧用户配置自动忽略不报错)，统一改走"反馈到内置池"路径：
  - 想加新板块？刷一会让 `topicMap` 字典累积 → 跑 `xiaoheihe.dumpTopicMap` 导出 → 发 Issue 给作者
  - 内置池已收录 133 项，覆盖小黑盒主流场景；缺漏的话题往往是极小众内容，反馈合并后下个版本所有用户一并受益
- 🧹 **移除 UI 上"未验证"角标** —— BUILTIN_SECTIONS 的 `verified: false` 现仅作为内部元数据保留（指示作者哪些板块需要补抓包），不再在 tab / 设置面板露出 `?` 角标，避免误导用户以为"未验证 = 不能用"

### Fixed — Arena

- 🩹 **守望先锋板块 topicId 修正** —— v2.2.6 早期草稿误把 `'23563'` (实际是"主机游戏"话题) 写成守望先锋 topicId，导致登录后该板块返回的不是守望先锋内容；本次按用户实测抓包数据修正为 `'563627'`，全部 6 个已验证游戏的 topicId 都通过 `link.topics[].topic_id` 反查二次确认

### 致谢
- 小黑盒 Web 协议 `ov` hash 算法 (Nuxt bundle 逆向) 由用户 2026/06 自行抓包还原，3 个官方 test case 全部对齐
- 小黑盒 APP 协议签名算法 (HMAC-SHA512 + CRC32) 参考 [vscode-maxPlus](https://github.com/AShujiao/vscode-maxPlus)

## [2.1.0] - 2026-06-10

> **知乎体验大升级：后台预拉 + 评论显图 + 加载更多 batch 化。底部"已加载未读卡"自动堆积，翻页零等待。**

### Added
- 🚀 **后台预拉缓冲池（Prefetch）—— 翻页零等待** —— 全新 [`runPrefetch()`](src/modules/zhihu/views/MainViewProvider.ts:702-738) 后台任务：每次用户刷新/加载更多结束后，后台静默拉到最多 `prefetchTargetCount` 条（默认 12）匹配过滤的卡片，**直接 post 给前端 DOM**（不是塞后端 buffer 等用户 take），前端列表本身就是"用户视角的未读 buffer"。效果：滚到底永远有 ~10-20 张已加载未读卡片排队，下拉一眼就看见，零 loading spinner、零网络往返
  - 状态协调：`prefetchPromise` 单例 + `frontendWantingFetch` 让位信号 + `prefetchSuspended` 失败熔断（cookie 失效/网络抖动时不再无限 retry 触发 banner 弹）
  - 单轮上限：`prefetchTargetCount=12` 卡 + `prefetchMaxPages=5` 页双重保护，push 完一轮就停，等下次用户交互再触发，DOM 不会无限膨胀
  - 退登自动清理 prefetch 状态，不会切账号后看到上个账号 prefetch 的卡
- 🖼️ **评论区图片显示** —— 知乎评论里 zhimg.com 图片现在能正常出图。之前 [`toCommentView`](src/modules/zhihu/api/ZhihuClient.ts:931) 走 `stripHtmlPreserveBreaks(_, false)` 把 `<img>` 全替成 `[图片]` 文本，对评论里以 `<a data-image-url=...>` 包裹的"点击查看大图"链接更是直接显示成"加载图片"几个字。现改 `preserveImages=true` + 前端 [`renderTextWithImages`](src/modules/zhihu/views/MainViewProvider.ts:2335-2344) 渲染 `[IMG:url]` 占位符
- 🔍 **`<a>` 形态图片启发式识别** —— 新增 [`extractCommentImageUrl()`](src/modules/zhihu/api/ZhihuClient.ts:1093) 工具：从 `<a>` 属性里抠 `data-image-url` / `data-original` / `data-actualsrc` / `data-image-src`（强语义），抠不到时按 `href` 是 zhimg.com 子域兜底（图床域名）。不依赖 class 兜底避免误杀普通超链接
- ⚙️ **4 个新配置项**：
  - `zhihu.refreshTargetCount` (默认 6) —— 刷新和加载更多统一 batch 数，治"加载更多挤牙膏"
  - `zhihu.refreshMaxAttempts` (默认 10) —— 开启点赞过滤时刷新场景为凑够目标数最多发起的请求次数上限
  - `zhihu.prefetchTargetCount` (默认 12) —— 后台预拉的目标条数；设 0 关闭后台 prefetch
  - `zhihu.prefetchMaxPages` (默认 5) —— 单次后台 prefetch 最多发起的请求数，防止持续打接口被服务端限流
- 🐛 **评论图片诊断采样日志** —— `commentImgSampleCount` (cap=3) 在 raw content 含可疑图片关键字 (`加载图片` / `comment_img` / `zhimg.com`) 但解析后无 `[IMG:` 占位符时打印一次原始 HTML 样本（截断 800 字符），方便快速识别知乎新的 HTML 形态再补到启发式里

### Changed
- 🚿 **加载更多不再"挤牙膏"** —— 此前 [`fetchAndPush`](src/modules/zhihu/views/MainViewProvider.ts:478) 的内循环 `loopForTarget ? target : 1` 导致加载更多场景 target=1，点一次只来 1 张卡。现改为统一 batch：刷新和加载更多都按 `refreshTargetCount`（默认 6）批量同步 push，剩下让 prefetch 后台继续推
- ♻️ **大重构 `fetchAndPush`** —— 拆出共用 helper [`fetchPageAndPartition()`](src/modules/zhihu/views/MainViewProvider.ts:602-643)（拉一页 + 按过滤拆 matching/nonMatching + reportRead）和 [`maybeNotifyReachEnd()`](src/modules/zhihu/views/MainViewProvider.ts:649-661)（幂等通知前端到底）；`fetchAndPush` 和 `runPrefetch` 共用这两个 helper，逻辑统一
- 🎯 **cardBuffer 语义变更** —— 从"待 take 的卡片池"变为"非匹配复用池"：匹配过滤的卡片由 `fetchPageAndPartition` 直接 push 给前端 DOM，buffer 只装当前过滤拉到但不匹配的卡片（供用户后续放宽过滤时复用，节约一次网络）。硬上限 `PREFETCH_HARD_BUFFER_CAP=100`，极端过滤场景下兜底防内存膨胀
- 🌐 **图片样式作用域改全局** —— `.inline-img` / `.inline-img-broken` / `.inline-img-placeholder` 不再绑 `.detail-text` 前缀，让正文和评论区共用同一份样式。同时 [`syncImagesEnabledToDOM`](src/modules/zhihu/views/MainViewProvider.ts:1755-1773) 选择器也去前缀，用户点 🖼️ 切换图片开关时正文和评论同步切换，不再"正文切了评论没切"

### Fixed
- 🛑 **reportRead 接口 404 不再每次都试一次无效 HTTP** —— 知乎 `/api/v3/feed/topstory/feedback/read` 时不时返回 404（路径变更 / 鉴权策略调整）。此前每页都试一次失败，每次刷新多 N 次无效请求。现新增进程级熔断 `REPORT_READ_FAIL_THRESHOLD=3`，连续失败到上限后本进程剩余 reportRead 调用直接 short-circuit，任何一次成功立即重置计数；[`resetSession()`](src/modules/zhihu/api/ZhihuClient.ts:395) 也重置熔断，给"下次刷新还能再试"的机会
- 📌 **评论区图片视觉降一档** —— 单独覆盖 `.comment-body .inline-img` 的 `max-height=220px` + 缩短上下 margin，避免评论里一张表情图把楼层撑得比正文还大

## [2.0.1] - 2026-06-10

> **体验优化版：彻底消除打扰式弹窗，cookie 失效改为 view 内被动告示；修复知乎详情页交互细节。**

### Changed
- 🤫 **彻底静默 cookie 失效弹窗** —— 此前 [`notifyExpired()`](src/modules/weread/auth/AuthService.ts) / [`notifyRenewalDead()`](src/modules/weread/auth/AuthService.ts) 会弹 `showWarningMessage`（包括 modal 阻塞弹窗）让用户重导，被反馈"每次都要点关闭很烦"。现一律改为 `console.warn` + 5 分钟日志节流（`lastExpiredLogAt` / `lastRenewalDeadLogAt`），知乎侧同步处理。视图层拉不到数据自然显示空态/错误态，用户感知到了再自行重导，插件不主动打扰
- 🛡️ **未登录态守卫** —— 之前未登录时仍可能误触发"登录失效"提示。现 `isCookieKnownInvalid()` 内置 `&& isLoggedIn()` 判断，未登录态永远不会触发任何失效信号

### Added
- 🪧 **View 内被动告示 banner** —— `AuthService` 新增 `cookieKnownInvalid` 字段 + `onDidChangeCookieValidity: Event<boolean>` 事件 + `isCookieKnownInvalid()` 公共 getter。`MainViewProvider` 订阅事件后，cookie 失效时在 view 顶部显示一条带"重新导入"按钮的警告横幅；用户重新导入或 logout 后自动消失。banner 用 vscode `inputValidation.warning` 主题色，与系统 UI 一致
  - Folio (微信读书) 走 `render()` 整页重建路径，banner 由 `buildInvalidBannerHtml()` 条件性插入到 tabbar 之上
  - Curio (知乎) 走 `postMessage('cookieValidity')` 增量更新路径，banner DOM 静态存在，hidden 切显隐
  - 关键设计：用事件驱动而非仅在 resolve 时推一次 —— `retainContextWhenHidden=true` 时切走切回不会重新 resolve，但 cookie 期间可能从有效跌到失效，必须事件实时刷
  - 标记 cookie 失效**不走日志节流** —— 日志可以 5 分钟一条，但 banner 显示不能漏

### Fixed
- 🎚️ **知乎详情页隐藏了图片/字号按钮** —— 此前进入问题详情页 (`openQuestion`) 整条 filter-bar 都被 hidden，导致用户在详情页阅读长答案时无法切图片开关或调字号。现 filter-bar 改为按元素粒度分组：用 `.feed-only` class 标记"只对推荐流有意义"的控件（点赞过滤 / 应用清除 / 统计），详情页态由 `.in-question` class CSS 隐藏；图片开关 (`#imagesToggle`) 与字号按钮 (`#fontSmaller` / `#fontLarger`) 不带 feed-only，详情页里仍可见可用
- 🔄 **从详情页返回 feed 流回到顶部** —— 此前 `closeQuestionView` 直接 `scrollTo(0, 0)`，用户从 feed 中段进详情页返回后被强制顶到最上，要从头翻到原位置体验劝退。现新增 `savedFeedScrollY` 外部变量，`openQuestionView` 时保存当前 `window.scrollY`，关闭时双 `requestAnimationFrame` 等 layout 完成后恢复滚动位置（单层 rAF 在某些 vscode webview 渲染节奏下会赶不上首帧 layout）
- 🧭 **filter-bar 可见性散落多处的状态不一致** —— 重构出 `syncFilterBarVisibility()` 单点函数统一管理三态（未登录隐藏 / 已登录非详情显示 / 已登录详情显示并切 in-question class），原本散落在 `loginState` / `openQuestion` / `closeQuestion` 各处的 `hidden=...` 收敛到一处，避免忘记同步导致的状态错乱

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
