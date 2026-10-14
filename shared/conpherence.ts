/** Private conversations. Messages are attributed to the authenticated author. */
export interface ConpherenceMessage { number: number; authorId: string; authorName: string; body: string; createdAt: string }
export interface ConpherenceParticipant { id: string; displayName: string }
export interface ConpherenceData extends Record<string, unknown> {
  topic: string;
  participants: ConpherenceParticipant[];
  messages: ConpherenceMessage[];
  readThrough: Record<string, number>;
  archivedBy: string[];
  /** These viewer-specific values are calculated on read, never accepted as input. */
  unreadCount?: number;
  archived?: boolean;
}
export function conpherenceUnread(data: ConpherenceData, principalId: string): number {
  const seen = data.readThrough[principalId] || 0;
  return data.messages.filter(message => message.number > seen && message.authorId !== principalId).length;
}
