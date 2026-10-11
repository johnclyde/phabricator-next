import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { FileRecord } from '../shared/files.ts';
import type { Audience } from '../shared/policy.ts';
import { Store } from '../server/store.ts';
import { POLICY_TRAVERSAL_MAX_WORK, PolicyStore, registerFilePolicy } from '../server/policy.ts';

const actor = { principalId: 'alice', displayName: 'Alice', credentialId: null, requestId: 'policy-traversal' };
const shared: Audience = { kind: 'workspace' };
const privateAudience: Audience = { kind: 'principals', principalIds: ['alice'] };
const bytes = Buffer.from('%PDF-1.4\nfixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const denied = { view: false, edit: false, interact: false, managePolicy: false };

function fixture() {
  const store = new Store({ path: ':memory:' });
  let checks = 0;
  const policies = new PolicyStore(store.database, { principalExists: id => { checks++; return id === 'alice' || id === 'bob'; } });
  function upload(): FileRecord {
    const file = store.files.upload({ name: 'figure.pdf', dataBase64: bytes.toString('base64'), sha256, bytes: bytes.length }, actor);
    registerFilePolicy(store.database, file.id, actor.principalId); return file;
  }
  function attach(fileId: string, objectId: string) { store.files.setAttachment(fileId, { objectId, mode: 'attach', expectedVersion: 0 }, actor); }
  function check<T>(operation: () => T): { result: T; checks: number } { checks = 0; const result = operation(); return { result, checks }; }
  return { store, policies, upload, attach, check };
}

function branchingGraph(context: ReturnType<typeof fixture>, depth: number, width = 4) {
  const { store, upload, attach } = context;
  const files = Array.from({ length: depth + 1 }, upload);
  for (let layer = 0; layer < depth; layer++) for (let branch = 0; branch < width; branch++) {
    const dependency = files[layer + 1]!;
    const paper = store.createRevision({ testPlan: 'Fixture verification plan.', kind: 'paper', title: `Layer ${layer}, branch ${branch}`, files: [{ path: 'main.tex', content: 'Exact source' }], assets: [{ path: 'figure.pdf', fileId: dependency.id, sha256: dependency.sha256, bytes: dependency.bytes, mediaType: 'application/pdf' }], shareAssets: true }, actor);
    store.files.setAttachment(dependency.id, { objectId: paper.revision.id, mode: 'detach', expectedVersion: 1 }, actor);
    attach(files[layer]!.id, paper.revision.id);
  }
  return files;
}

function changeView(policies: PolicyStore, id: string, view: Audience) {
  const policy = policies.policy(id, 'alice');
  policies.setPolicy(id, { expectedVersion: policy.version, spaceId: policy.spaceId, view, edit: privateAudience, interact: privateAudience }, 'alice');
}

test('branching file grants have one deterministic work budget and exhaustion fails the entire decision closed', () => {
  const context = fixture(); const { store, policies, attach, check } = context;
  try {
    const files = branchingGraph(context, 5);
    const root = files[0]!.id;
    // A valid later sibling must not turn an exhausted traversal into an allow.
    const ground = store.createTask({ title: 'Later grounded grant' }, actor);
    attach(root, ground.id);
    const first = check(() => policies.access(root, 'bob'));
    assert.deepEqual(first.result, denied);
    assert.ok(first.checks > 100 && first.checks <= POLICY_TRAVERSAL_MAX_WORK, `${first.checks} bounded node checks`);
    for (let repeat = 0; repeat < 3; repeat++) assert.deepEqual(check(() => policies.access(root, 'bob')), first);
    for (const operation of [() => policies.policy(root, 'bob'), () => policies.describe(root, 'bob'), () => policies.require(root, 'bob', 'view')]) {
      const attempt = check(() => assert.throws(operation, { status: 404, code: 'OBJECT_UNAVAILABLE' }));
      assert.ok(attempt.checks <= POLICY_TRAVERSAL_MAX_WORK);
    }
    assert.equal(check(() => policies.access(root, 'alice')).result.view, true, 'direct ownership does not traverse grants');
    changeView(policies, root, shared);
    assert.equal(check(() => policies.access(root, 'bob')).result.view, true, 'a new call sees current direct policy without cached denial');
    changeView(policies, root, privateAudience);
    assert.deepEqual(check(() => policies.access(root, 'bob')).result, denied, 'a new call cannot reuse earlier direct authority');
  } finally { store.close(); }
});

test('a grounded grant within budget works and target policy and Space revocation remain immediate', () => {
  const context = fixture(); const { store, policies, attach, check } = context;
  try {
    const files = branchingGraph(context, 2);
    const root = files[0]!.id; const terminal = files.at(-1)!.id;
    assert.equal(policies.access(root, 'bob').view, false, 'an ungrounded chain grants nothing');
    const target = store.createTask({ title: 'Visible ground' }, actor); attach(terminal, target.id);
    const allowed = check(() => policies.access(root, 'bob'));
    assert.deepEqual(allowed.result, { view: true, edit: false, interact: false, managePolicy: false });
    assert.ok(allowed.checks < POLICY_TRAVERSAL_MAX_WORK);
    changeView(policies, target.id, privateAudience); assert.equal(policies.access(root, 'bob').view, false);
    changeView(policies, target.id, shared); assert.equal(policies.access(root, 'bob').view, true);
    const space = policies.createSpace({ name: 'File boundary', view: shared, edit: privateAudience }, 'alice');
    const policy = policies.policy(terminal, 'alice');
    policies.setPolicy(terminal, { expectedVersion: policy.version, spaceId: space.id, view: privateAudience, edit: privateAudience, interact: privateAudience }, 'alice');
    assert.equal(policies.access(root, 'bob').view, true);
    policies.updateSpace(space.id, { expectedVersion: 1, view: privateAudience }, 'alice');
    assert.equal(policies.access(root, 'bob').view, false, 'an attachment does not bypass its File Space');
  } finally { store.close(); }
});

test('active grant enumeration is bounded but detached and reference histories do not consume the grant budget', () => {
  const { store, policies, upload, attach, check } = fixture();
  try {
    const file = upload();
    const template = store.createTask({ title: 'Candidate fixture' }, actor);
    const attachment = store.files.setAttachment(file.id, { objectId: template.id, mode: 'reference', expectedVersion: 0 }, actor);
    const privatePolicy = { spaceId: 'S1', version: 1, rules: { view: privateAudience, edit: privateAudience, interact: privateAudience } };
    store.transaction(() => {
      for (let index = 0; index < POLICY_TRAVERSAL_MAX_WORK + 100; index++) {
        const id = `T${10_000 + index}`; const mode = index % 2 ? 'reference' : 'detach';
        store.database.prepare("INSERT INTO entities(id,kind,data) VALUES(?,'task',?)").run(id, JSON.stringify({ ...template, id }));
        store.database.prepare("INSERT INTO object_policies(object_id,space_id,data) VALUES(?,'S1',?)").run(id, JSON.stringify({ ...privatePolicy, objectId: id }));
        store.database.prepare('INSERT INTO file_attachments(file_id,object_id,mode,version,data) VALUES(?,?,?,1,?)').run(file.id, id, mode, JSON.stringify({ ...attachment, objectId: id, mode }));
      }
      const groundId = 'T900000';
      store.database.prepare("INSERT INTO entities(id,kind,data) VALUES(?,'task',?)").run(groundId, JSON.stringify({ ...template, id: groundId }));
      store.database.prepare("INSERT INTO object_policies(object_id,space_id,data) VALUES(?,'S1',?)").run(groundId, JSON.stringify({ ...privatePolicy, objectId: groundId, rules: { ...privatePolicy.rules, view: shared } }));
      attach(file.id, groundId);
    });
    const allowed = check(() => policies.access(file.id, 'bob'));
    assert.equal(allowed.result.view, true); assert.equal(allowed.checks, 2, 'only the active grant resolves a candidate');
    store.database.prepare("UPDATE file_attachments SET mode='attach',data=json_set(data,'$.mode','attach') WHERE file_id=? AND object_id<>?").run(file.id, template.id);
    const bounded = check(() => policies.access(file.id, 'bob'));
    assert.deepEqual(bounded.result, denied);
    assert.ok(bounded.checks > 400 && bounded.checks <= POLICY_TRAVERSAL_MAX_WORK, `${bounded.checks} bounded candidate node checks`);
  } finally { store.close(); }
});

test('long legacy and empty-asset revision histories remain visible without spending dependency work', () => {
  const { store, policies, check } = fixture();
  try {
    const detail = store.createRevision({ testPlan: 'Fixture verification plan.', kind: 'paper', title: 'Long text history', files: [{ path: 'main.tex', content: 'Text only' }] }, actor);
    const first = detail.versions[0]!;
    store.transaction(() => {
      for (let number = 2; number < POLICY_TRAVERSAL_MAX_WORK + 200; number++) {
        const version = { ...first, id: `legacy-history-${number}`, number, ...(number % 2 ? { assets: [] } : {}) };
        store.database.prepare('INSERT INTO versions(id,revision_id,number,data) VALUES(?,?,?,?)').run(version.id, version.revisionId, number, JSON.stringify(version));
      }
    });
    const allowed = check(() => policies.access(detail.revision.id, 'bob'));
    assert.equal(allowed.result.view, true); assert.equal(allowed.checks, 1);
    assert.equal(policies.describe(detail.revision.id, 'bob').capabilities.view, true);
  } finally { store.close(); }
});

test('1,222 binary versions repeating one File remain visible and revocation still applies to all history', () => {
  const { store, policies, upload } = fixture();
  try {
    const file = upload();
    const detail = store.createRevision({ testPlan: 'Fixture verification plan.', kind: 'paper', title: 'Bounded binary history', files: [{ path: 'main.tex', content: 'Figures' }], assets: [{ path: 'figure.pdf', fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: 'application/pdf' }], shareAssets: true }, actor);
    assert.equal(policies.access(detail.revision.id, 'bob').view, true);
    const first = detail.versions[0]!;
    store.transaction(() => {
      for (let number = 2; number <= 1_222; number++) {
        const version = { ...first, id: `binary-history-${number}`, number };
        store.database.prepare('INSERT INTO versions(id,revision_id,number,data) VALUES(?,?,?,?)').run(version.id, version.revisionId, number, JSON.stringify(version));
      }
    });
    assert.equal(policies.access(detail.revision.id, 'bob').view, true);
    assert.equal(policies.access(detail.revision.id, 'alice').view, true);
    store.files.setAttachment(file.id, { objectId: detail.revision.id, mode: 'detach', expectedVersion: 1 }, actor);
    assert.deepEqual(policies.access(detail.revision.id, 'bob'), denied);
    assert.equal(policies.access(detail.revision.id, 'alice').view, true, 'author permission remains current');
  } finally { store.close(); }
});

test('ordinary edits to a manuscript with 100 distinct figures do not multiply dependency work', () => {
  const { store, policies, upload } = fixture();
  try {
    const assets = Array.from({ length: 100 }, (_, index) => {
      const file = upload(); return { path: `figure-${index}.pdf`, fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: 'application/pdf' as const };
    });
    const detail = store.createRevision({ testPlan: 'Fixture verification plan.', kind: 'paper', title: 'Full figure allowance', files: [{ path: 'main.tex', content: 'Figures' }], assets, shareAssets: true }, actor);
    for (let version = 1; version < 20; version++) store.createVersion(detail.revision.id, { expectedVersion: version, message: 'Text edit', files: [{ path: 'main.tex', content: `Text edit ${version}` }] }, actor);
    assert.equal(policies.access(detail.revision.id, 'bob').view, true);
    assert.equal(policies.access(detail.revision.id, 'alice').view, true);
  } finally { store.close(); }
});

test('many distinct historical File dependencies still exhaust the shared graph budget', () => {
  const { store, policies, upload } = fixture();
  try {
    const detail = store.createRevision({ testPlan: 'Fixture verification plan.', kind: 'paper', title: 'Many distinct historical files', files: [{ path: 'main.tex', content: 'Figures' }] }, actor);
    let current = detail.versions[0]!;
    let firstFileId = '';
    for (let version = 1; version <= 11; version++) {
      const assets = Array.from({ length: 100 }, (_, index) => {
        const file = upload(); firstFileId ||= file.id; return { path: `figure-${index}.pdf`, fileId: file.id, sha256: file.sha256, bytes: file.bytes, mediaType: 'application/pdf' as const };
      });
      const updated = store.createVersion(detail.revision.id, { expectedVersion: version, expectedVersionId: current.id, expectedContentHash: current.contentHash, message: 'Replace figures', files: [{ path: 'main.tex', content: `Replacement figures ${version}` }], assets, shareAssets: true }, actor);
      current = updated.versions.find(item => item.number === version + 1)!;
    }
    assert.deepEqual(policies.access(detail.revision.id, 'bob'), denied);
    assert.deepEqual(policies.access(detail.revision.id, 'alice'), denied);
    assert.equal(policies.access(firstFileId, 'alice').view, true, 'unrelated direct access gets a fresh budget');
  } finally { store.close(); }
});
