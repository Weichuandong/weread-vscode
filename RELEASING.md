# 发布流程

> 本文档说明 weread-vscode 插件的完整发布流程。**TL;DR**: 改完代码 → 更新 CHANGELOG → 跑 `npm run release -- 0.0.x` → `git push --follow-tags`，剩下交给 GitHub Actions。

---

## 📐 整体架构

```
本地                                  GitHub                          市场
─────                                ────────                         ──────
改代码                                  
  ↓
改 CHANGELOG.md  ─┐
                 ├→ npm run release ─→ commit + tag
改 package.json ─┘                       ↓
                                  git push --follow-tags
                                       ↓
                              ┌────────────────────┐
                              │  GitHub Actions    │
                              │  release.yml       │
                              │                    │
                              │  ① npm ci          │
                              │  ② tsc 编译         │
                              │  ③ vsce package    │
                              │  ④ 抠 CHANGELOG    │
                              │  ⑤ 建 Release ─────┼──→ GitHub Release
                              │     上传 vsix      │
                              │  ⑥ ovsx publish ───┼──→ Open VSX
                              └────────────────────┘
```

---

## 🔧 一次性准备

只需做一次，后续发版无需重复。

### 1. Eclipse 账号 + ECA

- 注册 https://accounts.eclipse.org/user/register（用真实邮箱）
- 签 ECA https://accounts.eclipse.org/user/eca （勾 3 个 checkbox → Sign）
- 关联 GitHub：账户 → Social Media Links → 填 GitHub 用户名
- ⚠️ GitHub 主邮箱**必须**和 Eclipse 邮箱一致

### 2. Open VSX 注册 + 拿 Token

- 打开 https://open-vsx.org → 右上 **Log In** → 用 GitHub OAuth 授权
- 头像 → **Settings → Access Tokens** → **Generate New Token**
- 起名 `weread-publish` → **复制保存**（只显示一次）

### 3. 本地创建 namespace（一辈子一次）

```bash
export OVSX_PAT="刚才复制的 token"
npm install -g ovsx
ovsx create-namespace weichuandong
```

### 4. 配置 GitHub Actions 的 OVSX_PAT secret

- 打开 repo → **Settings** → 左侧 **Secrets and variables → Actions**
- 点 **New repository secret**
- Name: `OVSX_PAT`
- Secret: 粘贴 token
- **Add secret**

> 如果不配，workflow 只发 GitHub Release，跳过 Open VSX（不会失败）。

### 5.（可选，**当前未启用**）微软官方 Visual Studio Marketplace

> **现状（2026-09）：本项目只发 GitHub Release + Open VSX，没有上微软 Marketplace。**
> [`release.yml`](.github/workflows/release.yml) 里的 `vsce publish` 步骤已经写好但处于休眠状态 —— 只要没配 `VSCE_PAT` secret 就自动跳过，不影响现有发布链路。将来想发，配上 secret 即刻生效，不用改代码。

Open VSX 与微软官方 Marketplace 是**两个完全独立的市场**，没有任何同步机制，同一个 vsix 要各发一份。原版 VSCode 的扩展面板只读微软的那个。

#### ⛔ 两个劝退点（决定暂不发布的原因）

**其一：中国区账号建不了 Azure DevOps 组织。** `vsce` 的 PAT 必须来自 Azure DevOps 组织，而中国大陆区域的 Microsoft 账号（如 QQ 邮箱注册的）创建组织时会被要求**先绑定 Azure 订阅**：

```
Select an Azure subscription for billing
To create an Azure DevOps organization, you need to link it to an Azure subscription.
We couldn't find any subscriptions you have access to.
```

国际版免费层本来不需要订阅，这是地区限制（跟的是**账号注册国家**，不是 IP，改机房区域没用）。绕过办法只有三条，都有成本：
1. 去 https://signup.live.com 新注册一个 outlook 账号，**注册时国家/地区选美国**（注册后再改会牵扯付款信息，很难）——免费但多一个要长期保管的账号，publisher 会绑死在它上面
2. 开 Azure 免费订阅 https://azure.microsoft.com/free ——需要**国际信用卡**验证（银联通常不认），预授权 1 美元后退回
3. 被别人邀请加入一个已有组织

**其二：合规风险。** 微软 Marketplace 的审核明显严于 Open VSX，本插件存在这些敏感点：调用微信读书 / 知乎 / 小黑盒的**非公开接口**、要求用户**粘贴 Cookie**、对受版权保护的图书正文做**解密渲染**、名字直接叫"摸鱼套件"。这些都可能撞上 Marketplace Terms 里"规避第三方服务限制 / 侵犯版权"的条款，存在**被拒审或上架后下架**的可能，且被投诉时受影响的是**整个 publisher**（名下所有扩展）。

权衡下来：Open VSX 已经覆盖 Cursor / VSCodium / Gitpod，原版 VSCode 用户走 vsix 离线安装 + [`UpdateChecker`](src/modules/weread/services/UpdateChecker.ts) 主动提醒更新，体验差距不大，不值得为这点曝光承担上述风险。

---

**以下是将来真要发时的操作步骤，留档备用。**

#### ① 建 Azure DevOps 组织 + 生成 PAT

1. 用 Microsoft 账号登录 https://dev.azure.com ，随便建一个组织（名字不重要，只是 PAT 的挂靠点）
2. 右上角头像 → **Personal access tokens** → **New Token**
   - **Organization**: 必须选 **All accessible organizations**（选具体某个组织会 401，这是最常见的坑）
   - **Expiration**: 最长 1 年（到期后 CI 会 401，需要重新生成并更新 secret）
   - **Scopes**: 点 **Show all scopes** → 勾 **Marketplace → Manage**
3. 复制 token（只显示一次）

#### ② 创建 publisher

打开 https://marketplace.visualstudio.com/manage/createpublisher

- **ID 必须填 `weichuandong`** —— 要与 [`package.json`](package.json) 的 `publisher` 字段完全一致。扩展的全局唯一 ID 是 `<publisher>.<name>`，改了 ID 就等于换了个插件，老用户不会收到更新
- 万一 `weichuandong` 已被占用，只能改 `package.json` 的 publisher 重新发一个新扩展，Open VSX 那边的老用户就断更了 —— 提前确认

#### ③ 配 secret（走 CI 自动发布）

repo → **Settings → Secrets and variables → Actions** → **New repository secret**

- Name: `VSCE_PAT`
- Secret: 粘贴 ① 里的 token

配好后下次 push tag，[`release.yml`](.github/workflows/release.yml) 会自动多跑一步 `vsce publish --packagePath *.vsix`（复用同一个 vsix，保证两边字节一致）。没配则跳过，不会让 workflow 变红。

#### ④ 手动补发某个已有版本

已经发过的版本（例如 3.2.0 发完才想起要上 Marketplace），不用重打 tag：

```bash
# 从 GitHub Release 下载 vsix, 或本地 npx @vscode/vsce package 现打一个
npx @vscode/vsce publish --packagePath weread-vscode-3.2.0.vsix --pat <你的PAT>
```

首次发布后扩展会进入 **verification（病毒扫描 + 元数据校验）**，几分钟到几小时不等，期间扩展页显示 pending，扫描通过才对外可见。

---

## 🚀 每次发版的标准流程

假设要发 `0.0.5` 版本：

### Step 1：改代码

正常开发，commit 到 main 分支。

### Step 2：更新 [`CHANGELOG.md`](CHANGELOG.md)

在文件顶部加一段：

```markdown
## [0.0.5] - 2026-XX-XX

### Added
- 新功能 A
- 新功能 B

### Fixed
- 修了某个 bug
```

> 段落标题必须严格匹配 `## [0.0.5]` 格式，workflow 会按这个 pattern 抠出 release notes。

### Step 3：跑预发布脚本

```bash
npm run release -- 0.0.5
```

脚本会自动校验 + 改 [`package.json`](package.json) version + commit + 打 tag。

**输出示例**：
```
ℹ  工作目录: /Users/.../some_plugin
✅ CHANGELOG.md 已包含 [0.0.5] 段
✅ tag v0.0.5 尚未创建
ℹ  更新 package.json version → 0.0.5
ℹ  本地编译验证 (tsc --noEmit)
✅ TypeScript 编译通过
✅ 本地 release commit + tag 完成

最后一步 (确认无误后跑):

    git push --follow-tags
```

### Step 4：push 触发自动发布

```bash
git push --follow-tags
```

`--follow-tags` 一并 push commit 和 tag。

### Step 5：在 Actions 看进度

打开 `https://github.com/weichuandong/weread-vscode/actions`，约 1~2 分钟后看到绿勾 ✓。

完成后：
- 📦 GitHub Release: `https://github.com/weichuandong/weread-vscode/releases/tag/v0.0.5`
- 🛒 Open VSX: `https://open-vsx.org/extension/weichuandong/weread-vscode`

### Step 6：本地 VSCode 装新版本 🆕

发布完之后，**作者本地的 VSCode 不会自动升级**（因为官方 VSCode 默认指向 Microsoft Marketplace，不读 Open VSX）。一行命令搞定：

```bash
npm run install-local
```

这条 script 等价于：编译 → `vsce package` 出 vsix → `code --install-extension --force` 装到本地 VSCode（覆盖旧版本）。

**装完别忘了 reload 窗口**：`Cmd+Shift+P` → `Developer: Reload Window`。

> 💡 **Agent 协议**：当用户对 codewiz/claude 说「发布」时，Agent 应当在 `git push --follow-tags` 成功之后，自动追加一步 `npm run install-local`，并提示用户 reload window。

---

## 🔁 极简流程速查（贴墙上）

```bash
# 1. 改 CHANGELOG.md (新增 ## [0.0.5] 段)
# 2. 跑预发布
npm run release -- 0.0.5
# 3. push
git push --follow-tags
# 4. 喝口水, 1~2 分钟后看 Actions 是否绿勾
# 5. 本地同步最新版本到 VSCode
npm run install-local
# 然后 Cmd+Shift+P → Developer: Reload Window
```

---

## 🛠 GitHub Actions Workflow 做了什么

详见 [`.github/workflows/release.yml`](.github/workflows/release.yml)。

触发条件：push 一个 `v*.*.*` 格式的 tag

步骤：

| # | 步骤 | 说明 |
|---|------|------|
| 1 | checkout | 拉取 tag 对应代码 |
| 2 | setup Node 20 | 带 npm cache |
| 3 | 校验 version 和 tag 一致 | package.json version 必须等于 tag (去掉 v 前缀) |
| 4 | npm ci | 严格按 package-lock.json 装依赖 |
| 5 | npm run compile | tsc 编译到 out/ |
| 6 | vsce package | 出 weread-vscode-x.x.x.vsix |
| 7 | 抠 CHANGELOG | 用 awk 提取对应版本段 |
| 8 | 建 GitHub Release | 用 softprops/action-gh-release@v2, 上传 vsix |
| 9 | ovsx publish | 如配置了 OVSX_PAT secret 则同步发到 Open VSX |
| 10 | vsce publish | 如配置了 VSCE_PAT secret 则同步发到微软 Marketplace |

第 9、10 步即使失败也不阻塞第 8 步（`continue-on-error: true`），所以某个市场抽风 / PAT 过期不会影响 GitHub Release。

---

## ❌ 常见报错 & 排查

### release.sh 失败

| 报错 | 原因 | 解决 |
|------|------|------|
| `工作区有未提交改动` | 还有未 commit 的文件 | 先 `git commit` 或 `git stash` |
| `CHANGELOG.md 里没找到 ...` | 忘了在 CHANGELOG 加新版本段 | 加上 `## [0.0.5]` 段 |
| `tag v0.0.x 已存在` | 该版本已发过 | 改用新版本号 |
| `TypeScript 编译失败` | 代码有 ts 错误 | 修了再发 |

### GitHub Actions 失败

打开 Actions 页面看红色 step 的 log。

| 报错关键字 | 原因 | 解决 |
|------------|------|------|
| `package.json version ... does not match tag` | 忘了 `npm run release` 直接打 tag | tag 删了 (`git push origin :v0.0.x` + `git tag -d v0.0.x`) 重跑预发布 |
| `npm ci` 失败 | 依赖版本冲突 | 本地 `rm -rf node_modules package-lock.json && npm install`, commit 新 lock |
| `vsce package` 失败 | LICENSE / icon 缺失 | 补齐 |
| `Resource not accessible by integration` (release 步骤) | GitHub Actions 权限 | 已在 workflow 配 `permissions: contents: write`，正常不会有；如果出现，检查 repo Settings → Actions → General → Workflow permissions 是否设为 `Read and write` |
| `Unauthorized` / `unverified namespace` (ovsx 步骤) | OVSX_PAT 错了 / namespace 没创建 | 重新生成 token + 更新 secret + 本地跑 `ovsx create-namespace weichuandong` |
| `401 Unauthorized` (vsce 步骤) | PAT 的 Organization 没选 "All accessible organizations", 或 PAT 已过期 (最长 1 年) | 按上面 ①  重新生成 PAT, 更新 `VSCE_PAT` secret |
| `The Personal Access Token used has expired` | 同上 | 同上 |
| `Extension 'xxx' not found` / publisher 不匹配 | Marketplace 上没建 publisher, 或 ID 与 package.json 的 `publisher` 不一致 | 到 https://marketplace.visualstudio.com/manage 建同名 publisher |
| `Version 3.2.0 already exists` | 该版本已发过 | Marketplace 同 Open VSX 一样不允许覆盖, 只能递增版本号重发 |

### 撤销一次发布

```bash
# 1. 删本地 tag 和远端 tag
git tag -d v0.0.5
git push origin :v0.0.5

# 2. 在 GitHub Releases 页面手动 Delete

# 3. (如果同步到了 Open VSX) 同名版本无法删除, 只能 publish 一个递增版本覆盖
#    OVSX 不允许重复 publish 同 version, 所以必须打 v0.0.6 重发
```

---

## 📝 版本号约定 (Semantic Versioning)

| 类型 | 示例 | 何时用 |
|------|------|--------|
| **patch** | 0.0.4 → 0.0.5 | 修 bug / 小调整 |
| **minor** | 0.0.4 → 0.1.0 | 新增功能 / 兼容 |
| **major** | 0.1.0 → 1.0.0 | 破坏性变更 / 正式发布 |

---

## 🔗 相关链接

- GitHub repo: https://github.com/weichuandong/weread-vscode
- GitHub Releases: https://github.com/weichuandong/weread-vscode/releases
- Open VSX 插件页: https://open-vsx.org/extension/weichuandong/weread-vscode
- Eclipse 账号设置: https://accounts.eclipse.org/user
- Open VSX 文档: https://github.com/eclipse/openvsx/wiki/Publishing-Extensions
- VSCode Extension API: https://code.visualstudio.com/api
