/** Native Slowvote ballots. Restricted ballots are projected by the server. */
export type SlowvoteMethod = 'single' | 'multiple';
export type SlowvoteVisibility = 'always' | 'aftervote' | 'owner' | 'closed';
export interface SlowvoteChoice { id: string; label: string }
export interface SlowvoteBallot { actorId: string; choiceIds: string[]; updatedAt: string }
export interface SlowvoteComment { id: string; actorId: string; actorName: string; body: string; createdAt: string }
export interface SlowvoteData {
  description: string; method: SlowvoteMethod; responseVisibility: SlowvoteVisibility;
  choices: SlowvoteChoice[]; closed: boolean; ballots: SlowvoteBallot[]; comments: SlowvoteComment[];
}
export interface SlowvoteView extends Omit<SlowvoteData, 'ballots'> {
  ownChoiceIds: string[]; resultsVisible: boolean;
  results: { choiceId: string; count: number; voterIds: string[] }[] | null;
  voterCount: number | null;
}
export function slowvoteResultsVisible(data: Pick<SlowvoteData, 'responseVisibility' | 'closed' | 'ballots'>, ownerId: string, actorId: string): boolean {
  return data.responseVisibility === 'always' || (data.responseVisibility === 'aftervote' && data.ballots.some(ballot => ballot.actorId === actorId)) || (data.responseVisibility === 'owner' && ownerId === actorId) || (data.responseVisibility === 'closed' && data.closed);
}
