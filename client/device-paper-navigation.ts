let guard: (() => boolean) | null = null;

export function guardDevicePaperNavigation(next: () => boolean): () => void {
  guard = next;
  return () => { if (guard === next) guard = null; };
}

export function allowDevicePaperNavigation(): boolean { return guard?.() ?? true; }

export function devicePaperHref(id?: string): string {
  return id ? `#device-papers/${encodeURIComponent(id)}` : '#device-papers';
}
