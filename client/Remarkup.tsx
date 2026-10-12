import { Fragment, createElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MentionProof } from '../shared/mentions';
import { parseRemarkup, safeRemarkupHref, type RemarkupBlock, type RemarkupInline } from '../shared/remarkup';
import { verifiedMentionProof } from './people-mentions';
import { remarkupMentionParts } from './remarkup-rendering';

export function DiscussionBody({ body, mentions, className = '' }: { body: string; mentions?: MentionProof; className?: string }) {
  const document = useMemo(() => parseRemarkup(body), [body]);
  const [verified, setVerified] = useState<{ body: string; source: MentionProof; proof: MentionProof } | null>(null);
  const [copyStatus, setCopyStatus] = useState(''), currentBody = useRef(body), mounted = useRef(true), copyGeneration = useRef(0);
  currentBody.current = body;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; copyGeneration.current++; }; }, []);
  useEffect(() => {
    let current = true; setCopyStatus(''); copyGeneration.current++;
    if (document.fallback) { setVerified(null); return () => { current = false; }; }
    void verifiedMentionProof(body, mentions).then(proof => { if (current) setVerified(proof && mentions ? { body, source: mentions, proof } : null); });
    return () => { current = false; };
  }, [body, mentions, document.fallback]);
  const proof = verified?.body === body && verified.source === mentions ? verified.proof : null;
  const copy = async () => {
    const ticket = ++copyGeneration.current;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard is unavailable. Select the source text to copy it.');
      await navigator.clipboard.writeText(body);
      if (mounted.current && ticket === copyGeneration.current && currentBody.current === body) setCopyStatus('Exact source copied.');
    } catch (failure) {
      if (mounted.current && ticket === copyGeneration.current && currentBody.current === body) setCopyStatus(failure instanceof Error ? failure.message : 'Could not copy. Select the source text to copy it.');
    }
  };
  const inline = (nodes: RemarkupInline[], enhance = true): ReactNode => nodes.map((node, index) => {
    const key = `${node.type}:${node.start}:${node.end}:${index}`;
    switch (node.type) {
      case 'text': return <Fragment key={key}>{remarkupMentionParts(body, node, enhance ? proof : null).map((part, partIndex) => part.person ? <span className="person-mention" key={partIndex} title={`${part.person.displayName} (${part.text})`} aria-label={`${part.text}, ${part.person.displayName}`}>{part.text}</span> : part.text)}</Fragment>;
      case 'break': return node.soft ? <Fragment key={key}>{' '}</Fragment> : <br key={key}/>;
      case 'strong': return <strong key={key}>{inline(node.children, enhance)}</strong>;
      case 'em': return <em key={key}>{inline(node.children, enhance)}</em>;
      case 'del': return <del key={key}>{inline(node.children, enhance)}</del>;
      case 'underline': return <u key={key}>{inline(node.children, enhance)}</u>;
      case 'highlight': return <mark key={key}>{inline(node.children, enhance)}</mark>;
      case 'code': return <code key={key}>{inline(node.children, false)}</code>;
      case 'link': {
        const href = safeRemarkupHref(node.href), label = inline(node.children, false);
        return href ? <a key={key} href={href} rel="nofollow noopener noreferrer" referrerPolicy="no-referrer">{label}</a> : <Fragment key={key}>{label}</Fragment>;
      }
    }
  });
  const blocks = (nodes: RemarkupBlock[]): ReactNode => nodes.map((node, index) => {
    const key = `${node.type}:${node.start}:${node.end}:${index}`;
    switch (node.type) {
      case 'paragraph': return <p key={key}>{inline(node.children)}</p>;
      case 'heading': return createElement(`h${Math.max(2, Math.min(6, node.level))}`, { key }, inline(node.children));
      case 'code-block': return <div className="remarkup-code-block" key={key}>{node.language && <div className="remarkup-code-language">{node.language}</div>}<pre tabIndex={0} aria-label="Code block"><code>{inline(node.children, false)}</code></pre></div>;
      case 'quote': return <blockquote key={key}>{node.header && <div className="remarkup-quote-header">{inline(node.header)}</div>}{blocks(node.children)}</blockquote>;
      case 'list': {
        const children = node.items.map((item, itemIndex) => <li key={`${item.start}:${itemIndex}`} className={item.checked === null ? undefined : 'remarkup-check-item'}>{item.checked !== null && <input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? 'Completed item' : 'Incomplete item'}/>}<div>{blocks(item.children)}</div></li>);
        return node.ordered ? <ol key={key} start={node.startNumber}>{children}</ol> : <ul key={key}>{children}</ul>;
      }
      case 'rule': return <hr key={key}/>;
      case 'note': return <aside className={`remarkup-note remarkup-${node.kind}`} key={key} aria-label={node.kind}>{node.showLabel && <strong className="remarkup-note-label">{node.kind === 'note' ? 'NOTE' : node.kind === 'warning' ? 'WARNING' : 'IMPORTANT'}:</strong>}{blocks(node.children)}</aside>;
      case 'literal': return <div className="remarkup-literal" key={key}>{node.text}</div>;
    }
  });
  return <div className="discussion-body"><div className={`remarkup-content ${className}`.trim()}>{blocks(document.blocks)}</div>{document.fallback && <div className="remarkup-fallback">This comment is shown as plain text because its formatting exceeds the supported limit.</div>}<details className="remarkup-source"><summary>Source</summary><pre tabIndex={0} aria-label="Exact comment source">{body}</pre><div className="remarkup-copy"><button className="button" type="button" onClick={() => void copy()}>Copy Source</button>{copyStatus && <span role="status">{copyStatus}</span>}</div></details></div>;
}
