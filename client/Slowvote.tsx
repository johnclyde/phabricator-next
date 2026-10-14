import type { AppState } from '../shared/types.ts';
import type { SlowvoteView } from '../shared/slowvote.ts';
import { SuiteScreen, type SuiteForm, type SuiteField } from './SuiteScreen.tsx';
import { RemarkupBody } from './Remarkup.tsx';

const visibility: SuiteField = { name: 'responseVisibility', label: 'Who can see responses', type: 'select', options: [{ value: 'always', label: 'Everyone who can view the poll' }, { value: 'aftervote', label: 'People who have voted' }, { value: 'owner', label: 'Only the poll author' }, { value: 'closed', label: 'Everyone after the poll closes' }] };
const details: SuiteField[] = [{ name: 'title', label: 'Question', type: 'text', required: true }, { name: 'description', label: 'Description', type: 'textarea' }, visibility];
export function Slowvote({ online, state }: { online: boolean; state: AppState }) {
  const person = (id: string) => state.principals.find(item => item.id === id)?.displayName ?? id;
  return <SuiteScreen app="slowvote" title="Slowvote" online={online} state={state} forms={(record, detail) => {
    if (!record) return [{ key: 'poll', label: 'Create poll', fields: [...details, { name: 'method', label: 'Voting method', type: 'select', options: [{ value: 'single', label: 'Choose one' }, { value: 'multiple', label: 'Choose any number' }] }, { name: 'choices', label: 'Choices — one per line', type: 'textarea', required: true }], values: { responseVisibility: 'always', method: 'single' } }];
    const data = record.data as unknown as SlowvoteView;
    const forms: SuiteForm[] = [];
    if (!data.closed) {
      forms.push({ key: 'vote', label: data.ownChoiceIds.length ? 'Update your response' : 'Vote', fields: [{ name: 'choiceIds', label: data.method === 'single' ? 'Choose one option' : 'Choose one or more options', type: data.method === 'single' ? 'select' : 'multi', options: data.choices.map(option => ({ value: option.id, label: option.label })), required: true }], values: { choiceIds: data.method === 'single' ? data.ownChoiceIds[0] ?? '' : data.ownChoiceIds } });
      if (data.ownChoiceIds.length) forms.push({ key: 'withdraw', label: 'Withdraw your response', fields: [], confirm: 'Withdraw your current response?' });
    }
    forms.push({ key: 'comment', label: 'Add comment', fields: [{ name: 'body', label: 'Comment', type: 'textarea', required: true }] });
    if (detail?.canEdit) forms.push({ key: 'edit', label: 'Edit poll', fields: details, values: { title: record.title, description: data.description, responseVisibility: data.responseVisibility } }, { key: data.closed ? 'reopen' : 'close', label: data.closed ? 'Reopen poll' : 'Close poll', fields: [], confirm: data.closed ? 'Allow responses again?' : 'Close this poll to further responses?' });
    return forms;
  }} render={record => {
    const data = record.data as unknown as SlowvoteView;
    return <><p>{data.closed ? 'Closed' : 'Open'} · {data.method === 'single' ? 'Single choice' : 'Multiple choice'}</p><RemarkupBody body={data.description} contextKey={`${record.id}:${record.version}:description`} /><h3>Responses</h3>{data.resultsVisible ? <><p>{data.voterCount} {data.voterCount === 1 ? 'person has' : 'people have'} responded.</p><ul>{data.choices.map(option => { const result = data.results?.find(item => item.choiceId === option.id); return <li key={option.id}><strong>{option.label}</strong>: {result?.count ?? 0}{result?.voterIds.length ? ` — ${result.voterIds.map(person).join(', ')}` : ''}</li>; })}</ul></> : <><p>{data.responseVisibility === 'owner' ? 'Only the poll author can see responses.' : data.responseVisibility === 'closed' ? 'Responses will be visible after the poll closes.' : 'Vote to see responses.'}</p><ul>{data.choices.map(option => <li key={option.id}>{option.label}</li>)}</ul></>}{data.ownChoiceIds.length > 0 && <p>Your response: {data.choices.filter(option => data.ownChoiceIds.includes(option.id)).map(option => option.label).join(', ')}</p>}<h3>Discussion</h3>{!data.comments.length && <p>No comments yet.</p>}{data.comments.map(comment => <article key={comment.id}><p><strong>{comment.actorName}</strong> · {new Date(comment.createdAt).toLocaleString()}</p><RemarkupBody body={comment.body} contextKey={`${record.id}:comment:${comment.id}`} /></article>)}</>;
  }} />;
}
