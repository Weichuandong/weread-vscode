#!/usr/bin/env bash
# 本地一键预发布脚本
#
# 做的事:
#   1. 校验当前 git 工作区干净 (无未提交改动)
#   2. 校验 CHANGELOG.md 已经新增了 ## [<version>] 段
#   3. 校验 git tag v<version> 不存在 (防止重复发布)
#   4. 修改 package.json 的 version
#   5. commit + 打 annotated tag
#   6. 提示你 push, push 后由 GitHub Actions 自动构建并发布
#
# 用法:
#   ./scripts/release.sh <version>
#   例如: ./scripts/release.sh 0.0.5

set -euo pipefail

# ---- 颜色辅助 ----  
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

err()  { printf "${RED}❌ %s${NC}\n" "$*" >&2; exit 1; }
ok()   { printf "${GREEN}✅ %s${NC}\n" "$*"; }
info() { printf "${CYAN}ℹ  %s${NC}\n" "$*"; }
warn() { printf "${YELLOW}⚠  %s${NC}\n" "$*"; }

# ---- 解析参数 ----
if [ $# -ne 1 ]; then
  printf "${BOLD}用法${NC}: %s <version>\n" "$0"
  printf "${BOLD}示例${NC}: %s 0.0.5\n\n" "$0"
  printf "发布前请确认:\n"
  printf "  1. 代码改动已 commit\n"
  printf "  2. CHANGELOG.md 里已新增 \"## [<version>]\" 段\n"
  exit 1
fi

VERSION="$1"
TAG="v$VERSION"

# 简单版本号格式校验 (semver: x.y.z)
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  err "version 格式不对, 应为 x.y.z (例如 0.0.5), 你给的是: $VERSION"
fi

# ---- 切到项目根 ----
cd "$(dirname "$0")/.."
info "工作目录: $(pwd)"

# ---- 1. 校验 git 工作区干净 ----
if ! git diff --quiet || ! git diff --staged --quiet; then
  git --no-pager status -s
  err "工作区有未提交改动, 请先 commit 或 stash 再发布"
fi

# 校验本地 main 跟远端没差太远 (best-effort, 失败不阻塞)
git fetch origin main 2>/dev/null || warn "fetch origin main 失败, 跳过远端同步检查"
LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse origin/main 2>/dev/null || echo "$LOCAL_HEAD")
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  warn "本地 HEAD 跟 origin/main 不一致, 强烈建议先 git pull --rebase 再发布"
fi

# ---- 2. 校验 CHANGELOG 里有这一节 ----
if ! grep -q "^## \[$VERSION\]" CHANGELOG.md; then
  err "CHANGELOG.md 里没找到 \"## [$VERSION]\" 段, 请先添加"
fi
ok "CHANGELOG.md 已包含 [$VERSION] 段"

# ---- 3. 校验 tag 不存在 ----
if git rev-parse "$TAG" >/dev/null 2>&1; then
  err "tag $TAG 已存在, 请检查是否重复发布"
fi
ok "tag $TAG 尚未创建"

# ---- 4. 改 package.json version ----
info "更新 package.json version → $VERSION"
npm version --no-git-tag-version "$VERSION" --allow-same-version >/dev/null

# ---- 5. 校验 TypeScript 编译通过 ----
info "本地编译验证 (tsc --noEmit)"
npx tsc -p ./ --noEmit
ok "TypeScript 编译通过"

# ---- 6. commit + tag ----
git add package.json package-lock.json
git commit -m "release: $TAG"
git tag -a "$TAG" -m "Release $TAG"

ok "本地 release commit + tag 完成"
echo ""
printf "${BOLD}最后一步 (确认无误后跑):${NC}\n\n"
printf "    ${CYAN}git push --follow-tags${NC}\n\n"
printf "push 之后 GitHub Actions 会自动:\n"
printf "  • 编译 + 打包 vsix\n"
printf "  • 创建 GitHub Release 并上传 vsix\n"
printf "  • 发布到 Open VSX (需要 OVSX_PAT secret)\n\n"
printf "如果想反悔, 跑:\n"
printf "    ${YELLOW}git tag -d $TAG && git reset --hard HEAD~1${NC}\n\n"
