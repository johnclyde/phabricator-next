import { useMemo } from 'react';
import type { RevisionVersion, SourceFile } from '../shared/types';
import { parsePaperPreview } from '../shared/paper-preview';
import { comparePaperPreviews } from '../shared/paper-preview-comparison';
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
  const baseFile = base?.files.find(file => file.path === filePath);
  const targetFile = target.files.find(file => file.path === filePath);
  const beforeSource = baseFile?.content ?? '', afterSource = targetFile?.content ?? '';
  const parsed = useMemo(() => !split || !canRenderSource(beforeSource) || !canRenderSource(afterSource) ? null : {
    before: parsePaperPreview(beforeSource), after: parsePaperPreview(afterSource),
  }, [split, beforeSource, afterSource, canRenderSource]);
  const comparison = useMemo(() => parsed ? comparePaperPreviews(parsed.before, parsed.after) : null, [parsed]);
  const content = (version: RevisionVersion | null, file: SourceFile | undefined, side?: 'before' | 'after') => !version
    ? <p className="info-strip">Empty base · no earlier version selected.</p>
    : !file ? <p className="info-strip">This file is absent from Version {version.number}. Choose Changes to review the source edits.</p>
    : !canRenderSource(file.content) ? <p className="info-strip">This source exceeds the inline display limit. Download its exact source to read it.</p>
    : file.content.length === 0 ? <p className="info-strip">This file is empty in Version {version.number}.</p>
    : <PaperMathPreview source={file.content} parsedPreview={side ? parsed?.[side] : undefined}
        highlights={side && comparison?.status === 'ready' ? comparison[side] : undefined}
        changeKind={side && comparison?.status === 'ready' ? side === 'before' ? 'removed' : 'added' : undefined}/>;
  if (!split) return <div className="paper-version-preview">
    <p className="comparison-identity">Version {target.number} · <strong>{filePath}</strong> · Reading preview</p>
    {content(target, targetFile)}
    <p className="paper-preview-guidance muted small">For comments on exact text, choose Source or Changes.</p>
  </div>;
  return <div className="paper-version-preview">
    <p className="comparison-identity">{base ? `Version ${base.number}` : 'Empty base'} → Version {target.number} · <strong>{filePath}</strong> · Side-by-side preview</p>
    {comparison?.status === 'ready' ? comparison.changed
      ? <p className="paper-preview-guidance paper-preview-legend small"><span className="paper-preview-change" data-change-kind="removed">Removed from base</span><span className="paper-preview-change" data-change-kind="added">Added in target</span><span>Changed words and whole equations are highlighted.</span></p>
      : <p className="paper-preview-guidance muted small">No visible content changes. Source-only changes appear in Changes.</p>
      : <p className="paper-preview-guidance muted small" role="status">Change highlighting is unavailable for this comparison. {comparison?.status === 'unavailable' ? comparison.reason : 'A selected source exceeds the preview display limit.'} Read each available preview below or choose Changes to compare the source.</p>}
    <p className="paper-preview-guidance muted small">Choose Changes for exact source edits and comments.</p>
    <p className="comparison-horizontal-hint">Swipe horizontally to see both versions.</p>
    <div className="paper-preview-split-scroll" tabIndex={0} role="region" aria-label="Side-by-side paper previews">
      <div className="paper-preview-split">{(['before', 'after'] as const).map(side => {
        const version = side === 'before' ? base : target;
        const file = version?.files.find(item => item.path === filePath);
        return <section key={side} className="paper-preview-pane" data-comparison-side={side} aria-label={`${side === 'before' ? 'Base' : 'Target'} paper preview`}>
          <header><h3>{side === 'before' ? 'Base' : 'Target'} · {version ? `Version ${version.number}` : 'Empty base'}</h3>
            {version && file && <button type="button" className="text-button" onClick={() => download(file, version.number)}>Download {side === 'before' ? 'base' : 'target'} source</button>}
          </header>
          {content(version, file, side)}
        </section>;
      })}</div>
    </div>
  </div>;
}
