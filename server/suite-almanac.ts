import { isIP } from 'node:net';
import { ALMANAC_KINDS, type AlmanacData, type AlmanacKind, type AlmanacProperties, type AlmanacRecord } from '../shared/almanac.ts';
import type { SuiteRecord } from '../shared/suite.ts';
import type { SuiteContext, SuiteModule } from './suite-contract.ts';
import { choice, HttpError, integer, object, optionalString, string } from './validation.ts';

function name(value: unknown): string {
  const result = string(value, 'Name', 200).trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(result) || result.includes('..')) throw new HttpError(400, 'Use a name containing letters, numbers, dots, or hyphens.');
  return result;
}
function address(value: unknown): string {
  const result = string(value, 'Address', 253).trim().toLowerCase();
  if (isIP(result) === 6) return new URL(`http://[${result}]/`).hostname.slice(1, -1);
  if (isIP(result) === 4) return result;
  if (!result.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new HttpError(400, 'Use an IPv4, IPv6, or DNS address without a protocol or path.');
  return result;
}
function port(value: unknown): number { const result = integer(value, 'Port'); if (result > 65535) throw new HttpError(400, 'Port must be at most 65535.'); return result; }
function properties(value: unknown): AlmanacProperties {
  if (value === undefined || value === '') return {};
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { throw new HttpError(400, 'Properties must be a JSON object.'); } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'Properties must be a JSON object.');
  const serialized = JSON.stringify(parsed);
  if (!serialized || serialized.length > 100_000) throw new HttpError(400, 'Properties exceed 100,000 characters.');
  const result = JSON.parse(serialized) as AlmanacProperties;
  for (const key of Object.keys(result)) if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new HttpError(400, 'Property names must use letters, numbers, dots, underscores, or hyphens.');
  return result;
}
function get(context: SuiteContext, id: unknown, kind: AlmanacKind, active = false): AlmanacRecord {
  const record = context.get(string(id, `${kind} ID`, 100));
  if (record.app !== 'almanac' || record.kind !== kind) throw new HttpError(400, `Choose an Almanac ${kind}.`);
  const result = record as AlmanacRecord;
  if (active && result.data.status !== 'active') throw new HttpError(409, `The selected ${kind} is disabled.`);
  return result;
}
function unique(context: SuiteContext, kind: AlmanacKind, title: string, data: AlmanacData, except = ''): void {
  if (context.exists('almanac', kind, record => {
    if (record.id === except) return false;
    if (kind === 'interface') return ['deviceId', 'networkId', 'address', 'port'].every(key => record.data[key] === data[key]);
    if (kind === 'binding') return record.data.serviceId === data.serviceId && record.data.interfaceId === data.interfaceId;
    return record.title.toLowerCase() === title.toLowerCase();
  })) throw new HttpError(409, 'This Almanac name or endpoint is already registered.');
}
function parents(record: SuiteRecord, context: SuiteContext, active = false): AlmanacRecord[] {
  const data = record.data as AlmanacData;
  if (record.kind === 'interface') return [get(context, data.deviceId, 'device', active), get(context, data.networkId, 'network', active)];
  if (record.kind === 'binding') {
    const service = get(context, data.serviceId, 'service', active), iface = get(context, data.interfaceId, 'interface', active);
    return [service, iface, ...parents(iface, context, active)];
  }
  return [];
}
function canView(record: SuiteRecord, context: SuiteContext): boolean {
  try { parents(record, context); return true; }
  catch (error) { if (error instanceof HttpError && [403, 404].includes(error.status)) return false; throw error; }
}
function canEdit(record: SuiteRecord, context: SuiteContext): boolean {
  if (!canView(record, context)) return false;
  if (record.kind === 'interface') return context.canEdit(get(context, record.data.deviceId, 'device'));
  if (record.kind === 'binding') return context.canEdit(get(context, record.data.serviceId, 'service'));
  return record.ownerId === context.actor.principalId || record.access.editorIds.includes(context.actor.principalId);
}
function disableAllowed(record: SuiteRecord, context: SuiteContext): void {
  const key = record.kind === 'device' ? 'deviceId' : record.kind === 'network' ? 'networkId' : record.kind === 'service' ? 'serviceId' : record.kind === 'interface' ? 'interfaceId' : null;
  if (!key) return;
  const kind = record.kind === 'device' || record.kind === 'network' ? 'interface' : 'binding';
  if (context.exists('almanac', kind, dependent => dependent.data[key] === record.id && dependent.data.status === 'active')) throw new HttpError(409, 'Disable dependent Almanac records before disabling this record.');
}

export const almanacModule: SuiteModule = {
  app: 'almanac', prefix: 'ALM', canView, canEdit,
  accessSource(record) { return record.kind === 'interface' ? String(record.data.deviceId) : record.kind === 'binding' ? String(record.data.serviceId) : null; },
  create(input, context) {
    const value = object(input, ['kind', 'title', 'description', 'properties', 'deviceId', 'networkId', 'serviceId', 'interfaceId', 'address', 'port', 'serviceType']);
    const kind = choice(value.kind, 'Almanac type', ALMANAC_KINDS), data: AlmanacData = { description: optionalString(value.description, 'Description', 50_000), status: 'active', properties: properties(value.properties) };
    let title: string;
    if (kind === 'interface') {
      const device = get(context, value.deviceId, 'device', true), network = get(context, value.networkId, 'network', true);
      context.requireEdit(device);
      data.deviceId = device.id; data.networkId = network.id; data.address = address(value.address); data.port = port(value.port);
      title = `${device.title} · ${data.address}:${data.port}`.slice(0, 255);
    } else if (kind === 'binding') {
      const service = get(context, value.serviceId, 'service', true), iface = get(context, value.interfaceId, 'interface', true);
      context.requireEdit(service); parents(iface, context, true);
      data.serviceId = service.id; data.interfaceId = iface.id; data.deviceId = (iface.data as AlmanacData).deviceId;
      title = `${service.title} → ${iface.title}`.slice(0, 255);
    } else {
      title = name(value.title);
      if (kind === 'service') data.serviceType = value.serviceType === undefined ? 'custom' : choice(value.serviceType, 'service type', ['custom'] as const);
    }
    unique(context, kind, title, data);
    return { kind, title, data, summary: `Registered ${kind}.` };
  },
  command(record, action, input, context) {
    context.requireEdit(record);
    const data = structuredClone(record.data) as AlmanacData;
    if (action === 'disable' || action === 'enable') {
      object(input, []);
      if (action === 'disable') disableAllowed(record, context); else parents(record, context, true);
      if (data.status === (action === 'disable' ? 'disabled' : 'active')) throw new HttpError(409, 'This Almanac record already has that status.');
      data.status = action === 'disable' ? 'disabled' : 'active';
      return { data, summary: `${action === 'disable' ? 'Disabled' : 'Enabled'} ${record.kind}.` };
    }
    if (action === 'properties') {
      const value = object(input, ['properties']); data.properties = properties(value.properties);
      return { data, summary: 'Updated custom properties.' };
    }
    if (action === 'edit') {
      const value = object(input, ['title', 'description', 'address', 'port']);
      data.description = optionalString(value.description, 'Description', 50_000, data.description);
      let title = record.title;
      if (record.kind === 'interface') {
        if (value.title !== undefined) throw new HttpError(400, 'Interface names are generated from their device and endpoint.');
        if (value.address !== undefined) data.address = address(value.address);
        if (value.port !== undefined) data.port = port(value.port);
        if (data.address !== record.data.address || data.port !== record.data.port) disableAllowed(record, context);
        title = `${get(context, data.deviceId, 'device').title} · ${data.address}:${data.port}`.slice(0, 255);
      } else if (record.kind === 'binding') {
        if (value.title !== undefined || value.address !== undefined || value.port !== undefined) throw new HttpError(400, 'Binding endpoints are immutable; register another binding instead.');
      } else {
        if (value.address !== undefined || value.port !== undefined) throw new HttpError(400, 'Only interfaces have addresses and ports.');
        if (value.title !== undefined) title = name(value.title);
      }
      unique(context, record.kind as AlmanacKind, title, data, record.id);
      return { title, data, summary: `Updated ${record.kind}.` };
    }
    throw new HttpError(400, 'Unknown Almanac action.');
  },
};
