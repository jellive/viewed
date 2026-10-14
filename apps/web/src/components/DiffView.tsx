export function DiffView({ patch }: { patch?: string }) {
  if (patch === undefined) return <p data-testid="no-patch">No text diff (binary or too large). You can still mark it viewed.</p>;
  return (
    <pre data-testid="diff" className="diff">
      {patch.split('\n').map((l, i) => (
        <div key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>{l}</div>
      ))}
    </pre>
  );
}
