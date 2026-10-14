import type { SuiteRecord } from './suite.ts';

export const ALMANAC_KINDS = ['device', 'network', 'interface', 'service', 'binding'] as const;
export type AlmanacKind = typeof ALMANAC_KINDS[number];
export type AlmanacProperties = Record<string, unknown>;
export interface AlmanacData extends Record<string, unknown> {
  description: string;
  status: 'active' | 'disabled';
  properties: AlmanacProperties;
  deviceId?: string;
  networkId?: string;
  serviceId?: string;
  interfaceId?: string;
  address?: string;
  port?: number;
  serviceType?: 'custom';
}
export type AlmanacRecord = SuiteRecord<AlmanacData>;
export const ALMANAC_KIND_LABELS: Record<AlmanacKind, string> = { device: 'Device', network: 'Network', interface: 'Interface', service: 'Service', binding: 'Binding' };
