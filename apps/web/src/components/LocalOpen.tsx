import { useEffect, useState } from 'react';
import { desktopGit, shortRef } from '../localSource';
import { errorText, t } from '../i18n';
import { readRecent } from '../recent';

type Info = Awaited<ReturnType<NonNullable<ReturnType<typeof desktopGit>>['info']>>;

// 로컬 폴더(데스크톱 전용): 고른 레포의 로컬 브랜치를 base 와 비교한다. 푸시하지 않은 커밋도 보인다
export function LocalOpen({ onOpen, onError }: { onOpen: (repo: string, info: Info, branch: string, base: string) => void; onError: (msg: string) => void }) {
  const git = desktopGit()!;
  const [repos, setRepos] = useState<string[]>([]);
  const [repo, setRepo] = useState('');
  const [info, setInfo] = useState<Info | null>(null);
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');

  useEffect(() => { git.list().then((l) => { setRepos(l); setRepo((r) => r || l[0] || ''); }).catch((e) => onError(errorText(e))); }, []);
  useEffect(() => {
    setInfo(null);
    if (!repo) return;
    let live = true;
    git.info(repo).then((i) => {
      if (!live) return;
      setInfo(i);
      const heads = i.refs.filter((r) => r.startsWith('refs/heads/'));
      // 이 레포에서 마지막으로 연 것이 아직 있으면 그것, 없으면 지금 규칙
      const mem = readRecent().local[repo];
      setBranch(mem && heads.includes(mem.branch) ? mem.branch : i.current && heads.includes(i.current) ? i.current : heads[0] ?? '');
      setBase(mem && i.refs.includes(mem.base) ? mem.base : i.defaultBase ?? i.refs.find((r) => r === 'refs/heads/main' || r === 'refs/heads/master') ?? '');
    }).catch((e) => { if (live) onError(errorText(e)); });
    return () => { live = false; };
  }, [repo]);

  async function add() {
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
      <select data-testid="local-repo-select" aria-label={t.localRepo} value={repo} onChange={(e) => setRepo(e.target.value)}>
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
