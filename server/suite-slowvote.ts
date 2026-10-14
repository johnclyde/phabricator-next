import { randomUUID } from 'node:crypto';
import { slowvoteResultsVisible, type SlowvoteData, type SlowvoteView } from '../shared/slowvote.ts';
import type { SuiteRecord } from '../shared/suite.ts';
import type { SuiteModule } from './suite-contract.ts';
import { choice, HttpError, object, optionalString, string } from './validation.ts';

const poll = (record: SuiteRecord): SlowvoteData => record.data as unknown as SlowvoteData;
const fields = ['title', 'description', 'responseVisibility'];
function choiceLabels(value: unknown): string[] {
  const values = typeof value === 'string' ? value.split(/\r?\n/).filter(item => item.trim()) : value;
  if (!Array.isArray(values) || values.length < 2 || values.length > 100) throw new HttpError(400, 'Provide between 2 and 100 poll choices.');
  const labels = values.map(item => string(item, 'Poll choice', 500).trim());
  if (new Set(labels).size !== labels.length) throw new HttpError(400, 'Poll choices must be distinct.');
  return labels;
}
export const slowvoteModule: SuiteModule = {
  app: 'slowvote', prefix: 'V',
  create(input) {
    const value = object(input, ['kind', ...fields, 'method', 'choices']);
    if (value.kind !== undefined && value.kind !== 'poll') throw new HttpError(400, 'Create a poll.');
    return { kind: 'poll', title: string(value.title, 'Question', 255), data: {
      description: optionalString(value.description, 'Description', 100_000),
      method: choice(value.method ?? 'single', 'voting method', ['single', 'multiple']),
      responseVisibility: choice(value.responseVisibility ?? 'always', 'response visibility', ['always', 'aftervote', 'owner', 'closed']),
      choices: choiceLabels(value.choices).map((label, index) => ({ id: `option-${index + 1}`, label })),
      closed: false, ballots: [], comments: [],
    }, summary: 'Created the poll.' };
  },
  canEdit(record, context) { return record.ownerId === context.actor.principalId; },
  command(record, action, input, context) {
    const data = poll(record), actorId = context.actor.principalId;
    if (action === 'vote') {
      const value = object(input, ['choiceIds']);
      if (typeof value.choiceIds === 'string' && data.method === 'single') value.choiceIds = [value.choiceIds];
      if (data.closed) throw new HttpError(409, 'This poll is closed.');
      if (!Array.isArray(value.choiceIds) || value.choiceIds.length < 1 || value.choiceIds.length > data.choices.length || value.choiceIds.some(id => typeof id !== 'string' || !data.choices.some(option => option.id === id))) throw new HttpError(400, 'Choose valid poll options.');
      const choiceIds = [...new Set(value.choiceIds as string[])];
      if (data.method === 'single' && choiceIds.length !== 1) throw new HttpError(400, 'Choose exactly one option.');
      return { data: { ...data, ballots: [...data.ballots.filter(ballot => ballot.actorId !== actorId), { actorId, choiceIds, updatedAt: context.now }] }, summary: 'Updated a poll response.' };
    }
    if (action === 'withdraw') {
      object(input, []);
      if (data.closed) throw new HttpError(409, 'Reopen the poll before changing responses.');
      return { data: { ...data, ballots: data.ballots.filter(ballot => ballot.actorId !== actorId) }, summary: 'Withdrew a poll response.' };
    }
    if (action === 'comment') {
      const value = object(input, ['body']);
      const comment = { id: randomUUID(), actorId, actorName: context.actor.displayName, body: string(value.body, 'Comment', 20_000), createdAt: context.now };
      return { data: { ...data, comments: [...data.comments, comment] }, summary: 'Commented on the poll.' };
    }
    context.requireEdit(record);
    if (action === 'edit') {
      const value = object(input, fields);
      return { title: string(value.title, 'Question', 255), data: { ...data, description: optionalString(value.description, 'Description', 100_000), responseVisibility: choice(value.responseVisibility ?? data.responseVisibility, 'response visibility', ['always', 'aftervote', 'owner', 'closed']) }, summary: 'Updated poll details.' };
    }
    if (action === 'close' || action === 'reopen') { object(input, []); return { data: { ...data, closed: action === 'close' }, summary: action === 'close' ? 'Closed the poll.' : 'Reopened the poll.' }; }
    throw new HttpError(400, 'Unknown poll action.');
  },
  present(record, context) {
    const { ballots, ...data } = poll(record);
    const resultsVisible = slowvoteResultsVisible(poll(record), record.ownerId, context.actor.principalId);
    const view: SlowvoteView = { ...data, ownChoiceIds: ballots.find(ballot => ballot.actorId === context.actor.principalId)?.choiceIds ?? [], resultsVisible, voterCount: resultsVisible ? ballots.length : null, results: resultsVisible ? data.choices.map(option => { const voters = ballots.filter(ballot => ballot.choiceIds.includes(option.id)); return { choiceId: option.id, count: voters.length, voterIds: voters.map(ballot => ballot.actorId) }; }) : null };
    return { ...record, data: { ...view } };
  },
  presentEvents(events, record, context) {
    const visible = slowvoteResultsVisible(poll(record), record.ownerId, context.actor.principalId);
    return events.filter(event => visible || !['vote', 'withdraw'].includes(event.action) || event.actorId === context.actor.principalId);
  },
};
