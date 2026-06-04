# WeRead for VSCode

> 在 VSCode 侧边栏阅读 [微信读书](https://weread.qq.com) — 书架 / 章节目录 / 正文 / 云端进度多端同步。

[![Version](https://img.shields.io/badge/version-0.0.4-blue.svg)](https://github.com/weichuandong/weread-vscode/releases)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## ✨ 功能特性

- 📚 **书架** — 按照你在微信读书 APP 里自建的「分组（archive）」分桶展示，支持全部展开 / 折叠
- 📖 **阅读** — 章节正文直接在 VSCode 内渲染，支持 epub / txt / 图片混排
- 📑 **目录抽屉** — 右侧滑出抽屉，支持搜索过滤、当前章节自动定位、ESC 关闭
- ☁️ **云端进度同步** — 读到哪儿走微信读书云端接口，与手机 / 网页端实时互通
- 🔐 **三种登录方式**
  - 微信扫码登录（Beta）
  - 浏览器登录助手（自动打开网页 + 一句 `copy(document.cookie)` + 剪贴板自动导入）
  - 手动粘贴 Cookie
- 🎨 **跟随 VSCode 主题** — 完全使用 `--vscode-*` 主题变量，浅色 / 深色无缝切换
- 🛡️ **本地存储** — Cookie 通过 VSCode `SecretStorage` 加密存储，不上传任何远端

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

1. 到 [Releases](https://github.com/weichuandong/weread-vscode/releases) 下载最新 `weread-vscode-x.x.x.vsix`
2. VSCode → 扩展面板 → 右上 `…` → **从 VSIX 安装…**
   或命令行：`code --install-extension weread-vscode-x.x.x.vsix`

---

## 🚀 使用

1. 安装后点击 Activity Bar 左侧的 📖 微信读书 图标
2. 选择登录方式：
   - **微信扫码登录（推荐）**：手机微信扫码 → 确认即可
   - **浏览器登录助手**：插件会打开 `weread.qq.com`，登录后在 DevTools Console 执行一行 `copy(document.cookie)`，回到 VSCode 点「读取剪贴板」自动导入
   - **手动粘贴 Cookie**：从浏览器 DevTools → Application → Cookies → 复制 `weread.qq.com` 全部 Cookie → VSCode 内粘贴
3. 书架加载后，点任意书进入阅读
4. 顶部 tab 在「书架」/「在读」之间切换；底部点击章节名打开目录抽屉

---

## ⚙️ 配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `weread.requestTimeout` | number | `15000` | HTTP 请求超时时间（毫秒） |
| `weread.userAgent` | string | macOS Chrome 120 UA | 自定义请求 User-Agent |

---

## ⚠️ 免责声明

- 本插件**仅供个人学习和摸鱼使用**，不得用于商业用途、批量抓取或公开分发付费内容
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

- Bug / 建议：[GitHub Issues](https://github.com/weichuandong/weread-vscode/issues)
- PR 欢迎，但请先开 issue 沟通避免重复工作

---

## 📄 License

[MIT](LICENSE) © weichuandong
