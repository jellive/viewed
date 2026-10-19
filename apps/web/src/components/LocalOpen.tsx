import { useEffect, useState } from 'react';
import { desktopGit, shortRef } from '../localSource';
import { errorText, t } from '../i18n';
import { readRecent } from '../recent';

type Info = Awaited<ReturnType<NonNullable<ReturnType<typeof desktopGit>>['info']>>;
type Auto = { repo: string; branch: string; base: string } | undefined;

// 로컬 폴더(데스크톱 전용): 고른 레포의 로컬 브랜치를 base 와 비교한다. 푸시하지 않은 커밋도 보인다
// takeAuto: 켤 때 한 번 자동으로 열 마지막 리뷰를 꺼낸다(꺼내면 사라진다)
export function LocalOpen({ onOpen, onError, takeAuto }: { onOpen: (repo: string, info: Info, branch: string, base: string) => void; onError: (msg: string) => void; takeAuto: () => Auto }) {
  const git = desktopGit()!;
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState('');
  const [info, setInfo] = useState<Info | null>(null);
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');

  useEffect(() => {
    git.list().then((l) => {
      setRepos(l);
      // 마지막으로 연 로컬 레포부터(그 뒤에 GitHub 를 열었어도) — 목록에 없으면 첫 레포
      const lr = readRecent().localRepo;
      setRepo((r) => r || (lr !== undefined && l.includes(lr) ? lr : l[0]) || '');
    }).catch((e) => onError(errorText(e)));
    return () => { takeAuto(); };   // 정하기 전에 화면을 떠나면 자동 열기는 없던 일로
  }, []);
  useEffect(() => {
    setInfo(null);
    if (!repo) return;
    let live = true;
    git.info(repo).then((i) => {
      if (!live) return;
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
    }).catch((e) => { if (live) { takeAuto(); onError(errorText(e)); } });   // 폴더가 사라졌으면 지금처럼 오류만
    return () => { live = false; };
  }, [repo]);

  // 사용자가 레포를 바꾸면 자동 열기는 취소
  async function add() {
    takeAuto();
    try {
      const picked = await git.pick();
      if (!picked) return;
      setRepos(await git.list());
      setRepo(picked);
    } catch (e) { onError(errorText(e)); }
  }

  const heads = info?.refs.filter((r) => r.startsWith('refs/heads/')) ?? [];
  return (
    <>
      <select data-testid="local-repo-select" aria-label={t.localRepo} value={repo} onChange={(e) => { takeAuto(); setRepo(e.target.value); }}>
        {repos.length === 0 && <option value="">{t.noFolder}</option>}
        {repos.map((r) => <option key={r} value={r}>{r.split('/').pop()}</option>)}
      </select>
      <button type="button" data-testid="local-add" onClick={add}>{t.addFolder}</button>
      <label className="ref"><span>{t.compareLabel}</span>
        <select data-testid="local-branch-select" value={branch} onChange={(e) => setBranch(e.target.value)}>
          {heads.map((r) => <option key={r} value={r}>{shortRef(r)}</option>)}
        </select>
      </label>
      <label className="ref"><span>{t.baseLabel}</span>
        <select data-testid="local-base-select" value={base} onChange={(e) => setBase(e.target.value)}>
          {!base && <option value="">—</option>}
          {info?.refs.map((r) => <option key={r} value={r}>{shortRef(r)}</option>)}
        </select>
      </label>
      <button data-testid="open-btn" className="primary" disabled={!info || !branch || !base}
        onClick={(e) => { e.preventDefault(); if (info) onOpen(repo, info, branch, base); }}>{t.open}</button>
    </>
  );
}
