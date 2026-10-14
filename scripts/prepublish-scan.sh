#!/usr/bin/env bash
# 공개 레포에 들어가면 안 되는 문자열을 찾는다. 종료코드: 0 없음 / 1 발견 / 2 스캔 오류.
# 일반 패턴만 여기 둔다. 비공개 이름(회사·계정 등)은 추적하지 않는 `.prepublish-extra` 에
# 한 줄에 정규식 하나씩 적는다(# 로 시작하는 줄은 무시).
set -euo pipefail
generic='/Use""rs/[a-z]|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}'
generic=${generic//\"\"/}   # 이 줄 자신이 스캔에 걸리지 않게 쪼개 둔 것을 다시 잇는다

work=$(mktemp -d); [ -n "$work" ] || { echo "scan error: mktemp"; exit 2; }
trap 'rm -rf "$work"' EXIT
pf="$work/patterns"
printf '%s\n' "$generic" > "$pf"
if [ -f .prepublish-extra ]; then
  grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' .prepublish-extra >> "$pf" || true
else
  echo "no .prepublish-extra — private names not checked"
fi

if [ "${1:-}" = "--history" ]; then
  # 도달 가능한 모든 객체(삭제된 파일·바이너리·커밋 메시지 포함)를 한 스트림으로 만든다.
  # 생산자의 종료코드를 먼저 확인한다 — 실패한 스트림에 rg 가 '없음'을 돌려주면 안 된다.
  if ! git rev-list --all --objects > "$work/objs" 2>/dev/null; then echo "scan error: git rev-list failed"; exit 2; fi
  cut -d' ' -f1 "$work/objs" > "$work/ids"
  if ! git cat-file --batch < "$work/ids" > "$work/stream" 2>/dev/null; then echo "scan error: git cat-file failed"; exit 2; fi
  set +e; rg -a -n -f "$pf" "$work/stream" > "$work/out"; rc=$?; set -e
  case "$rc" in
    1) echo "history scan ok"; exit 0 ;;
    0) echo "히스토리에 공개 금지 패턴 (줄 수: $(wc -l < "$work/out" | tr -d ' '))"; exit 1 ;;
    *) echo "scan error rc=$rc"; exit 2 ;;
  esac
fi

git ls-files -z > "$work/files" || { echo "scan error: git ls-files failed"; exit 2; }
found=0
while IFS= read -r -d '' f; do
  set +e; rg -a -q -f "$pf" -- "$f" 2>"$work/err"; rc=$?; set -e
  case "$rc" in
    0) echo "$f"; found=1 ;;
    1) : ;;
    *) echo "scan error rc=$rc on $f: $(cat "$work/err")"; exit 2 ;;
  esac
done < "$work/files"
if [ "$found" -eq 1 ]; then echo "공개 금지 패턴 발견 (위 파일)"; exit 1; fi
echo "scan ok"
