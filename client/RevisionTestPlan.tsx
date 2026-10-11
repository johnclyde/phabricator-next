import type { AppState } from '../shared/types';
import { revisionMetadataFields } from '../shared/revision-metadata';

export function requiresTestPlan(state: AppState): boolean { return state.revisionMetadataConfig?.requireTestPlan ?? true; }
export function creationMetadataError(fields: { title: string; summary?: string; testPlan?: string }, state: AppState): string | null {
  try { revisionMetadataFields(fields, requiresTestPlan(state)); return null; }
  catch (error) { return error instanceof Error ? error.message : 'Check the revision details before saving.'; }
}

export default function RevisionTestPlan({ value, required, change }: { value: string; required: boolean; change: (value: string) => void }) {
  return <label className="field revision-test-plan"><span>Test Plan{required ? ' (required)' : ' (optional)'}</span><textarea aria-label="Test Plan" rows={4} maxLength={100000} required={required} value={value} onChange={event => change(event.target.value)}/><small>Describe how this work was or will be tested, reviewed, or checked. This description does not record checks or reviewer decisions.</small></label>;
}
