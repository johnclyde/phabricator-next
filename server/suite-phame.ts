import { randomUUID } from 'node:crypto';
import type { PhameBlogData, PhamePostData, PhamePostRevision, PhamePostStatus } from '../shared/phame.ts';
import type { SuiteRecord } from '../shared/suite.ts';
import type { SuiteContext, SuiteModule } from './suite-contract.ts';
import { HttpError, object, optionalString, string } from './validation.ts';

const blogData = (record: SuiteRecord): PhameBlogData => record.data as unknown as PhameBlogData;
const postData = (record: SuiteRecord): PhamePostData => record.data as unknown as PhamePostData;
function blog(id: string, context: SuiteContext): SuiteRecord {
  const record = context.get(id);
  if (record.app !== 'phame' || record.kind !== 'blog') throw new HttpError(404, 'Blog was not found.');
  return record;
}
function people(value: unknown, context: SuiteContext, fallback: string[]): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string')) throw new HttpError(400, 'Choose at most 100 people.');
  const ids = [...new Set(value as string[])];
  for (const id of ids) context.requirePerson(id);
  return ids;
}
function active(record: SuiteRecord): void { if (blogData(record).status !== 'active') throw new HttpError(409, 'Restore the blog before publishing or adding content.'); }
function canEditBlog(record: SuiteRecord, context: SuiteContext): boolean { return record.ownerId === context.actor.principalId || record.access.editorIds.includes(context.actor.principalId); }
function postRevision(record: SuiteRecord, data: PhamePostData, title: string, context: SuiteContext): PhamePostRevision {
  return { version: record.version + 1, title, subtitle: data.subtitle, body: data.body, status: data.status, actorId: context.actor.principalId, createdAt: context.now };
}
function updatePost(record: SuiteRecord, data: PhamePostData, title: string, context: SuiteContext, summary: string) {
  return { title, data: { ...data, revisions: [...data.revisions, postRevision(record, data, title, context)] }, summary };
}
export const phameModule: SuiteModule = {
  app: 'phame', prefix: 'J',
  creationAccessSource(input, context) { return input.kind === 'post' ? blog(string(input.blogId, 'Blog ID', 120), context).id : null; },
  accessSource(record) { return record.kind === 'post' ? postData(record).blogId : null; },
  create(input, context) {
    const candidate = object(input, ['kind', 'title', 'subtitle', 'description', 'authorIds', 'editorIds', 'blogId', 'body']);
    if (candidate.kind === 'blog') {
      const value = object(candidate, ['kind', 'title', 'subtitle', 'description', 'authorIds', 'editorIds']);
      const authorIds = people(value.authorIds, context, [context.actor.principalId]), editorIds = people(value.editorIds, context, []);
      return { kind: 'blog', title: string(value.title, 'Blog name', 255), data: { description: optionalString(value.description, 'Description'), subtitle: optionalString(value.subtitle, 'Subtitle', 255), status: 'active', authorIds, editorIds }, access: { editorIds, memberIds: [...new Set([...(context.creationAccess?.memberIds ?? []), ...authorIds, ...editorIds])] }, summary: 'Created the blog.' };
    }
    if (candidate.kind !== 'post') throw new HttpError(400, 'Choose a blog or post.');
    const value = object(candidate, ['kind', 'title', 'subtitle', 'blogId', 'body']);
    const parent = blog(string(value.blogId, 'Blog ID', 120), context); active(parent);
    if (!context.canEdit(parent) && !blogData(parent).authorIds.includes(context.actor.principalId)) throw new HttpError(403, 'Only blog authors and editors may create posts.');
    const title = string(value.title, 'Post title', 255), body = optionalString(value.body, 'Post body', 500_000), subtitle = optionalString(value.subtitle, 'Subtitle', 255);
    return { kind: 'post', title, access: { ...parent.access }, data: { blogId: parent.id, subtitle, body, status: 'draft', publishedAt: null, comments: [], revisions: [{ version: 1, title, subtitle, body, status: 'draft', actorId: context.actor.principalId, createdAt: context.now }] }, summary: 'Created a draft post.' };
  },
  canView(record, context) {
    if (record.kind === 'blog') return true;
    const data = postData(record), parent = blog(data.blogId, context);
    return data.status === 'published' || record.ownerId === context.actor.principalId || context.canEdit(parent);
  },
  canEdit(record, context) {
    if (record.kind === 'blog') return canEditBlog(record, context);
    return record.ownerId === context.actor.principalId || context.canEdit(blog(postData(record).blogId, context));
  },
  command(record, action, input, context) {
    if (record.kind === 'blog') {
      context.requireEdit(record); const data = blogData(record);
      if (action === 'edit') {
        const value = object(input, ['title', 'description', 'subtitle']);
        return { title: string(value.title, 'Blog name', 255), data: { ...data, subtitle: optionalString(value.subtitle, 'Subtitle', 255), description: optionalString(value.description, 'Description') }, summary: 'Updated blog details.' };
      }
      if (action === 'members') {
        const value = object(input, ['authorIds', 'editorIds']);
        const authorIds = people(value.authorIds, context, data.authorIds), editorIds = people(value.editorIds, context, record.access.editorIds);
        const oldRoles = new Set([...data.authorIds, ...data.editorIds, ...record.access.editorIds]);
        return { data: { ...data, authorIds, editorIds }, access: { editorIds, memberIds: [...new Set([...record.access.memberIds.filter(id => !oldRoles.has(id)), ...authorIds, ...editorIds])] }, summary: 'Updated blog authors and editors.' };
      }
      if (action === 'archive' || action === 'restore') { object(input, []); return { data: { ...data, status: action === 'archive' ? 'archived' : 'active' }, summary: action === 'archive' ? 'Archived the blog.' : 'Restored the blog.' }; }
      throw new HttpError(400, 'Unknown blog action.');
    }
    const data = postData(record), parent = blog(data.blogId, context);
    if (action === 'comment') {
      active(parent);
      const value = object(input, ['body']);
      if (data.status !== 'published') throw new HttpError(409, 'Publish the post before adding a discussion comment.');
      return { data: { ...data, comments: [...data.comments, { id: randomUUID(), actorId: context.actor.principalId, actorName: context.actor.displayName, body: string(value.body, 'Comment', 20_000), createdAt: context.now }] }, summary: 'Commented on the post.' };
    }
    context.requireEdit(record);
    if (action === 'edit') {
      active(parent);
      if (data.status === 'archived') throw new HttpError(409, 'Restore the post before editing.');
      const value = object(input, ['title', 'subtitle', 'body']);
      return updatePost(record, { ...data, body: optionalString(value.body, 'Post body', 500_000), subtitle: optionalString(value.subtitle, 'Subtitle', 255) }, string(value.title, 'Post title', 255), context, 'Updated post content.');
    }
    if (['publish', 'unpublish', 'archive', 'restore'].includes(action)) {
      object(input, []);
      let status: PhamePostStatus;
      if (action === 'publish') { active(parent); if (data.status !== 'draft') throw new HttpError(409, 'Only a draft can be published.'); if (!data.body.trim()) throw new HttpError(400, 'Write the post before publishing.'); status = 'published'; }
      else if (action === 'unpublish') { if (data.status !== 'published') throw new HttpError(409, 'Only a published post can be unpublished.'); status = 'draft'; }
      else if (action === 'archive') { if (data.status === 'archived') throw new HttpError(409, 'The post is already archived.'); status = 'archived'; }
      else { if (data.status !== 'archived') throw new HttpError(409, 'Only an archived post can be restored.'); status = 'draft'; }
      return updatePost(record, { ...data, status, publishedAt: status === 'published' ? context.now : null }, record.title, context, ({ publish: 'Published the post.', unpublish: 'Unpublished the post.', archive: 'Archived the post.', restore: 'Restored the post as a draft.' } as Record<string, string>)[action]!);
    }
    throw new HttpError(400, 'Unknown post action.');
  },
  present(record, context) {
    if (record.kind === 'blog') return { ...record, data: { ...record.data, editorIds: [...record.access.editorIds] } };
    const data = postData(record);
    if (context.canEdit(record)) return record;
    return { ...record, data: { ...data, revisions: data.revisions.filter(revision => revision.status === 'published') } };
  },
};
