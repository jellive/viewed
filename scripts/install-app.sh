#!/usr/bin/env bash
# 패키징한 viewed.app 을 설치 위치에 바꿔 넣고 다시 연다. 어느 단계든 실패하면 멈추고 설치돼 있던 앱은 그대로 둔다.
#   --skip-package  이미 패키징한 것을 쓴다
#   --no-open       끝나고 앱을 열지 않는다
# 시험용 환경 변수: VIEWED_APP_SRC(패키지 경로), VIEWED_INSTALL_DIR(설치 폴더), VIEWED_QUIT_WAIT(종료를 기다릴 초)
set -euo pipefail

package=1 reopen=1
for a in "$@"; do
  case "$a" in
    --skip-package) package=0 ;;
    --no-open) reopen=0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

root=$(cd "$(dirname "$0")/.." && pwd)
src=${VIEWED_APP_SRC:-$root/apps/desktop/out/viewed-darwin-arm64/viewed.app}
dest=${VIEWED_INSTALL_DIR:-/Applications}/viewed.app
quit_wait=${VIEWED_QUIT_WAIT:-15}   # 줄 질문이 돌고 있으면 종료가 몇 초 늦다(main.cjs)
new="$dest.new.$$" old="$dest.old.$$"

if [ "$package" = 1 ]; then (cd "$root" && pnpm --filter @viewed/desktop package); fi
if [ ! -x "$src/Contents/MacOS/viewed" ]; then echo "no packaged app at $src" >&2; exit 1; fi

# 새 앱을 옆에 먼저 다 복사한다 — 복사가 실패해도 쓰던 앱을 건드리기 전이다
trap 'rm -rf "$new"' EXIT
ditto "$src" "$new"

# pgrep: 0 있음, 1 없음, 그 밖은 조회 실패 — 실패를 '없음'으로 치면 도는 앱을 바꿔 끼운다
running() {
  local rc=0
  pgrep -f "$dest/Contents/MacOS/viewed" > /dev/null || rc=$?
  case "$rc" in
    0) return 0 ;;
    1) return 1 ;;
    *) echo "could not check whether viewed is running; nothing was replaced." >&2; exit 1 ;;
  esac
}
if running; then
  osascript -e 'quit app "viewed"' > /dev/null || true
  waited=0
  while running; do
    if [ "$waited" -ge "$quit_wait" ]; then echo "viewed did not quit within ${quit_wait}s; nothing was replaced. Quit it and run this again." >&2; exit 1; fi
    sleep 1
    waited=$((waited + 1))
  done
fi

if [ -e "$dest" ]; then mv "$dest" "$old"; fi
if ! mv "$new" "$dest"; then
  if [ -e "$old" ]; then mv "$old" "$dest"; fi
  echo "could not put the new app at $dest; the old one was restored." >&2
  exit 1
fi
# 새 앱이 열린 뒤에야 옛 앱을 지운다
if [ "$reopen" = 1 ] && ! open "$dest"; then
  if [ -e "$old" ]; then rm -rf "$dest"; mv "$old" "$dest"; fi
  echo "could not open the new app; the old one was restored if there was one." >&2
  exit 1
fi
rm -rf "$old"
echo "installed $dest"
