# PR 대상 전환 이어받기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 로컬 폴더 모드에서, 확인 기록의 merge-base `P` 보다 지금 merge-base `N` 이 조상(뒤처진 대상)일 때 이전 대상과 같은 파일·이전 대상에서 확인한 그대로인 파일을 한 번 확인 기록으로 남긴다.

**Architecture:** core 에 `P..head` 파일 목록을 뜨는 `loadLocalRange` 와 순수 판정 `targetCarry` 를 둔다. 웹은 `makeCarry(repo)` 가 조상 판정·P-diff·캐시·마감을 맡고, `useReview` 가 리뷰를 보여 주기 전에 그것을 돌려 기록을 쓴다.

**Tech Stack:** packages/core (TypeScript, vitest), apps/web (React 19, Playwright), apps/desktop (Electron 44, Playwright electron).

**Spec:** `docs/superpowers/specs/2026-10-22-target-switch-carry-design.md`

## Global Constraints

- 로컬 폴더 모드 전용. GitHub 모드 동작은 바뀌지 않는다.
- 켜는 조건: `mergeBase(N, P) === N && N !== P`. 이름 비교는 쓰지 않는다. 기록 형식(`ViewRecord`)은 바꾸지 않는다.
- 한 리뷰에서 쓰는 `P` 는 기록 수가 많은 순으로 최대 3개다.
- 건드리지 않는 파일:
  - 이미 `viewed` 인 파일.
  - 남의 파일(`item.others`).
  - 기록이 `viewed: false` 인 파일.
  - 기록의 `base === N` 인 파일.
- 이어받기 규칙:
  - (a) 경로가 P-diff 항목의 `path` 에도 `previousPath` 에도 없으면 확인함이다.
  - (b) 기록이 `viewed` 이고 `base === P` 이며 P-diff 쪽 파일 `fingerprint === record.fp` 이면 확인함이다.
- 이어받은 파일은 `markRecord(item, shownHead, true)` 로 한 번 기록한다. 별도 배지는 없다.
- 판정이 끝날 때까지 리뷰를 보여 주지 않는다. 마감은 5000ms 이고, 넘으면 이어받기 없이 보여 주며 늦은 결과는 버린다.
- `(repo, P, head)` 결과는 리뷰 인스턴스 동안 캐시한다. 실패도 캐시한다. 다음 열기(새 ReviewView)에서 다시 시도한다.
- `toggle` 은 화면에 떠 있는 스냅숏(`shownSnap`)의 head 로 기록한다.
- 공개 레포: 픽스처는 alice/bob, `@example.test` 만 쓴다. `/Users/<name>` 경로를 넣지 않는다. 커밋 전에 `bash scripts/prepublish-scan.sh` 를 돌린다.
- 커밋 메시지 끝은 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` 이다. 파일은 이름으로 stage 하고, push 하지 않는다.

## Review Focus

1. 같은 대상이 앞으로 나가 `N` 이 `P` 의 후손이 됐다. → 아무것도 이어받지 않는다(되돌린 줄이 묻히지 않게). — Task 1 단위·Task 2 E2E.
2. 이어받은 파일의 체크를 풀고 새로고침한다. → 계속 '안 봄'이다(`viewed:false` 우선). — Task 2 E2E.
3. P-diff 가 실패하거나 5초를 넘긴다. → 목록이 뜨고 지금 동작이다. 늦은 결과로 상태가 바뀌지 않는다. — Task 2 E2E.
4. 이름 변경의 원래 경로가 지금 diff 에서 삭제로 보인다. → (a) 로 확인함이 되지 않는다. — Task 1 단위.
5. 기록을 쓴 뒤 다음 계산이 다시 이어받기를 돌려 무한 반복하지 않는다. — Task 2 E2E(쓰기 횟수).

---

### Task 1: core — P-diff 파일 목록과 이어받기 판정

**Files:**
- Modify: `packages/core/src/local.ts` — `loadLocalRange` 를 추출하고 `loadLocalSnapshot` 이 그것을 쓴다.
- Create: `packages/core/src/carry.ts`
- Modify: `packages/core/src/index.ts` — export.
- Test: `packages/core/test/carry.test.ts`, `packages/core/test/local.test.ts` (기존 통과 유지)

**Interfaces:**
- Produces:
  - `loadLocalRange(git: LocalGit, from: string, head: string): Promise<ChangedFile[]>`
    - from 과 head 는 SHA 다.
    - 지금 `loadLocalSnapshot` 의 raw·patch·섹션 검증·파일 구성 부분을 그대로 옮긴다.
    - `loadLocalSnapshot` 의 결과는 바뀌지 않는다.
  - `carryBases(review: Review, n: string): string[]`
    - `item.record?.viewed && item.record.base && item.record.base !== n` 인 base 들을 기록 수 내림차순으로 최대 3개 고른다.
    - 동수면 문자열 오름차순이다.
  - `targetCarry(review: Review, n: string, prev: { base: string; files: ChangedFile[] }[]): Promise<ReviewItem[]>`
    - Global Constraints 의 '건드리지 않는 파일'과 (a)·(b) 규칙으로 이어받을 item 을 돌려준다.
    - prev 는 조상 판정을 이미 통과한 `P` 만 담는다. 조상 판정은 호출자가 한다.
    - 같은 item 은 한 번만 돌려준다.

- [ ] **Step 1: 실패 테스트** — `carry.test.ts`. buildReview 로 리뷰를 만들고, 기록은 `markRecord` 로 만든다.
  - `carryBases picks viewed records whose base differs, most first, at most 3`
  - `(a) a file absent from the P-diff is carried`
  - `(a) a path that is a rename source in the P-diff is not carried`
  - `(b) a P-viewed file whose P-diff fingerprint matches is carried; a changed one is not`
  - `viewed:false, base===N, already viewed, and others files are never carried`
  - `with two P, a file qualifies through either`
  - `local.test.ts` 의 `loadLocalRange returns the same files as loadLocalSnapshot for mb..head`
- [ ] **Step 2: 실패 확인** — `pnpm --filter @viewed/core test` → 새 테스트가 FAIL 한다.
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인**
  - core 전체가 PASS 한다(기존 119 포함).
  - `cd apps/web && npx tsc --noEmit -p .` 이 0 이다.
- [ ] **Step 5: 커밋** — `feat(core): PR 대상 전환 이어받기 판정과 P-diff 파일 목록`

### Task 2: 웹 — 판정 배선, 기록 쓰기, 화면 대기

**Files:**
- Create: `apps/web/src/targetCarry.ts`
- Modify:
  - `apps/web/src/useReview.ts` — 판정 대기, 기록 쓰기, toggle 이 shownSnap 을 쓰게.
  - `apps/web/src/components/ReviewView.tsx` — 로컬일 때 `carry` 를 넘김, 로딩 표시.
  - `apps/web/src/i18n.ts` — 로딩 문구가 필요하면 추가.
- Test: `apps/web/e2e/carry.spec.ts`

**Interfaces:**
- Consumes: Task 1 `loadLocalRange`, `carryBases`, `targetCarry`, 그리고 `localGit(repo)` (`apps/web/src/localSource.ts`).
- Produces:
  - `makeCarry(repo: string): (review: Review, snap: Snapshot) => Promise<ReviewItem[]>`
    - `snap.mergeBase` 가 없으면 `[]` 다.
    - `carryBases` 의 P 마다 다음을 한다.
      - 조상 판정은 `git.mergeBase(N, P) === N && N !== P` 다.
      - 통과하면 `loadLocalRange(git, P, head)` 를 뜬다.
      - 결과는 `(P, head)` 로 캐시한다. 실패하면 `null` 로 캐시하고 그 P 는 건너뛴다.
    - 마지막에 `targetCarry` 를 부른다.
    - 캐시는 이 함수 인스턴스(클로저) 안에만 둔다.
  - `useReview(a: { …; carry?: (review: Review, snap: Snapshot) => Promise<ReviewItem[]> })`
    - buildReview 다음에 `carry` 가 있으면 5000ms 와 경주시킨다.
    - 이어받을 item 이 있으면 각각 `store.set(item.key, markRecord(item, snap.headSha, true))` 한다.
    - 그 기록을 merged 에 얹어 다시 buildReview 한 결과를 보여 준다. 그 전에는 `shown` 을 바꾸지 않는다.
    - 마감을 넘기면 첫 결과를 보여 주고, 늦게 끝난 carry 결과는 버린다(기록하지 않음).
    - 이어받을 게 없으면 바로 보여 준다.
    - `toggle` 은 `shown.snap.headSha` 를 쓴다.
  - ReviewView 는 `a.askRepo` 가 있을 때만 `useMemo(() => makeCarry(a.askRepo), [a.askRepo])` 를 넘긴다.
  - 첫 리뷰가 나오기 전에는 `data-testid="review-loading"` 을 보인다.

- [ ] **Step 1: 실패 E2E** — `carry.spec.ts`. `window.viewedDesktop` 모의는 others.spec.ts 패턴을 따른다.
  - 모의 git 은 refs 두 개(integ, test)를 갖는다.
    - integ 기준 merge-base 는 `P`, test 기준은 `N` 이다.
    - `mergeBase(N, P)` 는 `N` 을 돌려준다.
  - 파일 구성:
    - `w.ts`: integ 에서 이미 있는 파일. P-diff 에 없다.
    - `y.ts`: integ 기준 수정, test 기준 새 파일이다.
    - `z.ts`: 확인한 뒤 head 에서 바뀌었다.
  - 테스트:
    - `after switching to a target behind the old one, files equal to the old target and files reviewed there are viewed`
      - integ 로 열어 y·z 를 체크한다. test 로 다시 연다.
      - w·y 는 viewed, z 는 changed-since-viewed 다. 진행률이 맞다.
    - `carried files are written once and unchecking one keeps it unread after refresh`
      - store 에 쓴 기록 수를 센다. 이어받은 수와 같아야 한다.
      - 체크를 풀고 새로고침한 뒤에도 unread 다.
    - `when the new merge-base is not an ancestor, nothing is carried`
      - `mergeBase(N, P)` 가 다른 값을 돌려준다.
    - `a failing P-diff or one slower than 5s leaves today's behavior and the list still shows`
      - rawDiff 가 throw 하거나 6초 지연한다.
      - 목록은 6초 안에 뜨고, w 는 unread 다.
      - 7초까지 기다려도 상태가 안 바뀐다.
- [ ] **Step 2: 실패 확인** — `pnpm --filter @viewed/web exec playwright test e2e/carry.spec.ts` → FAIL 한다.
- [ ] **Step 3: 구현**
- [ ] **Step 4: 통과 확인**
  - `pnpm --filter @viewed/web test` 전체가 PASS 한다(기존 142 포함).
  - web tsc 가 0 이다.
- [ ] **Step 5: 커밋** — `feat(web): 뒤처진 대상으로 바꿔 열면 확인한 것을 이어받는다`

### Task 3: 실레포 확인 · 문서

**Files:**
- Modify: `apps/desktop/e2e/local.spec.ts` — 실레포 E2E 1개.
- Modify: `README.md` — 한 줄.

- [ ] **Step 1: 실패 E2E** — `a review opened against an older target keeps what was checked against the newer one`
  - 레포를 만든다.
    - main 에서 integ 를 딴다. integ 에 alice 가 `w.ts` 를 더하고, bob 이 `y.ts` 를 더한다.
    - integ 에서 feat 를 딴다. feat 에서 alice 가 `y.ts` 를 고치고 `z.ts` 를 더한다.
  - 앱 동작:
    - feat 를 integ 기준으로 열어 전부 체크한다.
    - base 를 main 으로 바꿔 연다.
  - 단언:
    - `w.ts`·`y.ts`·`z.ts` 가 확인함이다.
    - z 를 한 번 더 고친 커밋 뒤 새로고침하면 z 만 '확인 후 바뀜'이다.
  - launch() 는 HOME 이 격리돼 있어 '나'가 비므로 남의 파일 표시가 끼지 않는다.
- [ ] **Step 2: 실패 확인 → 구현 보완 → 통과** — `pnpm --filter @viewed/desktop test` 결과가 기존 39 passed + 1 skipped 에 새 테스트 PASS 를 더한 것이어야 한다.
- [ ] **Step 3: README 한 줄** — 로컬 폴더 모드에서 PR 대상을 뒤처진 브랜치로 바꿔 열어도 확인한 것이 이어진다.
- [ ] **Step 4: 전체 확인**
  - web tsc
  - `pnpm --filter @viewed/core test`
  - `pnpm --filter @viewed/desktop test:unit`
  - `pnpm --filter @viewed/web test`
  - `pnpm --filter @viewed/desktop test`
  - `bash scripts/prepublish-scan.sh`
  - `bash scripts/prepublish-scan.sh --history`
- [ ] **Step 5: 커밋** — `test(desktop): 대상 전환 이어받기 실레포 확인 · README`
