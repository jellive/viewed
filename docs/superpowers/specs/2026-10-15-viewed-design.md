# viewed — push 된 브랜치를 PR 전에 파일별로 검토하는 앱 (설계)

작성 2026-10-15. 설계 레인: agy 블라인드(gemini-3.8-flash-high) · codex 레드팀(gpt-6.1-sol, REVISE → 반영). cursor 는 레포가 없어 미실시.

## 1. 왜

AI 가 코드를 짜고 커밋·push 까지 한다. Jell 은 PR 을 열기 전에 브랜치 전체를 직접 검토한다.
GitHub PR 의 "Viewed" 체크가 필요한데 PR 을 열기 전엔 쓸 수 없다. 수정 커밋이 올라오면 **바뀐 파일만** 다시 봐야 한다.

## 2. 완료 조건

1. 계정·레포·브랜치를 고르면 `base...브랜치` 의 변경 파일 목록과 파일별 diff 가 보인다.
2. 파일을 viewed 로 체크하면 진행률(N/M)이 오르고 그 파일 diff 가 접힌다.
3. 그 파일의 diff 를 바꾸는 커밋이 push 된 뒤 새로고침하면 **그 파일만** unread 가 되고, "본 이후 변경"을 볼 수 있다.
4. 맥에서 체크한 것이 폰에서 보이고, 반대도 된다.
5. 목록이 잘렸거나 diff 를 못 받은 파일이 있으면 "전부 봤다"가 나오지 않는다.

## 3. 범위

- 포함: GitHub(github.com) 레포, 사용자 1명, 계정 2개(개인 계정 / 회사 계정), 맥 Electron 앱 + 폰 PWA.
- 제외: 코멘트·리뷰 제출·PR 생성, hunk 단위 체크, GitHub 외 호스트, 서버.

## 4. 구조

```
packages/core   (TS, UI 없음)  GitHub 호출 · 지문 계산 · 판정 · 동기화 병합
apps/web        (React + Vite) 화면. 같은 빌드를 두 곳에서 쓴다
  ├─ PWA        폰 브라우저 (정적 호스팅)
  └─ Electron   맥. 같은 빌드를 로드, 토큰은 keychain
```

데이터는 브라우저/앱 → `api.github.com` 직접 호출. 서버 없음.

## 5. 데이터와 판정

### 5.1 목록
- `GET /repos/{o}/{r}/compare/{base}...{head}` 를 화면을 열 때 1번 부르고, 응답의 head 커밋 SHA 를 **스냅샷**으로 고정한다. 목록·diff·체크 기록은 모두 이 스냅샷 기준이다(목록과 본문이 다른 head 를 보는 일 방지).
- `files.length == 300` 이면 "목록 불완전"(GitHub 이 300개에서 자른다 — 300개와 잘림을 구분할 수 없다). 이때 진행률은 표시하되 완료 판정을 막는다.
- base 기본값은 레포 기본 브랜치. 바꿀 수 있다.

### 5.2 diff 지문 — unread 판정의 키
파일마다 `fingerprint = sha256(status ‖ previous_filename ‖ mode ‖ patch 또는 blob_sha)`.
- patch 가 있으면 patch 를 쓴다 → base 쪽이 바뀌어(main 을 merge·rebase) diff 가 달라져도 잡힌다.
- patch 가 없으면(바이너리·큰 파일) blob sha 를 쓴다. 이 파일은 "본문 미표시, 체크만 가능".
- 삭제 파일은 status=removed 로 지문이 정해진다(head blob 없음).
- mode 는 compare 응답에 없다 → 구현 계획에서 얻는 방법(트리 API 1회 등)을 정한다. 못 얻으면 이 축은 빠진다고 명시.

**판정:** 기록된 지문 == 현재 지문 → viewed. 다르거나 기록 없음 → unread.
- rename: 새 경로는 새 검토 대상(unread).
- 되돌렸다가 같은 diff 로 돌아오면 viewed 로 남는다 — 의도된 동작(최종 diff 가 본 것과 같다).

### 5.3 본 이후 변경
체크할 때 그 파일의 head blob sha 도 기록한다. unread 가 된 파일은
`GET /git/blobs/{기록된 blob}` 과 `GET /git/blobs/{현재 blob}` 를 받아 화면에서 diff 한다.
옛 blob 이 404 면 "이후 변경 조회 불가"로 표시하고 전체 diff 로 보여 준다.

## 6. 동기화 — 비공개 gist

- jellive 계정의 secret gist 1개. 안에 **기기별 파일**: `device-<id>.json`. 각 기기는 자기 파일만 쓴다 → 동시에 체크해도 서로 덮지 않는다.
- 읽을 때 모든 기기 파일을 합친다. 같은 키가 여러 기기에 있으면 `at` 이 늦은 쪽.
- 기록: `{ key: { fp, blob, head, at, viewed } }`. 체크 해제는 `viewed:false` 기록(삭제가 아니라 덮기).
- **키는 HMAC-SHA256(비밀키, "owner/repo|branch|path")**. secret gist 는 URL 을 알면 읽힌다 — 회사 레포·브랜치·경로 이름이 남지 않게 한다. 비밀키는 기기 설정 때 한 번 입력(두 기기에 같은 값).
- 쓰기는 1.5초 모아서 한 번. 폰에서 화면을 떠날 때(`visibilitychange`) 즉시 보낸다.

## 7. 인증

- GitHub **fine-grained PAT**, 계정별 1개(소유자 1개에 묶임). 권한: Contents·Metadata 읽기. jellive 토큰만 Gists 쓰기 추가.
- 맥(Electron): `safeStorage` 로 암호화해 앱 데이터 폴더에 저장. 복호화 실패 시 재입력.
- 폰(PWA): 브라우저 저장소. 같은 출처의 스크립트가 읽을 수 있다 — 위험 수용: 읽기 전용 + 짧은 만료(90일) + 외부 스크립트 0개(CSP).
- 토큰은 gist 에 넣지 않는다.

## 8. 오류 상태

화면이 구분해 보여 줄 것: 목록 불완전 · diff 조회 실패 · 이후 변경 조회 불가 · 동기화 대기 · 동기화 실패 · 토큰 만료/권한 없음.
어느 것도 "viewed" 나 "완료"로 표시하지 않는다.

## 9. 기술 고정 (구현 계획에서 ctx7 로 버전별 재확인)

- Electron 44.x (2026-10-15 최신 안정 44.7.2). ⚠ safeStorage 동기 API 제거는 main 브랜치(46) 문서 얘기다 — 44 문서로 다시 본다.
- Vite 8.x, vite-plugin-pwa 2.x, React.
- 테스트: core 는 단위 테스트(지문·판정·병합·잘림), 화면은 Playwright.

## 10. 구현 전 게이트 (Jell)

- 회사 org 가 fine-grained PAT 를 허용하는지. 막혀 있으면 회사 레포는 v1 범위에서 빠진다.

## 11. 기각한 대안

- Electron + React Native: 화면을 두 번 짠다, 개인 iOS 배포 중단(2026-10-08) — PWA 로 결정(Jell 2026-10-15).
- gist JSON 하나를 두 기기가 같이 쓰기: 동시 체크 유실 — 기기별 파일로.
- 커밋 compare 로 "본 이후 변경": force-push 에 약함 — blob 직접 비교로.
- 맥이 스냅샷을 만들어 폰에 주기 / 작은 서버: 서버·저장 부담 — v1 범위 밖.

## 12. 레인 지적 처리

17건 전부 채택/반박/미확인으로 처리 — 작업 기록 `lane-triage.md`(세션 스크래치패드). 반박 2건: 되돌림 후 동일 diff 의 viewed 유지(의도), gist If-Match(문서 근거 없음, 기기별 파일로 불필요).
