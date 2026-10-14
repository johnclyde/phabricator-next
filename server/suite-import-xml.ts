import { SaxesParser } from 'saxes';
import type { SuiteImportSourceRow } from '../shared/suite-import.ts';
import { HttpError } from './validation.ts';

const base = ['id', 'phid', 'dateCreated', 'dateModified'];
const policies = ['viewPolicy', 'editPolicy', 'spacePHID'];
const columns = (fields: string) => new Set([...base, ...policies, ...fields.split(' ')]);
/** Names are derived from pinned PhabricatorLiskDAO::getTableName and storage classes. */
export const SUITE_IMPORT_TABLES = Object.assign(Object.create(null) as Record<string, Set<string>>, {
  almanac_device: columns('name status isBoundToClusterService'),
  almanac_network: columns('name'),
  almanac_interface: columns('devicePHID networkPHID address port'),
  almanac_service: columns('name serviceType'),
  almanac_binding: columns('servicePHID devicePHID interfacePHID isDisabled'),
  almanac_property: columns('objectPHID fieldName fieldValue'),
  conpherence_thread: columns('title topic messageCount joinPolicy'),
  conpherence_participant: columns('participantPHID conpherencePHID seenMessageCount settings'),
  calendar_event: columns('name hostPHID description isCancelled isAllDay icon isStub isRecurring seriesParentPHID instanceOfEventPHID sequenceIndex utcInitialEpoch utcUntilEpoch utcInstanceEpoch parameters importAuthorPHID importSourcePHID importUIDIndex importUID'),
  calendar_eventinvitee: columns('eventPHID inviteePHID inviterPHID status availability'),
  slowvote_poll: columns('question description authorPHID responseVisibility shuffle method isClosed'),
  slowvote_option: columns('pollID name'),
  slowvote_choice: columns('pollID optionID authorPHID'),
  phame_blog: columns('name subtitle description domain domainFullURI parentSite parentDomain configData creatorPHID status profileImagePHID headerImagePHID'),
  phame_post: columns('bloggerPHID title subtitle phameTitle body visibility configData datePublished blogPHID headerImagePHID'),
  legalpad_document: columns('title contributorCount recentContributorPHIDs creatorPHID versions documentBodyPHID signatureType preamble requireSignature'),
  legalpad_documentbody: columns('creatorPHID documentPHID version title text'),
  legalpad_documentsignature: columns('documentPHID documentVersion signatureType signerPHID signerName signerEmail signatureData verified isExemption exemptionPHID'),
});
for (const table of ['almanac_devicetransaction','almanac_networktransaction','almanac_interfacetransaction','almanac_servicetransaction','almanac_bindingtransaction','conpherence_transaction','calendar_eventtransaction','slowvote_transaction','phame_blogtransaction','phame_posttransaction','legalpad_transaction']) {
  SUITE_IMPORT_TABLES[table] = columns('objectPHID authorPHID commentPHID commentVersion transactionType oldValue newValue metadata contentSource');
}
for (const table of ['conpherence_transactioncomment','calendar_eventtransactioncomment','slowvote_transactioncomment','phame_posttransactioncomment','legalpad_transactioncomment']) {
  SUITE_IMPORT_TABLES[table] = columns('transactionPHID commentVersion authorPHID content isDeleted conpherencePHID documentID lineNumber lineLength fixedState hasReplies replyToCommentPHID');
}
const secrets = new Set(['mailKey','secretKey','contentSource']);
const derived = new Set(['nameIndex','fieldIndex']);
export const SUITE_IMPORT_LIMITS = { bytes: 12_000_000, files: 32, rows: 20_000, objects: 500, fieldBytes: 1_000_000 } as const;
export interface ParsedSuiteDump { rows: SuiteImportSourceRow[]; tables: string[]; warnings: string[] }

/** This is a data parser only. DTDs/entities, SQL, unknown XML structures, and binary fields are never executed. */
export function parseSuiteMysqlXml(files: { name: string; xml: string }[]): ParsedSuiteDump {
  if (!files.length || files.length > SUITE_IMPORT_LIMITS.files) throw new HttpError(400, 'Provide 1–32 MySQL XML export files.');
  if (files.reduce((size, file) => size + Buffer.byteLength(file.xml), 0) > SUITE_IMPORT_LIMITS.bytes) throw new HttpError(413, 'XML exports exceed the 12 MB import limit; split the source objects into batches.');
  const rows: SuiteImportSourceRow[] = [], tables = new Set<string>(), warnings = new Set<string>(), identities = new Set<string>();
  let totalRows = 0;
  for (const file of files) {
    const stack: string[] = []; let table = '', row: Record<string, string | null> | null = null, field = '', value = '', nil = false, discarded = false;
    const fail = (message: string): never => { throw new HttpError(400, `${file.name}: ${message}`); };
    const parser = new SaxesParser({ xmlns: false }); let ended = false;
    parser.on('end', () => { ended = true; });
    parser.on('doctype', () => fail('Document type declarations are not accepted.'));
    parser.on('error', () => fail('Invalid MySQL XML export.'));
    parser.on('processinginstruction', () => fail('Processing instructions are not accepted.'));
    parser.on('opentag', tag => {
      const parent = stack.at(-1), name = tag.name;
      if (!((name === 'mysqldump' && !parent) || (name === 'database' && parent === 'mysqldump') || (name === 'table_data' && parent === 'database') || (name === 'row' && parent === 'table_data') || (name === 'field' && parent === 'row'))) fail('Expected mysqldump/database/table_data/row/field data; export with --no-create-info.');
      stack.push(name);
      if (name === 'table_data') {
        table = String(tag.attributes.name ?? ''); if (!/^[a-z][a-z0-9_]{0,100}$/.test(table)) fail('Invalid table name.');
        tables.add(table);
        if (!SUITE_IMPORT_TABLES[table]) warnings.add(`Unsupported table ${table} is omitted. Export only documented tables for a complete supported import.`);
      }
      if (name === 'row') { if (++totalRows > SUITE_IMPORT_LIMITS.rows) fail('Export exceeds 20,000 rows; split the source objects into batches.'); row = Object.create(null) as Record<string, string | null>; }
      if (name === 'field') {
        field = String(tag.attributes.name ?? ''); value = ''; nil = tag.attributes['xsi:nil'] === 'true';
        if (!/^[A-Za-z][A-Za-z0-9_]{0,100}$/.test(field)) fail('Invalid column name.');
        if (row && Object.hasOwn(row, field)) fail(`Duplicate ${table}.${field} column.`);
        discarded = secrets.has(field) || derived.has(field) || !SUITE_IMPORT_TABLES[table]?.has(field);
        if (!discarded && (tag.attributes['xsi:type'] !== undefined || tag.attributes.encoding !== undefined)) fail('Encoded/binary content fields are unsupported; export the documented text tables.');
        if (secrets.has(field)) warnings.add(`Sensitive ${table}.${field} is discarded.`);
        else if (SUITE_IMPORT_TABLES[table] && !derived.has(field) && !SUITE_IMPORT_TABLES[table]!.has(field)) warnings.add(`Unsupported column ${table}.${field} is omitted.`);
      }
    });
    const append = (text: string) => {
      if (stack.at(-1) !== 'field') { if (text.trim()) fail('Text outside a field is unsupported.'); return; }
      value += text;
      if (Buffer.byteLength(value) > SUITE_IMPORT_LIMITS.fieldBytes) fail(`Field ${table}.${field} exceeds 1 MB.`);
    };
    parser.on('text', append); parser.on('cdata', append);
    parser.on('closetag', tag => {
      if (tag.name === 'field' && row) { if (nil && value.trim()) fail('A null field cannot also contain text.'); row[field] = discarded ? null : nil ? null : value; }
      if (tag.name === 'row' && row && SUITE_IMPORT_TABLES[table]) {
        const fields = Object.fromEntries(Object.entries(row).filter(([key]) => SUITE_IMPORT_TABLES[table]!.has(key) && !secrets.has(key)));
        const id = fields.phid || fields.id;
        if (!id) fail(`Every ${table} row requires an id or phid.`);
        const keys = [fields.id ? `${table}:id:${fields.id}` : null, fields.phid ? `${table}:phid:${fields.phid}` : null].filter((key): key is string => key !== null);
        for (const identity of keys) { if (identities.has(identity)) fail(`Duplicate source row ${identity}.`); identities.add(identity); }
        rows.push({ table, fields }); row = null;
      }
      stack.pop();
    });
    try { parser.write(file.xml).close(); }
    catch (error) { if (error instanceof HttpError) throw error; fail('Invalid MySQL XML export.'); }
    if (!ended) fail('Incomplete MySQL XML export.');
  }
  return { rows, tables: [...tables].sort(), warnings: [...warnings].sort() };
}
