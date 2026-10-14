import type { AppState } from '../shared/types.ts';
import type { PhameBlogData, PhamePostData } from '../shared/phame.ts';
import { SuiteScreen, type SuiteField, type SuiteForm } from './SuiteScreen.tsx';
import { RemarkupBody } from './Remarkup.tsx';
const title: SuiteField = { name: 'title', label: 'Title', type: 'text', required: true };
const subtitle: SuiteField = { name: 'subtitle', label: 'Subtitle', type: 'text' };
const postFields: SuiteField[] = [title, subtitle, { name: 'body', label: 'Post body', type: 'textarea' }];
const blogFields: SuiteField[] = [title, subtitle, { name: 'description', label: 'Description', type: 'textarea' }];
export function Phame({ online, state }: { online: boolean; state: AppState }) {
  const people = state.principals.filter(person => !person.disabled).map(person => ({ value: person.id, label: person.displayName }));
  const members: SuiteField[] = [{ name: 'authorIds', label: 'Authors — may create posts', type: 'multi', options: people }, { name: 'editorIds', label: 'Editors — may manage this blog and every post', type: 'multi', options: people }];
  const name = (id: string) => state.principals.find(person => person.id === id)?.displayName ?? id;
  return <SuiteScreen app="phame" title="Phame" online={online} state={state} forms={(record, detail, records) => {
    if (!record) return [{ key: 'blog', label: 'Create blog', fields: [...blogFields, ...members], values: { authorIds: [state.currentPrincipalId], editorIds: [] } }, { key: 'post', label: 'Write a post', fields: [{ name: 'blogId', label: 'Blog ID', type: 'text', required: true, options: records?.filter(item => item.kind === 'blog').map(item => ({ value: item.id, label: item.title })), hint: 'Choose a listed blog or enter its ID.' }, ...postFields] }];
    const forms: SuiteForm[] = [];
    if (record.kind === 'blog') {
      const data = record.data as unknown as PhameBlogData;
      if (detail?.canEdit) forms.push({ key: 'edit', label: 'Edit blog', fields: blogFields, values: { title: record.title, subtitle: data.subtitle, description: data.description } }, { key: 'members', label: 'Manage authors and editors', fields: members, values: { authorIds: data.authorIds, editorIds: data.editorIds } }, { key: data.status === 'active' ? 'archive' : 'restore', label: data.status === 'active' ? 'Archive blog' : 'Restore blog', fields: [], confirm: data.status === 'active' ? 'Archive the blog? Existing published posts remain readable.' : 'Restore the blog?' });
    } else {
      const data = record.data as unknown as PhamePostData;
      if (data.status === 'published') forms.push({ key: 'comment', label: 'Add comment', fields: [{ name: 'body', label: 'Comment', type: 'textarea', required: true }] });
      if (detail?.canEdit) {
        if (data.status !== 'archived') forms.push({ key: 'edit', label: 'Edit post', fields: postFields, values: { title: record.title, subtitle: data.subtitle, body: data.body } });
        const action = data.status === 'draft' ? 'publish' : data.status === 'published' ? 'unpublish' : 'restore';
        forms.push({ key: action, label: action === 'publish' ? 'Publish post' : action === 'unpublish' ? 'Return to draft' : 'Restore as draft', fields: [], confirm: action === 'publish' ? 'Publish this post to everyone allowed to view the blog?' : action === 'unpublish' ? 'Make this post visible only to its author and blog editors?' : 'Restore this post as a draft?' });
        if (data.status !== 'archived') forms.push({ key: 'archive', label: 'Archive post', fields: [], confirm: 'Archive this post? Only its author and blog editors will be able to view it.' });
      }
    }
    return forms;
  }} render={record => {
    if (record.kind === 'blog') { const data = record.data as unknown as PhameBlogData; return <><p>{data.status === 'active' ? 'Active blog' : 'Archived blog'} · Blog ID: <strong>{record.id}</strong></p><p>{data.subtitle}</p><RemarkupBody body={data.description} contextKey={`${record.id}:${record.version}`} /><p>Authors: {data.authorIds.map(name).join(', ') || 'None'}</p><p>Editors: {[...new Set([record.ownerId, ...data.editorIds])].map(name).join(', ')}</p><p>Use this blog ID when writing a post. Published posts inherit the blog’s current audience.</p></>; }
    const data = record.data as unknown as PhamePostData;
    return <><p>{data.status} · Blog {data.blogId}{data.publishedAt ? ` · Published ${new Date(data.publishedAt).toLocaleString()}` : ''}</p><p>{data.subtitle}</p><RemarkupBody body={data.body} contextKey={`${record.id}:${record.version}:body`} /><details><summary>Content history ({data.revisions.length})</summary>{[...data.revisions].reverse().map(revision => <details key={revision.version}><summary>Version {revision.version}: {revision.title} · {revision.status} · {new Date(revision.createdAt).toLocaleString()}</summary><p>{revision.subtitle}</p><RemarkupBody body={revision.body} contextKey={`${record.id}:revision:${revision.version}`} /></details>)}</details><h3>Discussion</h3>{!data.comments.length && <p>No comments yet.</p>}{data.comments.map(comment => <article key={comment.id}><p><strong>{comment.actorName}</strong> · {new Date(comment.createdAt).toLocaleString()}</p><RemarkupBody body={comment.body} contextKey={`${record.id}:comment:${comment.id}`} /></article>)}</>;
  }} />;
}
