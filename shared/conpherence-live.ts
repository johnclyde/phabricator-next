/** A content-free wake-up hint. Room contents still require a fresh authorized read. */
export interface ConpherenceUpdate { accessEpoch: number; changed: boolean }
