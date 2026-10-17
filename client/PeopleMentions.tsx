import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import type { PublicAccount } from '../shared/auth';
import type { MentionProof } from '../shared/mentions';
import { insertMention, mentionParts, mentionPeople, verifiedMentionProof } from './people-mentions';

export function MentionedText({ body, mentions }: { body: string; mentions?: MentionProof }) {
  const [verified, setVerified] = useState<{ body: string; source: MentionProof; proof: MentionProof } | null>(null);
  useEffect(() => {
    let current = true;
    void verifiedMentionProof(body, mentions).then(proof => { if (current) setVerified(proof && mentions ? { body, source: mentions, proof } : null); });
    return () => { current = false; };
  }, [body, mentions]);
  if (!verified || verified.body !== body || verified.source !== mentions) return <>{body}</>;
  return <>{mentionParts(body, verified.proof).map((part, index) => part.person ? <span className="person-mention" key={index} title={`${part.person.displayName} (${part.text})`} aria-label={`${part.text}, ${part.person.displayName}`}>{part.text}</span> : part.text)}</>;
}

/** This only changes the existing text draft; submission resolves recipients. */
export function MentionPicker({ textareaRef, value, onChange, principals, disabled = false, maxLength = 20000 }: {
  textareaRef: RefObject<HTMLTextAreaElement | null>; value: string; onChange: (value: string) => void;
  principals: PublicAccount[]; disabled?: boolean; maxLength?: number;
}) {
  const id = useId(), [query, setQuery] = useState(''), [chosen, setChosen] = useState(''), [error, setError] = useState('');
  const frame = useRef<number | null>(null), people = useMemo(() => mentionPeople(principals, query), [principals, query]), shown = people.slice(0, 50), person = shown.find(item => item.id === chosen);
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  const insert = () => {
    const textarea = textareaRef.current;
    if (disabled || !person || !textarea || textarea.value !== value) return;
    try {
      const next = insertMention(value, textarea.selectionStart, textarea.selectionEnd, person.username, maxLength);
      onChange(next.body); setError('');
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => { frame.current = null; const input = textareaRef.current; if (input && !input.disabled && input.value === next.body) { input.focus(); input.setSelectionRange(next.caret, next.caret); } });
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not insert this mention.'); }
  };
  return <details className="mention-picker"><summary>Mention a person</summary><div className="mention-picker-fields"><label htmlFor={`${id}-query`}>Find a person<input id={`${id}-query`} type="search" value={query} disabled={disabled} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) event.preventDefault(); }} onChange={event => { setQuery(event.target.value); setChosen(''); setError(''); }} placeholder="Name or username"/></label><label htmlFor={`${id}-person`}>Person to mention<select id={`${id}-person`} value={person?.id || ''} disabled={disabled} onChange={event => { setChosen(event.target.value); setError(''); }}><option value="">Choose a person…</option>{shown.map(item => <option value={item.id} key={item.id}>{item.displayName} (@{item.username})</option>)}</select></label><button type="button" className="button" disabled={disabled || !person} onClick={insert}>Insert Mention</button></div>{people.length > shown.length && <p className="muted small">Showing the first 50 matches. Refine your search to find another person.</p>}<p className="muted small">A mention can notify this person when the comment is saved, if their access and mute preference allow it.</p>{error && <p className="error-text" role="alert">{error}</p>}</details>;
}
