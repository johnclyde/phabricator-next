import type { AppState } from '../shared/types';
import type { SuiteDetail, SuiteRecord } from '../shared/suite';
import { ALMANAC_KIND_LABELS, type AlmanacData, type AlmanacKind } from '../shared/almanac';
import { SuiteScreen, type SuiteField, type SuiteForm } from './SuiteScreen';

const description: SuiteField = { name: 'description', label: 'Description', type: 'textarea' };
const name: SuiteField = { name: 'title', label: 'Name', type: 'text', required: true };
const properties: SuiteField = { name: 'properties', label: 'Custom properties (JSON object)', type: 'textarea' };
function link(id: string | undefined) { return id ? <a href={`#almanac/${id}`}>{id}</a> : '—'; }
function AlmanacDetails({ record }: { record: SuiteRecord }) {
  const data = record.data as AlmanacData;
  return <div><p><span className="badge">{ALMANAC_KIND_LABELS[record.kind as AlmanacKind]}</span> <span className="badge">{data.status === 'active' ? 'Active' : 'Disabled'}</span></p>
    {data.description && <p className="audit-comment">{data.description}</p>}
    <dl>{data.deviceId && <><dt>Device</dt><dd>{link(data.deviceId)}</dd></>}{data.networkId && <><dt>Network</dt><dd>{link(data.networkId)}</dd></>}{data.serviceId && <><dt>Service</dt><dd>{link(data.serviceId)}</dd></>}{data.interfaceId && <><dt>Interface</dt><dd>{link(data.interfaceId)}</dd></>}{data.address && <><dt>Address</dt><dd><code>{data.address}</code></dd><dt>Port</dt><dd>{data.port}</dd></>}{data.serviceType && <><dt>Service type</dt><dd>Custom service directory</dd></>}</dl>
    {Object.keys(data.properties).length > 0 && <><h3>Properties</h3><pre className="automation-json">{JSON.stringify(data.properties, null, 2)}</pre></>}
  </div>;
}
export function Almanac({ state, online }: { state: AppState; online: boolean }) {
  function forms(record: SuiteRecord | null, detail?: SuiteDetail, records: SuiteRecord[] = []): SuiteForm[] {
    const reference = (kind: AlmanacKind): SuiteField => ({ name: `${kind}Id`, label: ALMANAC_KIND_LABELS[kind], type: 'text', required: true, options: records.filter(item => item.kind === kind && item.data.status === 'active').map(item => ({ value: item.id, label: `${item.id} — ${item.title}` })) });
    const endpoint: SuiteField[] = [{ name: 'address', label: 'IP address or hostname', type: 'text', required: true }, { name: 'port', label: 'Port', type: 'number', required: true }];
    if (!record) return [
      { key: 'device', label: 'Register Device', fields: [name, description, properties], values: { properties: '{}' } },
      { key: 'network', label: 'Register Network', fields: [name, description] },
      { key: 'service', label: 'Register Service', fields: [name, description, properties], values: { properties: '{}', serviceType: 'custom' } },
      { key: 'interface', label: 'Add Interface', fields: [reference('device'), reference('network'), ...endpoint, description], values: { port: 443 } },
      { key: 'binding', label: 'Bind Service', fields: [reference('service'), reference('interface'), description, properties], values: { properties: '{}' } },
    ];
    if (!detail?.canEdit) return [];
    const data = record.data as AlmanacData;
    return [
      { key: 'edit', label: 'Edit Record', fields: [...(record.kind === 'interface' ? endpoint : record.kind === 'binding' ? [] : [name]), description], values: { ...(record.kind === 'interface' ? { address: data.address, port: data.port } : record.kind === 'binding' ? {} : { title: record.title }), description: data.description } },
      { key: 'properties', label: 'Edit Properties', fields: [properties], values: { properties: JSON.stringify(data.properties, null, 2) } },
      { key: data.status === 'active' ? 'disable' : 'enable', label: data.status === 'active' ? 'Disable Record' : 'Enable Record', fields: [], confirm: data.status === 'active' ? 'Disable this directory record? Active dependent records must be disabled first.' : undefined },
    ];
  }
  return <SuiteScreen app="almanac" title="Almanac" online={online} state={state} forms={forms} render={record => <AlmanacDetails record={record}/>}/>;
}
export default Almanac;
