import { canonicalizeSnapshot } from '../model/snapshot.js';
import type { GraphSnapshotV1 } from '../model/types.js';

export function toCanonicalJson(snapshot: GraphSnapshotV1): string {
  return `${JSON.stringify(canonicalizeSnapshot(snapshot))}\n`;
}
