/** Portable paper build protocol. Source and artifacts always belong to one immutable version. */
export type PaperBuildStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type PaperArtifactKind = 'pdf' | 'log' | 'manifest' | 'synctex' | 'mapping';
export interface PaperToolchain { engine: string; image: string; bundle: string }
export interface PaperBuildInput { versionId: string; contentHash: string; entrypoint: string; toolchainId: string }
export interface PaperBuildDiagnostic { severity: 'error' | 'warning' | 'info'; message: string; path?: string; line?: number }
export interface PaperBuildArtifact { kind: PaperArtifactKind; sha256: string; bytes: number; mediaType: string; name: string }
export interface PaperBuildAttempt { number: number; status: PaperBuildStatus; startedAt: string; finishedAt: string | null; error: string | null }
export interface PaperBuild extends PaperBuildInput {
  id: string; revisionId: string; versionNumber: number; requestedBy: string; toolchain: PaperToolchain;
  status: PaperBuildStatus; attempt: number; createdAt: string; startedAt: string | null; finishedAt: string | null;
  error: string | null; diagnostics: PaperBuildDiagnostic[]; artifacts: PaperBuildArtifact[]; attempts: PaperBuildAttempt[];
}
export interface PaperBuildConfiguration { available: boolean; reason: string | null; toolchain: PaperToolchain | null; toolchainId: string | null }
export interface PaperBuildPage { builds: PaperBuild[]; nextBefore: number | null; configuration: PaperBuildConfiguration; accessEpoch: number }
export interface PaperBuildDetail { build: PaperBuild; accessEpoch: number }
export interface PaperSyncTeXPoint { path: string; line: number; page: number; x: number; y: number; width: number; height: number }
export interface PaperSyncTeXPage { page: number; width: number; height: number }
export interface PaperSyncTeXMap { origin: 'top-left'; units: 'pt'; pages: PaperSyncTeXPage[]; points: PaperSyncTeXPoint[] }
export interface PaperSyncTeX extends PaperSyncTeXMap { versionId: string; contentHash: string; accessEpoch: number }
