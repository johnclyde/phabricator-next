import test from 'node:test';
import assert from 'node:assert/strict';
import type { SuiteRecord } from '../shared/suite.ts';
import type { SuiteContext } from './suite-contract.ts';
import { almanacModule as module } from './suite-almanac.ts';
import { HttpError } from './validation.ts';

function setup() {
  const records: SuiteRecord[] = [], hidden = new Set<string>();
  const context: SuiteContext = {
    actor: { principalId: 'alice', displayName: 'Alice', workspaceId: 'test', kind: 'session', credentialId: null, sessionContext: 'session', scopes: ['read', 'write'] }, now: '2026-10-14T00:00:00.000Z',
    get(id) { const record = records.find(item => item.id === id); if (!record || hidden.has(id)) throw new HttpError(404, 'Not found.'); return record; },
    list(app, kind) { return records.filter(item => item.app === app && (!kind || item.kind === kind) && !hidden.has(item.id)); },
    exists(app, kind, predicate) { return records.some(item => item.app === app && item.kind === kind && predicate(item)); },
    canEdit(record) { return module.canEdit?.(record, context) ?? record.ownerId === context.actor.principalId; },
    requireEdit(record) { if (!context.canEdit(record)) throw new HttpError(403, 'Forbidden.'); },
    requirePerson(id) { return { id, displayName: id }; },
  };
  const create = (input: unknown) => { const value = module.create(input, context), record: SuiteRecord = { ...value, app: 'almanac', id: `ALM${records.length + 1}`, ownerId: context.actor.principalId, version: 1, createdAt: context.now, updatedAt: context.now, access: { spaceId: 'S1', visibility: 'workspace', memberIds: [], editorIds: [] } }; records.push(record); return record; };
  const command = (record: SuiteRecord, action: string, input: unknown = {}) => { const result = module.command(record, action, input, context); record.data = result.data; if (result.title) record.title = result.title; record.version++; return record; };
  const topology = () => { const device = create({ kind: 'device', title: 'worker.test' }), network = create({ kind: 'network', title: 'internal' }), service = create({ kind: 'service', title: 'review-builds' }), iface = create({ kind: 'interface', deviceId: device.id, networkId: network.id, address: '10.1.2.3', port: 443 }), binding = create({ kind: 'binding', serviceId: service.id, interfaceId: iface.id }); return { device, network, service, iface, binding }; };
  return { records, hidden, context, create, command, topology };
}

test('Almanac registers a complete service directory without provisioning infrastructure', () => {
  const s = setup(), t = s.topology();
  assert.equal(t.binding.data.serviceId, t.service.id); assert.equal(t.binding.data.deviceId, t.device.id); assert.equal(t.binding.data.interfaceId, t.iface.id);
  assert.equal(t.service.data.serviceType, 'custom');
  s.command(t.binding, 'properties', { properties: '{"weight":2,"tags":["linux"]}' });
  assert.deepEqual(t.binding.data.properties, { weight: 2, tags: ['linux'] });
  assert.throws(() => s.create({ kind: 'service', title: 'automatic', serviceType: 'cloud' }), /Invalid service type/);
});
test('Almanac unique names and endpoints include invisible records without revealing identities', () => {
  const s = setup(), t = s.topology(); s.hidden.add(t.device.id);
  assert.throws(() => s.create({ kind: 'device', title: 'WORKER.TEST' }), /already registered/);
  s.hidden.delete(t.device.id); s.hidden.add(t.iface.id);
  assert.throws(() => s.create({ kind: 'interface', deviceId: t.device.id, networkId: t.network.id, address: '10.1.2.3', port: 443 }), /already registered/);
  s.hidden.delete(t.iface.id); s.hidden.add(t.binding.id);
  assert.throws(() => s.create({ kind: 'binding', serviceId: t.service.id, interfaceId: t.iface.id }), /already registered/);
});
test('Almanac refuses disabling parents and changing endpoints while active bindings depend on them', () => {
  const s = setup(), t = s.topology(); s.hidden.add(t.binding.id);
  assert.throws(() => s.command(t.service, 'disable'), /Disable dependent/);
  assert.throws(() => s.command(t.iface, 'edit', { address: '10.1.2.4' }), /Disable dependent/);
  assert.throws(() => s.command(t.device, 'disable'), /Disable dependent/);
  s.hidden.delete(t.binding.id); s.command(t.binding, 'disable'); s.command(t.iface, 'disable'); s.command(t.network, 'disable');
  assert.throws(() => s.command(t.iface, 'enable'), /network is disabled/);
  assert.throws(() => s.command(t.binding, 'enable'), /interface is disabled/);
  s.command(t.network, 'enable'); s.command(t.iface, 'enable'); s.command(t.binding, 'enable');
  assert.equal(t.binding.data.status, 'active');
});
test('Almanac interface and binding policies follow their current parents', () => {
  const s = setup(), t = s.topology();
  assert.equal(module.accessSource?.(t.iface), t.device.id); assert.equal(module.accessSource?.(t.binding), t.service.id);
  s.hidden.add(t.network.id); assert.equal(module.canView?.(t.iface, s.context), false); assert.equal(module.canView?.(t.binding, s.context), false);
  s.hidden.clear(); t.device.ownerId = 'bob'; assert.equal(module.canEdit?.(t.iface, s.context), false);
  assert.throws(() => s.command(t.iface, 'properties', { properties: {} }), /Forbidden/);
  assert.throws(() => s.create({ kind: 'interface', deviceId: t.device.id, networkId: t.network.id, address: 'new.test', port: 80 }), /Forbidden/);
  t.service.ownerId = 'bob'; assert.throws(() => s.command(t.binding, 'disable'), /Forbidden/);
});
test('Almanac validates address, port, object kinds, properties and normalizes IPv6 identity', () => {
  const s = setup(), device = s.create({ kind: 'device', title: 'host' }), network = s.create({ kind: 'network', title: 'net' });
  const base = { kind: 'interface', deviceId: device.id, networkId: network.id };
  for (const address of ['https://host/path', 'bad host', '-invalid.test', '']) assert.throws(() => s.create({ ...base, address, port: 80 }), HttpError);
  for (const port of [0, 65536, 3.14, '80']) assert.throws(() => s.create({ ...base, address: 'host.test', port }), HttpError);
  s.create({ ...base, address: '2001:db8:0:0:0:0:0:1', port: 80 });
  assert.throws(() => s.create({ ...base, address: '2001:db8::1', port: 80 }), /already registered/);
  assert.throws(() => s.create({ ...base, deviceId: network.id, address: 'host', port: 80 }), /Choose an Almanac device/);
  assert.throws(() => s.command(device, 'properties', { properties: '{"__proto__":{"x":1}}' }), /Property names/);
  assert.throws(() => s.command(device, 'properties', { properties: '[1,2]' }), /JSON object/);
});
test('Almanac failed commands leave the original data untouched', () => {
  const s = setup(), t = s.topology(), original = structuredClone(t.iface);
  assert.throws(() => s.command(t.iface, 'edit', { description: 'would change', address: '10.4.4.4' }), /Disable dependent/);
  assert.deepEqual(t.iface, original);
  assert.throws(() => s.command(t.binding, 'edit', { title: 'repointed' }), /immutable/);
  assert.throws(() => s.command(t.service, 'edit', { port: 123 }), /Only interfaces/);
});

test('Almanac unprivileged viewers cannot edit device, network or service records', () => { const s = setup(), t = s.topology(); s.context.actor.principalId = 'bob'; for (const record of [t.device, t.network, t.service]) { assert.equal(module.canEdit?.(record, s.context), false); assert.throws(() => s.command(record, 'properties', { properties: {} }), /Forbidden/); } });
