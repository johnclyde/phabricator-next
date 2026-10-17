import type { RevisionVersion, SourceFile } from '../shared/types';
import PaperMathPreview from './PaperMathPreview';

function download(file: SourceFile, number: number) {
  const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = `v${number}-${file.path.split('/').pop() || 'source.tex'}`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function PaperComparisonPreview({ base, target, filePath, split, canRenderSource }: {
  base: RevisionVersion | null; target: RevisionVersion; filePath: string; split: boolean;
  canRenderSource: (source: string) => boolean;
}) {
  const targetFile = target.files.find(file => file.path === filePath);
  const content = (version: RevisionVersion | null, file: SourceFile | undefined) => !version
    ? <p className="info-strip">Empty base · no earlier version selected.</p>
    : !file ? <p className="info-strip">This file is absent from Version {version.number}. Choose Changes to review its removal.</p>
    : !canRenderSource(file.content) ? <p className="info-strip">This source exceeds the inline display limit. Download its exact source to read it.</p>
    : file.content.length === 0 ? <p className="info-strip">This file is empty in Version {version.number}.</p>
    : <PaperMathPreview source={file.content}/>;
  if (!split) return <div className="paper-version-preview">
    <p className="comparison-identity">Version {target.number} · <strong>{filePath}</strong> · Reading preview</p>
    {content(target, targetFile)}
    <p className="paper-preview-guidance muted small">For comments on exact text, choose Source or Changes.</p>
  </div>;
  return <div className="paper-version-preview">
    <p className="comparison-identity">{base ? `Version ${base.number}` : 'Empty base'} → Version {target.number} · <strong>{filePath}</strong> · Side-by-side preview</p>
    <p className="paper-preview-guidance muted small">Read both versions together. Choose Changes for highlighted source edits and exact-text comments.</p>
    <p className="comparison-horizontal-hint">Swipe horizontally to see both versions.</p>
    <div className="paper-preview-split-scroll" tabIndex={0} role="region" aria-label="Side-by-side paper previews">
      <div className="paper-preview-split">{(['before', 'after'] as const).map(side => {
        const version = side === 'before' ? base : target;
        const file = version?.files.find(item => item.path === filePath);
        return <section key={side} className="paper-preview-pane" data-comparison-side={side} aria-label={`${side === 'before' ? 'Base' : 'Target'} paper preview`}>
          <header><h3>{side === 'before' ? 'Base' : 'Target'} · {version ? `Version ${version.number}` : 'Empty base'}</h3>
            {version && file && <button type="button" className="text-button" onClick={() => download(file, version.number)}>Download {side === 'before' ? 'base' : 'target'} source</button>}
          </header>
          {content(version, file)}
        </section>;
      })}</div>
    </div>
  </div>;
}
