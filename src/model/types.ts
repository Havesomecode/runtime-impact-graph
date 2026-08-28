export type NodeKind =
  'route' | 'capability' | 'loader' | 'resource' | 'derived' | 'custom';

export type EdgeKind = 'contains' | 'dependsOn';
export type MetadataValue = string | number | boolean;

export interface NodeV1 {
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  readonly metadata: Readonly<
    Record<string, MetadataValue | readonly MetadataValue[]>
  >;
  readonly observations: number;
}

export interface EdgeV1 {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeKind;
  readonly observations: number;
}

export interface SnapshotWarningV1 {
  readonly code: 'node-limit' | 'edge-limit';
  readonly count: number;
}

export interface GraphSnapshotV1 {
  readonly format: 'runtime-impact-graph/v0.1';
  readonly schemaFingerprint: string;
  readonly nodes: readonly NodeV1[];
  readonly edges: readonly EdgeV1[];
  readonly cycles: readonly (readonly string[])[];
  readonly warnings: readonly SnapshotWarningV1[];
}

export interface MetadataRule {
  readonly type: 'string' | 'number' | 'boolean';
  readonly mode: 'constant' | 'set';
  readonly maxDistinct?: number;
  readonly maxStringLength?: number;
  readonly redact?: 'none' | 'drop' | 'replace' | 'sha256';
}

export type MetadataSchema = Readonly<Record<string, MetadataRule>>;

export type EdgeMetadata = Readonly<Record<string, never>>;

export interface GraphOptions {
  readonly metadataSchema: MetadataSchema;
  readonly metadataSalt?: string;
  readonly maxNodes?: number;
  readonly maxEdges?: number;
  readonly onLimit?: 'throw' | 'drop';
}

export interface NodeDescriptor {
  readonly id: string;
  readonly kind: NodeKind;
  readonly label: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
