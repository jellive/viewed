#!/usr/bin/env bash
# 공개 레포에 들어가면 안 되는 문자열을 찾는다. 종료코드: 0 없음 / 1 발견 / 2 스캔 오류.
# 일반 패턴만 여기 둔다(대소문자 구분). 비공개 이름(회사·계정 등)은 추적하지 않는 `.prepublish-extra` 에
# 한 줄에 정규식 하나씩 적는다(# 로 시작하는 줄은 무시, 대소문자 무시). 연결 워크트리에서도
# 메인 체크아웃 루트의 목록을 쓴다.
# 모드: (인자 없음) 추적 파일 / --history 모든 이력 / --revs <rev-list 인자...> 그 범위의 객체만.
# --require-list 를 맨 앞에 주면 목록이 없거나 비었을 때 통과시키지 않고 막는다.
# --text <문자열...> 은 인자(예: push 되는 ref 이름)를 한 줄씩 같은 패턴으로 찾는다.
# 한계: 경로는 트리 객체의 이름 칸으로 보므로 목록에는 경로나 ^·$ 없이 낱말을 쓴다. 객체 스트림 중간의 UTF-16 내용은 못 본다.
#       refs/replace 와 스캔 도중 객체가 사라지는 경우는 고의나 경합에서만 생겨 막지 않는다.
set -euo pipefail
generic='/Use""rs/[a-z]|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}'
generic=${generic//\"\"/}   # 이 줄 자신이 스캔에 걸리지 않게 쪼개 둔 것을 다시 잇는다

require=0
if [ "${1:-}" = "--require-list" ]; then require=1; shift; fi

work=$(mktemp -d); [ -n "$work" ] || { echo "scan error: mktemp"; exit 2; }
trap 'rm -rf "$work"' EXIT
pf="$work/patterns"
printf '%s\n' "$generic" > "$pf"
common=$(git rev-parse --path-format=absolute --git-common-dir) || { echo "scan error: git rev-parse failed"; exit 2; }
extra="$common/../.prepublish-extra"
added=0
if [ -f "$extra" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}   # CRLF 목록
    # 빈 줄과 # 줄은 건너뛴다
    trimmed=${line#"${line%%[![:space:]]*}"}
    case "$trimmed" in ''|'#'*) continue ;; esac
    printf '(?i:%s)\n' "$line" >> "$pf"
    added=$((added + 1))
  done < "$extra"
fi
if [ "$added" -eq 0 ]; then
  if [ "$require" -eq 1 ]; then echo "no private name list (.prepublish-extra) — refusing"; exit 2; fi
  echo "no .prepublish-extra — private names not checked"
fi

mode=files
revargs=()
case "${1:-}" in
  --text)
    shift
    [ "$#" -gt 0 ] || { echo "scan error: --text needs strings"; exit 2; }
    printf '%s\n' "$@" > "$work/text"
    set +e; rg --no-config -a -q -f "$pf" "$work/text" 2>"$work/err"; rc=$?; set -e
    case "$rc" in
      0) echo "ref 이름에 공개 금지 패턴"; exit 1 ;;
      1) exit 0 ;;
      *) echo "scan error rc=$rc: $(cat "$work/err")"; exit 2 ;;
    esac ;;
  --history) mode=stream; revargs=(--all) ;;
  --revs)
    shift
    [ "$#" -gt 0 ] || { echo "scan error: --revs needs rev-list arguments"; exit 2; }
    mode=stream; revargs=("$@") ;;
esac

if [ "$mode" = stream ]; then
  # 도달 가능한 객체(삭제된 파일·바이너리·커밋 메시지 포함)를 한 스트림으로 만든다.
  # 생산자의 종료코드를 먼저 확인한다 — 실패한 스트림에 rg 가 '없음'을 돌려주면 안 된다.
  if ! git rev-list --objects "${revargs[@]}" > "$work/objs" 2>/dev/null; then echo "scan error: git rev-list failed"; exit 2; fi
  cut -d' ' -f1 "$work/objs" > "$work/ids"
  if ! git cat-file --batch < "$work/ids" > "$work/stream" 2>/dev/null; then echo "scan error: git cat-file failed"; exit 2; fi
  set +e; rg --no-config -a -n -f "$pf" "$work/stream" > "$work/out"; rc=$?; set -e
  case "$rc" in
    1) echo "history scan ok"; exit 0 ;;
    0) echo "히스토리에 공개 금지 패턴 (줄 수: $(wc -l < "$work/out" | tr -d ' '))"; exit 1 ;;
    *) echo "scan error rc=$rc"; exit 2 ;;
  esac
fi

git ls-files -z > "$work/files" || { echo "scan error: git ls-files failed"; exit 2; }
found=0
while IFS= read -r -d '' f; do
  set +e; rg --no-config -a -q -f "$pf" -- "$f" 2>"$work/err"; rc=$?; set -e
  case "$rc" in
    0) echo "$f"; found=1 ;;
    1) : ;;
    *) echo "scan error rc=$rc on $f: $(cat "$work/err")"; exit 2 ;;
  esac
done < "$work/files"
if [ "$found" -eq 1 ]; then echo "공개 금지 패턴 발견 (위 파일)"; exit 1; fi
echo "scan ok"
