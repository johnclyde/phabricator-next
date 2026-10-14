import { createHash } from 'node:crypto';
import { calendarAddDays, calendarInstant, validCalendarDate, validCalendarTimezone } from '../shared/calendar.ts';
import type { SuiteApp } from '../shared/suite.ts';
import type { SuiteImportRequest, SuiteImportSourceHistory, SuiteImportSourceRow } from '../shared/suite-import.ts';
import { parseSuiteMysqlXml, SUITE_IMPORT_LIMITS } from './suite-import-xml.ts';
import { HttpError } from './validation.ts';

export interface SuiteImportPlanItem {
  sourcePHID: string; sourceDigest: string; app: SuiteApp; kind: string; title: string;
  input: Record<string, unknown>; references: Record<string, string>;
  after: { action: string; input: Record<string, unknown> }[];
  history: SuiteImportSourceHistory; warnings: string[];
}
export interface SuiteImportPlan { items: SuiteImportPlanItem[]; warnings: string[]; errors: string[] }
export function importCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(importCanonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${importCanonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function importDigest(value: unknown): string { return createHash('sha256').update(importCanonical(value)).digest('hex'); }
const tables: [string, SuiteApp, string][] = [
  ['almanac_device','almanac','device'], ['almanac_network','almanac','network'], ['almanac_service','almanac','service'], ['almanac_interface','almanac','interface'], ['almanac_binding','almanac','binding'],
  ['conpherence_thread','conpherence','room'], ['calendar_event','calendar','event'], ['slowvote_poll','slowvote','poll'],
  ['phame_blog','phame','blog'], ['phame_post','phame','post'], ['legalpad_document','legalpad','document'],
];
const fail = (message: string): never => { throw new HttpError(400, message); };
function text(row: SuiteImportSourceRow, key: string, fallback?: string): string {
  const value = row.fields[key];
  if (value === undefined || value === null) { if (fallback !== undefined) return fallback; return fail(`Missing ${row.table}.${key}.`); }
  if (value.includes('\0')) return fail(`NUL bytes are unsupported in ${row.table}.${key}.`);
  return value;
}
function integer(row: SuiteImportSourceRow, key: string, fallback?: number): number {
  const value = text(row, key, fallback === undefined ? undefined : String(fallback));
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return fail(`Invalid ${row.table}.${key}.`);
  return Number(value);
}
function flag(row: SuiteImportSourceRow, key: string, fallback = 0): boolean { const value = integer(row,key,fallback); if (value > 1) return fail(`Invalid boolean ${row.table}.${key}.`); return value === 1; }
function json(row: SuiteImportSourceRow, key: string, fallback = '{}'): Record<string, unknown> {
  let result: unknown; try { result = JSON.parse(text(row,key,fallback)); } catch { return fail(`Invalid JSON ${row.table}.${key}.`); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return fail(`Expected an object in ${row.table}.${key}.`);
  return result as Record<string, unknown>;
}
function epoch(row: SuiteImportSourceRow, key: string): string | null {
  if (!row.fields[key]) return null;
  const value = integer(row,key), result = new Date(value * 1000);
  if (!Number.isFinite(result.getTime()) || result.getUTCFullYear() > 9999) return fail(`Invalid timestamp ${row.table}.${key}.`);
  return result.toISOString();
}
function phid(value: string): string { if (!/^PHID-[A-Z0-9]{4}-[A-Za-z0-9]{1,80}$/.test(value)) return fail('Expected an upstream PHID.'); return value; }
function date(dictionary: unknown, allDay: boolean): { value: string; timezone: string } {
  if (!dictionary || typeof dictionary !== 'object' || Array.isArray(dictionary)) return fail('Calendar datetime dictionary is missing.');
  const d = dictionary as Record<string, unknown>;
  if (d.kind !== 'absolute' || !['year','month','day','hour','minute','second'].every(key => typeof d[key] === 'number' && Number.isInteger(d[key])) || typeof d.timezone !== 'string' || !validCalendarTimezone(d.timezone)) return fail('Invalid upstream Calendar absolute datetime dictionary.');
  const two = (value: unknown) => String(value).padStart(2, '0'), day = `${String(d.year).padStart(4,'0')}-${two(d.month)}-${two(d.day)}`;
  if (!validCalendarDate(day) || Number(d.hour) < 0 || Number(d.hour) > 23 || Number(d.minute) < 0 || Number(d.minute) > 59 || Number(d.second) < 0 || Number(d.second) > 59) return fail('Invalid upstream Calendar date.');
  if (allDay) return { value: day, timezone: d.timezone };
  const nominal = `${day}T${two(d.hour)}:${two(d.minute)}`;
  // A repeated or nonexistent wall clock is not silently assigned an offset.
  const instant = calendarInstant(nominal,d.timezone);
  return { value: new Date(Date.parse(instant) + Number(d.second) * 1000).toISOString(), timezone: d.timezone };
}

export function buildSuiteImportPlan(request: SuiteImportRequest): SuiteImportPlan {
  const parsed = parseSuiteMysqlXml(request.files), warnings = [...parsed.warnings], errors: string[] = [], items: SuiteImportPlanItem[] = [], attached = new Set<SuiteImportSourceRow>();
  const rows = (table: string) => parsed.rows.filter(row => row.table === table);
  const sourceIds = new Set<string>();
  const transactions = new Map(parsed.rows.filter(row => row.table.endsWith('transaction')).map(row => [row.fields.phid, row]));
  const primary = tables.flatMap(([table,app,kind]) => rows(table).map(row => ({row,app,kind})));
  if (!primary.length) errors.push('No supported application objects were found.');
  if (primary.length > SUITE_IMPORT_LIMITS.objects) fail('Import at most 500 application objects per batch.');
  for (const {row,app,kind} of primary) {
    try {
      const sourcePHID = phid(text(row,'phid'));
      if (sourceIds.has(sourcePHID)) fail(`Duplicate object PHID ${sourcePHID}.`); sourceIds.add(sourcePHID);
      const related = parsed.rows.filter(child => {
        if (child === row) return true;
        if (child.table.split('_')[0] !== app) return false;
        const f = child.fields;
        if (f.objectPHID === sourcePHID || f.documentPHID === sourcePHID || f.conpherencePHID === sourcePHID || f.eventPHID === sourcePHID) return true;
        if (app === 'slowvote' && f.pollID === row.fields.id) return true;
        if (app === 'legalpad' && f.documentID === row.fields.id) return true;
        return Boolean(f.transactionPHID && transactions.get(f.transactionPHID)?.fields.objectPHID === sourcePHID);
      }).sort((a,b) => `${a.table}:${a.fields.id || a.fields.phid}`.localeCompare(`${b.table}:${b.fields.id || b.fields.phid}`));
      related.forEach(child => attached.add(child));
      const history: SuiteImportSourceHistory = { sourceCreatedAt:epoch(row,'dateCreated'),sourceModifiedAt:epoch(row,'dateModified'),sourceAuthorPHID: row.fields.authorPHID || row.fields.creatorPHID || row.fields.bloggerPHID || row.fields.hostPHID || null,rows:related };
      const item: SuiteImportPlanItem = {sourcePHID,sourceDigest:importDigest(history),app,kind,title:'',input:{kind},references:{},after:[],history,warnings:[]};
      const role = request.roles?.[sourcePHID] ?? {};
      const expected = app === 'conpherence' ? ['participantIds'] : app === 'calendar' ? ['inviteeIds'] : app === 'phame' && kind === 'blog' ? ['authorIds','editorIds'] : [];
      if (Object.keys(role).some(key => !expected.includes(key))) fail(`Destination roles do not apply to ${app} ${kind}.`);
      const command = (action: string) => item.after.push({action,input:{}});
      if (app === 'almanac') {
        const properties: Record<string,unknown> = Object.create(null) as Record<string,unknown>;
        for (const prop of related.filter(child => child.table === 'almanac_property')) {
          const key = text(prop,'fieldName'); if (Object.hasOwn(properties,key)) fail(`Duplicate Almanac property ${key}.`);
          try { properties[key] = JSON.parse(text(prop,'fieldValue')); } catch { fail(`Invalid Almanac property JSON ${key}.`); }
        }
        item.input.properties = properties;
        if (kind === 'interface') {
          item.references = {deviceId:phid(text(row,'devicePHID')),networkId:phid(text(row,'networkPHID'))};
          item.input.address = text(row,'address'); item.input.port = integer(row,'port');
          item.title = `${item.input.address}:${item.input.port}`;
        } else if (kind === 'binding') {
          item.references = {serviceId:phid(text(row,'servicePHID')),interfaceId:phid(text(row,'interfacePHID'))}; item.title = `Binding ${sourcePHID}`;
          if (flag(row,'isDisabled')) command('disable');
        } else {
          item.title = text(row,'name'); item.input.title = item.title;
          if (kind === 'service') { if (text(row,'serviceType') !== 'almanac.custom') fail('Only upstream almanac.custom services are supported; cluster service types require an explicit migration.'); item.input.serviceType = 'custom'; }
          if (kind === 'device') { const status = text(row,'status'); if (!['active','disabled'].includes(status)) fail('Unsupported Almanac device status.'); if (status === 'disabled') command('disable'); }
        }
      } else if (app === 'conpherence') {
        item.title = text(row,'title','').trim() || `Imported conversation ${row.fields.id}`;
        Object.assign(item.input,{title:item.title,topic:text(row,'topic',''),participantIds:role.participantIds ?? []});
        item.warnings.push('Historical messages and participants are preserved as source evidence. Only explicitly chosen current participants join the new conversation.');
      } else if (app === 'calendar') {
        if (flag(row,'isStub') || row.fields.instanceOfEventPHID) fail('Materialized Calendar child/stub rows require recurrence-aware migration; import a supported complete parent series without child overrides.');
        const parameters = json(row,'parameters'), allDay = flag(row,'isAllDay'), start = date(parameters.startDateTime,allDay), end = date(parameters.endDateTime,allDay);
        if (start.timezone !== end.timezone) fail('Calendar start and end timezones differ.');
        // Upstream newEndDateTime() adds a day for native all-day events;
        // imported ICS events (importSourcePHID set) already store an exclusive end.
        if (allDay && !row.fields.importSourcePHID) end.value = calendarAddDays(end.value, 1);
        item.title=text(row,'name'); Object.assign(item.input,{title:item.title,description:text(row,'description',''),location:'',timezone:start.timezone,allDay,start:start.value,end:end.value,inviteeIds:role.inviteeIds ?? []});
        if (flag(row,'isRecurring')) {
          const rule = parameters.recurrenceRule as Record<string,unknown> | undefined, count = parameters.recurrenceCount;
          if (!rule || !['DAILY','WEEKLY'].includes(String(rule.FREQ)) || Object.keys(rule).some(key => !['FREQ','INTERVAL'].includes(key)) || (rule.INTERVAL !== undefined && rule.INTERVAL !== 1) || typeof count !== 'number' || !Number.isInteger(count) || count < 2 || count > 366 || parameters.untilDateTime) fail('Only bounded daily/weekly Calendar series with interval 1, count 2–366, and no UNTIL or BY rules are supported.');
          item.input.recurrenceFrequency=String(rule!.FREQ).toLowerCase(); item.input.recurrenceCount=count;
        }
        if (flag(row,'isCancelled')) command('cancel');
        item.warnings.push('Historical RSVP decisions remain source evidence. Current invitations are selected explicitly.');
      } else if (app === 'slowvote') {
        const options = related.filter(child => child.table === 'slowvote_option').sort((a,b) => integer(a,'id') - integer(b,'id'));
        const method = integer(row,'method'), visibility = integer(row,'responseVisibility');
        if (![0,1].includes(method) || ![0,1,2].includes(visibility)) fail('Unsupported Slowvote method or response visibility.');
        item.title=text(row,'question'); Object.assign(item.input,{title:item.title,description:text(row,'description',''),method:method === 0 ? 'single' : 'multiple',responseVisibility:['always','aftervote','owner'][visibility],choices:options.map(option => text(option,'name'))});
        if (options.length < 2) fail('A poll requires its slowvote_option rows.');
        if (flag(row,'isClosed') || related.some(child => child.table === 'slowvote_choice')) command('close');
        item.warnings.push('Historical ballots are editor-only source evidence, not current votes. Polls with old ballots import closed; reopen to collect new responses.');
        if (flag(row,'shuffle')) item.warnings.push('Upstream shuffled option order is preserved only in source evidence.');
      } else if (app === 'phame' && kind === 'blog') {
        item.title=text(row,'name'); Object.assign(item.input,{title:item.title,subtitle:text(row,'subtitle',''),description:text(row,'description',''),...(role.authorIds ? {authorIds:role.authorIds} : {}),editorIds:role.editorIds ?? request.destination.editorIds});
        const status=text(row,'status'); if (!['active','archived'].includes(status)) fail('Unsupported Phame blog status.'); if (status==='archived') command('archive');
        item.warnings.push('Upstream public/custom-domain publishing and policies do not grant access. This blog uses the selected destination audience.');
      } else if (app === 'phame') {
        item.title=text(row,'title'); item.references={blogId:phid(text(row,'blogPHID'))}; Object.assign(item.input,{title:item.title,subtitle:text(row,'subtitle',''),body:text(row,'body','')});
        const visibility=integer(row,'visibility'); if (![0,1,2].includes(visibility)) fail('Unsupported Phame post visibility.');
        if (visibility===1) command('publish'); if (visibility===2) command('archive');
        if (visibility===1) item.warnings.push('Publication becomes visible only to the destination blog audience. Original publication date remains in source evidence.');
      } else if (app === 'legalpad') {
        const body = related.find(child => child.table === 'legalpad_documentbody' && child.fields.phid === row.fields.documentBodyPHID);
        if (!body) fail('Legalpad current document body is missing; include legalpad_documentbody.');
        const types=new Map([['none','none'],['user','individual'],['corp','corporation']]), type=types.get(text(row,'signatureType')); if (!type) fail('Unsupported Legalpad signature type.');
        item.title=text(row,'title'); Object.assign(item.input,{title:item.title,text:text(body!,'text'),preamble:text(row,'preamble',''),signatureType:type,requiredSignerIds:[]});
        item.warnings.push('This creates a fresh unsigned agreement version 1. Old bodies, signatures, exemptions, and verification flags remain historical unverified evidence and satisfy no current requirement.');
      }
      if (related.some(child => child.table.endsWith('transaction') || child.table.endsWith('comment'))) item.warnings.push('Source comments and transaction history remain editor-only provenance; they are not replayed as current account actions.');
      items.push(item);
    } catch (error) { errors.push(`${row.table} ${row.fields.phid || row.fields.id}: ${error instanceof Error ? error.message : 'Invalid source object.'}`); }
  }
  for (const key of Object.keys(request.roles ?? {})) if (!sourceIds.has(key)) errors.push(`Role configuration references absent source object ${key}.`);
  const unused = parsed.rows.filter(row => !attached.has(row));
  for (const table of [...new Set(unused.map(row => row.table))]) warnings.push(`${unused.filter(row => row.table === table).length} ${table} rows have no imported parent and are omitted.`);
  for (const app of [...new Set(items.map(item => item.app))]) if (!parsed.tables.some(table => table.startsWith(`${app}_`) && table.endsWith('transaction'))) warnings.push(`No ${app} transaction table supplied; historical transaction coverage is incomplete.`);
  // Native Almanac cannot leave active endpoints beneath disabled parents.
  for (const item of items.filter(item => item.app==='almanac' && ['interface','binding'].includes(item.kind))) {
    if (Object.values(item.references).some(id => items.find(parent => parent.sourcePHID===id)?.after.some(command => command.action==='disable')) && !item.after.some(command => command.action==='disable')) {
      item.after.push({action:'disable',input:{}}); item.warnings.push('This endpoint is disabled in the destination because its parent is disabled.');
    }
  }
  return {items,warnings:[...new Set(warnings)].sort(),errors};
}
