# 남의 커밋 흐리게 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로컬 폴더 모드에서 남의 커밋만 닿은 파일은 접힌 채 확인함으로 세고, 섞인 파일의 남이 쓴 추가 줄은 회청색 바탕으로 보인다.

**Architecture:** 데스크톱 main 이 `git log`(머지 아님 + 머지 `--cc`)와 `git blame` 을 돌려 JSON 문자열로 돌려준다(기존 `ops` 규칙). core 가 '나' 매칭과 파일 판정을 하고 `buildReview` 가 남의 파일을 `viewed` 로 센다(기록 안 씀). 웹은 목록 배지·잠긴 체크박스와, 펼친 diff 에서 파일별 blame 으로 추가 줄을 칠한다.

**Tech Stack:** Electron 44 (CommonJS, node:test), React 19 + Vite 8 (Playwright E2E), packages/core (TypeScript, vitest), pnpm.

**Spec:** `docs/superpowers/specs/2026-10-21-others-dim-design.md`

## Global Constraints

- 로컬 폴더 모드 전용. GitHub 모드 화면·동작은 바뀌지 않는다.
- 항상 켜짐 — 토글 없음.
- 애매하면 '내 것'(지금 표시): 작성자 목록 실패·빈 작성자 집합·blame 실패·아직 안 옴 → 표시 없음.
- 남의 줄은 투명도 금지. 라이트 바탕 `#eef2f8`, 글자 `#3d4b5c`. 다크는 같은 톤의 짝(값은 구현자).
- 칠하는 줄은 추가 줄(`+`)만. 삭제·문맥 줄은 그대로.
- 남의 파일엔 ViewRecord 를 쓰지 않는다.
- git 인자: 커밋은 `oid()`, 경로는 `checkPath()`, `--no-textconv --no-ext-diff --no-show-signature`, `.mailmap` 적용 표기(log `%aN`/`%aE`, blame porcelain 기본).
- 공개 레포: 픽스처·테스트에 실제 사람 이름·이메일·`/Users/<name>` 금지. `alice`/`bob`, `@example.test` 를 쓴다. 커밋 전 `bash scripts/prepublish-scan.sh`.
- 커밋 메시지 끝: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. 파일은 이름으로 stage(`git add -A` 금지).

## Review Focus

1. '나'가 비어 있음(레포에 `user.name`/`user.email` 없음, 추가 목록 없음) → 전부 내 파일, 아무것도 안 접힘. — Task 2 테스트.
2. 내가 옛 경로에서 고친 뒤 남이 이름을 바꾼 파일 → 내 파일. — Task 1(데스크톱 판정 입력), Task 2(합치기) 테스트.
3. 공백·한글 경로, `.mailmap` 으로 합쳐진 작성자 → log 와 blame 의 표기가 같다. — Task 1 테스트.
4. 기본으로 펼쳐지는 내 파일이 수백 개 → blame 동시 실행 4개 이하, 접힌 파일은 blame 안 함. — Task 4 테스트.
5. 다시 읽기(refresh) 뒤 내가 남의 파일을 고쳤으면 그 파일이 '안 봄'으로 돌아온다. — Task 3 E2E.

---

### Task 1: 데스크톱 git — 작성자 목록·파일 blame·내 신원

**Files:**
- Modify: `apps/desktop/local-git.cjs` (`ops`, `info`)
- Modify: `apps/desktop/main.cjs:91-95` (`repo:git` 가 인자 `c` 를 넘긴다)
- Modify: `apps/desktop/preload.cjs` (`run(repo, op, a, b, c)`)
- Modify: `apps/web/src/settings.ts` (`DesktopGit.run` 타입·`info` 반환 타입)
- Test: `apps/desktop/test/local-git.test.cjs`, `apps/desktop/test/helpers.cjs`

**Interfaces:**
- Produces:
  - `ops.authors(repo, mergeBase, head)` → JSON 문자열 `{ files: Record<string, [name: string, email: string][]> }`. 경로마다 그 경로를 바꾼 작성자(중복 제거). 머지 아닌 커밋(`log --no-merges -M -z --name-only --format=%x01%aN%x00%aE`)과 머지 커밋(`log --merges --cc -z --name-only` 같은 format)을 합친다. 마감 10초.
  - `ops.blameAuthors(repo, head, path, mergeBase)` → JSON 문자열 `([name, email] | null)[]`, head 파일의 1-based 줄 n 이 인덱스 n-1. 경계(mergeBase 이전) 줄은 `null`. `git blame --porcelain --no-textconv <mergeBase>..<head> -- <path>`. 실패는 `null`. 마감 10초.
  - `info(repo)` 반환에 `user: { name: string; email: string }` 추가(`git config user.name`/`user.email`, 없으면 빈 문자열).
  - `DesktopGit.run(repo, op: … | 'authors' | 'blameAuthors', a, b?, c?)`.

- [ ] **Step 1: 실패 테스트 작성** — `helpers.cjs` 에 `makeOthersRepo()`: main 에 base, feat 에서 alice(나)·bob 이 각각 커밋. bob 만 닿은 `b.ts`, 둘 다 닿은 `mix.ts`, 내가 `old.ts` 를 고친 뒤 bob 이 `new.ts` 로 이름 변경, 공백·한글 경로 `폴더 a/파일.ts`(bob), bob 브랜치를 머지하며 alice 가 `conflict.ts` 충돌을 풂, `.mailmap` 으로 `bob <b2@example.test>` → `bob <b@example.test>`. 테스트:
  - `authors lists non-merge authors per path and adds merge-resolution authors` — `conflict.ts` 에 alice 가 있고, `b.ts` 엔 bob 만.
  - `authors keeps the rename target path` — `new.ts` 키가 있다(옛 경로 합치기는 core 몫).
  - `authors and blameAuthors use the same mailmapped identity` — b2 커밋 줄의 blame 이메일과 authors 이메일이 같다.
  - `blameAuthors returns null for boundary lines and the author for branch lines` — `mix.ts` 줄 배열.
  - `authors and blameAuthors refuse bad oids and paths` — 기존 `bad object id`/`bad path`.
  - `info returns git user name and email` — 설정 없으면 빈 문자열.
  - 기존 `repo:git still exposes only the old ops` 테스트는 새 목록(`authors`, `blameAuthors` 추가)으로 고친다.
- [ ] **Step 2: 실패 확인** — `pnpm --filter @viewed/desktop test:unit` → 새 테스트 FAIL.
- [ ] **Step 3: 구현** — 위 Interfaces 대로. `-z` 출력은 `\x01` 로 커밋을 나누고 NUL 로 필드·경로를 나눈다. 머지 `--cc` 출력이 빈 커밋도 안전하게.
- [ ] **Step 4: 통과 확인** — 같은 명령, 전부 PASS. `textconv`/`ext-diff` 차단 기존 테스트도 PASS.
- [ ] **Step 5: 커밋** — `feat(desktop): 작성자 목록·파일 blame ops 와 git 사용자 정보`

### Task 2: core — '나' 매칭과 남의 파일 판정

**Files:**
- Create: `packages/core/src/others.ts`
- Modify: `packages/core/src/types.ts` (`ReviewItem.others?: string[]`)
- Modify: `packages/core/src/review.ts` (`buildReview` 4번째 인자)
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/test/others.test.ts`, `packages/core/test/review.test.ts`

**Interfaces:**
- Consumes: Task 1 의 `authors` JSON 모양.
- Produces:
  - `type Author = [name: string, email: string]`
  - `meMatcher(ids: string[]): (a: Author) => boolean` — ids 와 작성자 이름·이메일을 trim+소문자로 비교. 빈 문자열 id 는 버린다. 남은 id 가 없으면 **항상 true**(전부 내 것).
  - `othersOf(files: ChangedFile[], authors: Record<string, Author[]>, isMe: (a: Author) => boolean): Map<string, string[]>` — 키는 `file.path`, 값은 남 작성자 이름(중복 제거, 처음 나온 순). 파일의 작성자 = `authors[path]` ∪ `authors[previousPath]`. 비었거나 '나'가 하나라도 있으면 맵에 없다.
  - `buildReview(snap, state, secret, others?: ReadonlyMap<string, string[]>)` — 맵에 있는 파일은 `state: 'viewed'`, `others: names`, `newBlocks`/`carried`/`dropped` 없음. 기록이 있어도 남의 표시가 이긴다.

- [ ] **Step 1: 실패 테스트** — `others.test.ts`: `meMatcher([])` 가 아무 작성자에 true · 대소문자·공백 무시 · 이메일로도 매칭 · `othersOf` 가 bob 만 → `['bob']`, alice 섞임 → 없음, 작성자 없음 → 없음, `previousPath` 에 alice → 없음. `review.test.ts`: `others` 맵의 파일이 기록 없이 `viewed`·`others` 를 갖고 `viewedCount`·`complete` 에 들어간다 · 맵 없으면 결과가 지금과 같다.
- [ ] **Step 2: 실패 확인** — `pnpm --filter @viewed/core test` → FAIL.
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — core 전체 PASS(기존 101 포함), `pnpm -r exec tsc --noEmit` 0.
- [ ] **Step 5: 커밋** — `feat(core): 남의 커밋만 닿은 파일 판정`

### Task 3: 웹 — 연결·설정·목록 표시

**Files:**
- Modify: `apps/web/src/settings.ts` (`Settings.extraMe?: string[]`)
- Modify: `apps/web/src/components/Settings.tsx` (데스크톱일 때만 textarea, 한 줄에 하나)
- Modify: `apps/web/src/localSource.ts` (`localAuthors`)
- Modify: `apps/web/src/App.tsx:125-132` (로컬 `make` 가 `others` 도 돌려준다), `ReviewView`·`useReview` 로 전달
- Modify: `apps/web/src/components/FileList.tsx`, `apps/web/src/i18n.ts`, `apps/web/src/styles.css`
- Test: `apps/web/e2e/others.spec.ts`

**Interfaces:**
- Consumes: Task 1 `authors`·`info().user`, Task 2 `meMatcher`·`othersOf`·`buildReview(…, others)`.
- Produces:
  - `localAuthors(repo: string, mergeBase: string, head: string): Promise<Record<string, Author[]> | null>` — 실패·파싱 오류는 `null`.
  - `useReview(a: { …; others?: ReadonlyMap<string, string[]> })`, `ReviewView` prop `others?`.
  - 로컬 `make` 는 스냅숏 뒤에 `localAuthors` 를 기다리고(`null` 이면 맵 없음) `meMatcher([info.user.name, info.user.email, ...(settings.extraMe ?? [])])` 로 맵을 만든다. refresh 때마다 다시 계산.
  - i18n: `othersBadge(names: string[])`(1명 `alice`, 여러 명 `alice 외 N`), `othersAuto`("남의 변경이라 자동 확인"), `extraMe`, `extraMeHint` (ko/en).
  - 남의 파일 행: `data-others="1"`, 상태 배지 자리에 `othersBadge`(`data-testid="file-others"`), 체크박스 `checked disabled` + `title={t.othersAuto}`, 머리 바탕 회청 톤.

- [ ] **Step 1: 실패 E2E** — `others.spec.ts`(ask.spec 처럼 `window.viewedDesktop` 모의, `info.user = { name: 'alice', email: 'a@example.test' }`, `authors` 가 `b.ts: [['bob','b@example.test']]`, `a.ts: [['alice',…]]`):
  - `others-only file is collapsed, counted viewed, and its checkbox is locked` — `b.ts` 행 `data-state="viewed"`, `file-others` 가 `bob`, `file-check` disabled+checked, 진행률 `1 / 2`.
  - `my file stays unread and expanded` — `a.ts` 펼침, 배지 없음.
  - `authors failure shows everything as mine` — `authors` 가 throw → 진행률 `0 / 2`, 배지 없음.
  - `extra names in settings make that author mine` — 설정에 `bob` 추가 후 `b.ts` 가 unread.
  - `refresh after I touch an others file brings it back as unread` — 모의 `authors` 를 바꾸고 refresh → `b.ts` unread.
  - `GitHub mode shows no others badge` — 기존 GitHub 모의 흐름에서 `file-others` 0개.
- [ ] **Step 2: 실패 확인** — `pnpm --filter @viewed/web exec playwright test e2e/others.spec.ts` → FAIL.
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — 위 명령 PASS, `pnpm --filter @viewed/web test` 전체 PASS(기존 118 포함), tsc 0.
- [ ] **Step 5: 커밋** — `feat(web): 남의 파일을 접고 자동 확인으로 센다`

### Task 4: 웹 — 펼친 diff 의 남의 줄 바탕

**Files:**
- Create: `apps/web/src/lineAuthors.ts`
- Modify: `apps/web/src/localSource.ts` (`localBlame`)
- Modify: `apps/web/src/components/DiffView.tsx`, `SinceViewed.tsx`, `ReviewView.tsx`, `apps/web/src/styles.css`
- Test: `apps/web/e2e/others.spec.ts` (추가)

**Interfaces:**
- Consumes: Task 1 `blameAuthors`, Task 2 `meMatcher`, Task 3 의 matcher 와 `snap.mergeBase`·`headSha`.
- Produces:
  - `localBlame(repo, head, path, mergeBase): Promise<(Author | null)[] | null>`
  - `useOtherLines(path: string): ReadonlySet<number> | undefined` — 렌더된(펼친) diff 만 부른다. head 줄 번호 중 작성자가 있고 '나'가 아닌 것. 캐시 키 `head\0path`, 앱 전체 동시 blame **4개 이하**(대기열), 실패·대기 중엔 `undefined`. 로컬 모드가 아니면 항상 `undefined`.
  - `DiffView` prop `others?: ReadonlySet<number>` — `add` 줄이고 `l.n` 이 집합에 있으면 클래스 `other`. 다른 줄 종류엔 안 붙는다.
  - `SinceViewed` 는 받은 `others` 를 since-blocks·since-blob·full 세 보기 모두에 넘긴다(세 보기 모두 `n` 이 head 번호다).
  - CSS: `--other-line: #eef2f8; --other-fg: #3d4b5c;` + 다크 짝. `.ln.add.other { background: var(--other-line); color: var(--other-fg) }`, 줄번호 칸도 같은 톤. `opacity` 쓰지 않는다.

- [ ] **Step 1: 실패 E2E** — 모의 `blameAuthors` 가 `mix.ts` 의 줄 2 = bob, 줄 3 = alice 를 돌려준다:
  - `other people's added lines get the tint, mine do not` — 줄 2 의 `.ln.add` 에 `other`, 줄 3 엔 없음, `getComputedStyle(...).opacity === '1'`.
  - `blame failure leaves lines untinted` — throw → `.other` 0개.
  - `collapsed files are not blamed and at most 4 blames run at once` — 파일 10개 펼침 상태에서 모의가 동시 호출 최대값 ≤4 를 기록, 접힌 남의 파일 경로로는 호출 없음.
  - `since view tints the same head lines` — 확인 후 바뀐 파일의 since 탭에서 같은 줄에 `other`.
- [ ] **Step 2: 실패 확인** — `pnpm --filter @viewed/web exec playwright test e2e/others.spec.ts` → 새 테스트 FAIL.
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인** — 같은 명령 PASS, `pnpm --filter @viewed/web test` 전체 PASS, tsc 0.
- [ ] **Step 5: 커밋** — `feat(web): 펼친 diff 에서 남이 추가한 줄을 회청색으로`

### Task 5: 실제 레포로 확인 · 문서

**Files:**
- Modify: `apps/desktop/e2e/local.spec.ts` (실레포 E2E 1개)
- Modify: `README.md` (기능 한 줄)

- [ ] **Step 1: 실패 E2E** — `local.spec.ts` 에 `others-only files collapse with a real repo`: Task 1 의 `makeOthersRepo` 모양으로 레포를 만들고(레포 `user.name=alice`), 앱으로 열어 `b.ts` 가 `file-others`·잠긴 체크, `mix.ts` 를 펼치면 bob 의 추가 줄에 `.other`.
- [ ] **Step 2: 실패 확인 → 구현 보완 → 통과** — `pnpm --filter @viewed/desktop test` (기존 38 passed, 1 skipped 유지 + 새 것 PASS).
- [ ] **Step 3: README 한 줄** — 로컬 폴더 모드에서 남의 커밋만 닿은 파일은 자동 확인, 남의 줄은 다른 바탕.
- [ ] **Step 4: 전체 확인** — tsc 0 · `pnpm --filter @viewed/core test` · `pnpm --filter @viewed/desktop test:unit` · `pnpm --filter @viewed/web test` · `pnpm --filter @viewed/desktop test` · `bash scripts/prepublish-scan.sh` · `bash scripts/prepublish-scan.sh --history` 전부 통과.
- [ ] **Step 5: 커밋** — `test(desktop): 실레포로 남의 파일 접힘 확인 · README`
