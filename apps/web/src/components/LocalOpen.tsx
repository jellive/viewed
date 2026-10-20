import { useEffect, useMemo, useRef, useState } from 'react';
import { desktopGit, shortRef } from '../localSource';
import { errorText, t } from '../i18n';
import { dropRecent, readRecent, type LocalReview } from '../recent';

type Info = Awaited<ReturnType<NonNullable<ReturnType<typeof desktopGit>>['info']>>;
type Auto = { repo: string; branch: string; base: string } | undefined;

// 로컬 폴더(데스크톱 전용): 고른 레포의 로컬 브랜치를 base 와 비교한다. 푸시하지 않은 커밋도 보인다
// takeAuto: 켤 때 한 번 자동으로 열 마지막 리뷰를 꺼낸다(꺼내면 사라진다)
// onCancel: 진행 중인 열기를 없던 일로(App) · recentRev: 열기에 성공해 최근 목록이 바뀌면 오른다
export function LocalOpen({ onOpen, onError, onCancel, takeAuto, recentRev }: { onOpen: (repo: string, info: Info, branch: string, base: string) => void; onError: (msg: string) => void; onCancel: () => void; takeAuto: () => Auto; recentRev: number }) {
  const git = desktopGit()!;
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState('');
  const [info, setInfo] = useState<Info | null>(null);
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  // 최근 항목을 고른 요청 번호 — 다른 항목을 고르거나 칸을 바꾸면 올라가 늦게 온 답을 버린다
  const pick = useRef(0);
  // 최근 항목으로 바꾼 레포: 칸은 고를 때 맞췄으니 [repo] effect 가 레포별 기억으로 덮지도, 다시 읽지도 않는다
  const preset = useRef<string | undefined>(undefined);
  // 최근 항목을 칸에 맞춘 횟수 — 그 전에 시작한 [repo] effect 의 늦은 답은 칸을 덮지 않는다.
  // pick 번호와 따로 둔다: 폴더 추가를 눌렀다 취소해도 pick 은 오르는데, 그때 첫 info 를 버리면 브랜치 칸이 빈다
  const applied = useRef(0);
  const menu = useRef<HTMLDetailsElement>(null);
  const folder = useRef<HTMLSelectElement>(null);
  const [drops, setDrops] = useState(0);
  // 최근 목록은 열기 성공(recentRev)과 여기서 뺄 때(drops)만 바뀐다
  const history = useMemo(() => readRecent().history, [recentRev, drops]);

  useEffect(() => {
    git.list().then((l) => {
      setRepos(l);
      // 마지막으로 연 로컬 레포부터(그 뒤에 GitHub 를 열었어도) — 목록에 없으면 첫 레포
      const lr = readRecent().localRepo;
      setRepo((r) => r || (lr !== undefined && l.includes(lr) ? lr : l[0]) || '');
    }).catch((e) => onError(errorText(e)));
    // 바깥을 누르면 최근 목록을 닫는다
    const close = (e: PointerEvent) => { if (menu.current?.open && !menu.current.contains(e.target as Node)) menu.current.open = false; };
    document.addEventListener('pointerdown', close);
    return () => { takeAuto(); pick.current++; document.removeEventListener('pointerdown', close); };   // 정하기 전에 화면을 떠나면 자동 열기도 최근 고르기도 없던 일로
  }, []);
  useEffect(() => {
    const p = preset.current;
    preset.current = undefined;
    if (p === repo) return;
    setInfo(null);
    if (!repo) return;
    let live = true;
    const at = applied.current;
    git.info(repo).then((i) => {
      if (!live || at !== applied.current) return;
      setInfo(i);
      const heads = i.refs.filter((r) => r.startsWith('refs/heads/'));
      // 이 레포에서 마지막으로 연 브랜치·base 는 각자 아직 있으면 쓴다 — 고정 base 로 기능 브랜치를 오가다 브랜치를 지워도 base 는 남게.
      // 단 base 가 고른 브랜치와 같으면(지운 브랜치 대신 체크아웃이 기억한 base 일 때) main...main 이 되므로 규칙 값
      const mem = readRecent().local[repo];
      const b = mem && heads.includes(mem.branch) ? mem.branch : i.current && heads.includes(i.current) ? i.current : heads[0] ?? '';
      const bs = mem && i.refs.includes(mem.base) && mem.base !== b ? mem.base
        : i.defaultBase ?? i.refs.find((r) => r === 'refs/heads/main' || r === 'refs/heads/master') ?? '';
      setBranch(b); setBase(bs);
      // 고르기와 자동 열기를 이 응답 하나에서 정한다. 처음 정해지는 레포가 권한을 쓴다 — 그 사이 레포를 바꿨으면 다른 레포라 안 연다
      const a = takeAuto();
      if (a && a.repo === repo && a.branch === b && a.base === bs) onOpen(repo, i, b, bs);
    }).catch((e) => { if (live && at === applied.current) { takeAuto(); onError(errorText(e)); } });   // 폴더가 사라졌으면 지금처럼 오류만
    return () => { live = false; };
  }, [repo]);

  // 사용자가 레포를 바꾸면 자동 열기와 최근 고르기는 취소
  async function add() {
    takeAuto(); pick.current++;
    try {
      const picked = await git.pick();
      if (!picked) return;
      setRepos(await git.list());
      setRepo(picked);
    } catch (e) { onError(errorText(e)); }
  }

  // 최근 항목은 고를 때마다 새로 읽는다 — 같은 레포여도 들고 있던 info 는 지워진 브랜치·바뀐 origin 을 모른다
  async function openRecent(h: LocalReview) {
    const n = ++pick.current;
    if (menu.current) { menu.current.open = false; menu.current.querySelector('summary')?.focus(); }   // 숨은 항목에 포커스를 두지 않는다
    takeAuto(); onCancel();   // 앞서 시작한 열기도 없던 일로 — 이번 것이 실패해도 그게 늦게 올라오지 않게
    let i: Info;
    try { i = await git.info(h.repo); } catch (e) { if (n === pick.current) onError(errorText(e)); return; }   // 못 읽은 건 일시적일 수 있어(외장 디스크 등) 항목은 남긴다
    if (n !== pick.current) return;
    // 지워진 브랜치·base 만 확실히 죽은 항목이다. branch === base 는 거절하지 않는다 — 열기 버튼도 막지 않아 성공했던 조합이다
    if (!i.refs.some((r) => r === h.branch && r.startsWith('refs/heads/')) || !i.refs.includes(h.base)) {
      // 마지막 항목이 빠지면 목록째 사라진다 — 포커스가 거기 있었으면 폴더 select 로
      if (shown.every((g) => g === h) && menu.current?.contains(document.activeElement)) folder.current?.focus();
      dropRecent(h); setDrops((d) => d + 1); onError(t.recentGone);
      return;
    }
    if (h.repo !== repo) preset.current = h.repo;
    applied.current++;
    setRepo(h.repo); setInfo(i); setBranch(h.branch); setBase(h.base);
    onOpen(h.repo, i, h.branch, h.base);
  }

  const heads = info?.refs.filter((r) => r.startsWith('refs/heads/')) ?? [];
  // 폴더 목록에 있는 레포 것만 — 없으면 버튼도 안 그린다
  const shown = history.filter((h) => repos.includes(h.repo));
  return (
    <>
      {shown.length > 0 && (
        <details ref={menu} className="recent" data-testid="local-recent"
          onKeyDown={(e) => { if (e.key !== 'Escape' || !e.currentTarget.open) return; e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); }}
          // Tab 으로 밖에 나가면 닫는다. 갈 곳 없는 blur(창 전환 등)는 그대로 — 바깥 클릭은 pointerdown 이 닫는다
          onBlur={(e) => { const to = e.relatedTarget; if (to && e.currentTarget.open && !e.currentTarget.contains(to)) e.currentTarget.open = false; }}>
          <summary>{t.recent}</summary>
          {/* 닫힌 select 는 방향키로 훑기만 해도 change 가 나는 플랫폼이 있다 — 항목 버튼은 누를 때만 연다 */}
          <div className="recent-list">
            {shown.map((h) => (
              <button type="button" key={`${h.repo}\n${h.branch}\n${h.base}`} data-testid="recent-item" onClick={() => openRecent(h)}>
                <span>{h.repo.split('/').pop()} · {shortRef(h.branch)} ← {shortRef(h.base)}</span>
                <small>{h.repo.slice(0, h.repo.lastIndexOf('/')) || '/'}</small>
              </button>
            ))}
          </div>
        </details>
      )}
      <select ref={folder} data-testid="local-repo-select" aria-label={t.localRepo} value={repo} onChange={(e) => { takeAuto(); pick.current++; setRepo(e.target.value); }}>
        {repos.length === 0 && <option value="">{t.noFolder}</option>}
        {repos.map((r) => <option key={r} value={r}>{r.split('/').pop()}</option>)}
      </select>
      <button type="button" data-testid="local-add" onClick={add}>{t.addFolder}</button>
      <label className="ref"><span>{t.compareLabel}</span>
        <select data-testid="local-branch-select" value={branch} onChange={(e) => { pick.current++; setBranch(e.target.value); }}>
          {heads.map((r) => <option key={r} value={r}>{shortRef(r)}</option>)}
        </select>
      </label>
      <label className="ref"><span>{t.baseLabel}</span>
        <select data-testid="local-base-select" value={base} onChange={(e) => { pick.current++; setBase(e.target.value); }}>
          {!base && <option value="">—</option>}
          {info?.refs.map((r) => <option key={r} value={r}>{shortRef(r)}</option>)}
        </select>
      </label>
      <button data-testid="open-btn" className="primary" disabled={!info || !branch || !base}
        onClick={(e) => { e.preventDefault(); pick.current++; if (info) onOpen(repo, info, branch, base); }}>{t.open}</button>
    </>
  );
}
