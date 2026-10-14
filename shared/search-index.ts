import { searchTerms, type SearchTerm } from './search';

interface Token { value: string; start: number; end: number }
interface IndexedDocument { title: Token[]; body: Token[]; text: string; length: number }
interface Posting { title: number[]; body: number[] }
export interface FullTextDocument { id: string; title: string; text: string }
export interface FullTextMatch { index: number; rank: number; snippet: string }
const normalized = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en');
function tokenize(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu)].map(match => ({ value: normalized(match[0]), start: match.index, end: match.index + match[0].length }));
}
/** A positional inverted index built from one caller's authorized snapshot.
 * Terms are Unicode words; phrase positions never cross field boundaries.
 * Prefix lookup uses the sorted term dictionary, not source-text scans. */
export class FullTextIndex {
  private readonly documents: IndexedDocument[];
  private readonly postings = new Map<string, Map<number, Posting>>();
  private readonly dictionary: string[];
  private readonly averageLength: number;
  constructor(documents: readonly FullTextDocument[]) {
    this.documents = documents.map((document, index) => {
      const title = tokenize(`${document.id} ${document.title}`), body = tokenize(document.text);
      for (const [field, tokens] of [['title', title], ['body', body]] as const) for (let position = 0; position < tokens.length; position++) {
        const word = tokens[position]!.value, term = this.postings.get(word) ?? new Map<number, Posting>(), posting = term.get(index) ?? { title: [], body: [] };
        posting[field].push(position); term.set(index, posting); this.postings.set(word, term);
      }
      return { title, body, text: document.text, length: title.length * 5 + body.length };
    });
    this.dictionary = [...this.postings.keys()].sort();
    this.averageLength = this.documents.reduce((total, document) => total + document.length, 0) / Math.max(1, this.documents.length) || 1;
  }
  private words(word: string, prefix: boolean): string[] {
    if (!prefix) return this.postings.has(word) ? [word] : [];
    let low = 0, high = this.dictionary.length;
    while (low < high) { const middle = (low + high) >>> 1; if (this.dictionary[middle]! < word) low = middle + 1; else high = middle; }
    const found: string[] = [];
    while (low < this.dictionary.length && this.dictionary[low]!.startsWith(word)) found.push(this.dictionary[low++]!);
    return found;
  }
  private matches(term: SearchTerm): { documents: Set<number>; words: string[]; positions: Map<number, number> } {
    const tokens = tokenize(term.text).map(token => token.value), last = tokens.at(-1)!;
    const tail = this.words(last, term.prefix), first = tokens.length === 1 ? tail : this.words(tokens[0]!, false);
    const candidates = new Set<number>(); for (const word of first) for (const index of this.postings.get(word)!.keys()) candidates.add(index);
    const documents = new Set<number>(), positions = new Map<number, number>();
    for (const index of candidates) {
      const document = this.documents[index]!;
      for (const field of ['body', 'title'] as const) {
        let found = false;
        for (const word of first) {
          const posting = this.postings.get(word)!.get(index); if (!posting) continue;
          for (const position of posting[field]) {
            const exact = tokens.every((token, offset) => { const current = document[field][position + offset]?.value; return offset === tokens.length - 1 && term.prefix ? current?.startsWith(token) : current === token; });
            if (exact) { documents.add(index); if (field === 'body' && !positions.has(index)) positions.set(index, position); found = true; break; }
          }
          if (found) break;
        }
      }
    }
    return { documents, words: [...tokens.slice(0, -1), ...tail], positions };
  }
  private snippet(index: number, position = 0): string {
    const document = this.documents[index]!, tokens = document.body;
    if (!tokens.length) return document.text.slice(0, 240);
    const first = Math.max(0, position - 12), last = Math.min(tokens.length - 1, first + 35);
    const start = first ? tokens[first]!.start : 0, end = last < tokens.length - 1 ? tokens[last]!.end : document.text.length;
    const excerpt = document.text.slice(start, Math.min(end, start + 500)).replace(/\s+/gu, ' ').trim();
    return `${start ? '… ' : ''}${excerpt}${end < document.text.length || end > start + 500 ? ' …' : ''}`;
  }
  search(text: string): FullTextMatch[] {
    const terms = searchTerms(text);
    if (!terms.length) return this.documents.map((_document, index) => ({ index, rank: 0, snippet: this.snippet(index) }));
    const positive = terms.filter(term => !term.exclude).map(term => this.matches(term));
    const negative = terms.filter(term => term.exclude).map(term => this.matches(term));
    const smallest = [...positive].sort((a, b) => a.documents.size - b.documents.size)[0]!;
    const scoredWords = [...new Set(positive.flatMap(term => term.words))], count = this.documents.length;
    const result: FullTextMatch[] = [];
    for (const index of smallest.documents) {
      if (!positive.every(term => term.documents.has(index)) || negative.some(term => term.documents.has(index))) continue;
      const document = this.documents[index]!; let score = 0;
      for (const word of scoredWords) {
        const dictionary = this.postings.get(word), posting = dictionary?.get(index); if (!dictionary || !posting) continue;
        const frequency = posting.title.length * 5 + posting.body.length;
        const inverseFrequency = Math.log(1 + (count - dictionary.size + 0.5) / (dictionary.size + 0.5));
        score += inverseFrequency * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * document.length / this.averageLength));
      }
      const positions = positive.flatMap(term => term.positions.has(index) ? [term.positions.get(index)!] : []);
      result.push({ index, rank: -score, snippet: this.snippet(index, positions.length ? Math.min(...positions) : 0) });
    }
    return result;
  }
}
