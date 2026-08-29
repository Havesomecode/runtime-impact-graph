import { AsyncLocalStorage } from 'node:async_hooks';

import { compareCanonical } from '../model/canonical.js';
import { findDependencyCycles } from '../model/cycles.js';
import {
  createSnapshotMetadataPolicy,
  fingerprintMetadataPolicy,
  mergeMetadata,
  normalizeMetadataSchema,
  processMetadata,
  validateSnapshotNodeMetadata,
} from '../model/metadata.js';
import type {
  EdgeMetadata,
  EdgeV1,
  GraphOptions,
  GraphSnapshotV1,
  MetadataSchema,
  NodeDescriptor,
  NodeV1,
  SnapshotMetadataPolicyV1,
} from '../model/types.js';
import {
  ContainmentCycleError,
  CountOverflowError,
  NoActiveExecutionError,
} from './errors.js';

const DEFAULT_MAX_NODES = 10_000;
const DEFAULT_MAX_EDGES = 50_000;
const NODE_KINDS = new Set([
  'route',
  'capability',
  'loader',
  'resource',
  'derived',
  'custom',
]);

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      return true;
    }
  }
  return false;
}

function assertEmptyPlainEdgeMetadata(value: EdgeMetadata): void {
  if (
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length > 0
  ) {
    throw new TypeError('Edge metadata is reserved and must be empty in v0.1.');
  }
}

interface ExecutionContext {
  readonly graph: Graph;
  readonly stack: readonly string[];
}

interface MutableNode {
  readonly id: string;
  readonly kind: NodeV1['kind'];
  readonly label: string;
  metadata: NodeV1['metadata'];
  observations: number;
}

interface MutableEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: EdgeV1['kind'];
  observations: number;
}

interface GraphCountOverridesForTest {
  readonly nodes?: Readonly<Record<string, number>>;
  readonly edges?: readonly (Pick<MutableEdge, 'from' | 'to' | 'kind'> & {
    readonly observations: number;
  })[];
  readonly warnings?: Readonly<
    Partial<Record<'node-limit' | 'edge-limit', number>>
  >;
}

const SET_COUNTS_FOR_TEST = new WeakMap<
  Graph,
  (overrides: GraphCountOverridesForTest) => void
>();

interface PreparedNodeMutation {
  readonly admitted: boolean;
  readonly commit: () => void;
}

export class Graph {
  readonly #storage = new AsyncLocalStorage<ExecutionContext>();
  readonly #schemaFingerprint: string;
  readonly #metadataPolicy: SnapshotMetadataPolicyV1;
  readonly #metadataSchema: MetadataSchema;
  readonly #metadataSalt: string | undefined;
  readonly #maxNodes: number;
  readonly #maxEdges: number;
  readonly #onLimit: 'throw' | 'drop';
  readonly #nodes = new Map<string, MutableNode>();
  readonly #edges = new Map<string, MutableEdge>();
  readonly #warnings = new Map<'node-limit' | 'edge-limit', number>();

  public constructor(options: GraphOptions) {
    this.#metadataSchema = normalizeMetadataSchema(options.metadataSchema);
    this.#metadataSalt = options.metadataSalt;
    this.#metadataPolicy = createSnapshotMetadataPolicy(
      this.#metadataSchema,
      this.#metadataSalt,
    );
    this.#schemaFingerprint = fingerprintMetadataPolicy(this.#metadataPolicy);
    this.#maxNodes = this.#validateLimit(
      options.maxNodes,
      DEFAULT_MAX_NODES,
      'maxNodes',
    );
    this.#maxEdges = this.#validateLimit(
      options.maxEdges,
      DEFAULT_MAX_EDGES,
      'maxEdges',
    );
    this.#onLimit = options.onLimit ?? 'throw';
    if (this.#onLimit !== 'throw' && this.#onLimit !== 'drop') {
      throw new TypeError('onLimit must be "throw" or "drop".');
    }
    SET_COUNTS_FOR_TEST.set(this, (overrides) => {
      for (const [id, observations] of Object.entries(overrides.nodes ?? {})) {
        const node = this.#nodes.get(id);
        if (node === undefined) throw new Error('Test node does not exist.');
        node.observations = observations;
      }
      for (const edgeOverride of overrides.edges ?? []) {
        const key = JSON.stringify([
          edgeOverride.from,
          edgeOverride.to,
          edgeOverride.kind,
        ]);
        const edge = this.#edges.get(key);
        if (edge === undefined) throw new Error('Test edge does not exist.');
        edge.observations = edgeOverride.observations;
      }
      for (const [code, count] of Object.entries(overrides.warnings ?? {})) {
        if (count !== undefined) {
          this.#warnings.set(code as 'node-limit' | 'edge-limit', count);
        }
      }
    });
  }

  public run<T>(work: () => T | Promise<T>): T | Promise<T> {
    return this.#storage.run({ graph: this, stack: [] }, work);
  }

  public withNode<T>(
    descriptor: NodeDescriptor,
    work: () => T | Promise<T>,
  ): T | Promise<T> {
    const context = this.#requireContext();
    if (context.stack.includes(descriptor.id)) {
      throw new ContainmentCycleError(descriptor.id);
    }
    const parent = context.stack.at(-1);
    if (
      parent !== undefined &&
      this.#closesContainmentCycle(parent, descriptor.id)
    ) {
      throw new ContainmentCycleError(descriptor.id);
    }
    const nodeMutation = this.#prepareNodeMutation(descriptor);
    if (!nodeMutation.admitted) {
      nodeMutation.commit();
      return work();
    }
    const edgeMutation =
      parent === undefined
        ? undefined
        : this.#prepareEdgeMutation(parent, descriptor.id, 'contains');
    nodeMutation.commit();
    edgeMutation?.();

    return this.#storage.run(
      { graph: this, stack: [...context.stack, descriptor.id] },
      work,
    );
  }

  public observe(descriptor: NodeDescriptor): void {
    this.#requireContext();
    this.#prepareNodeMutation(descriptor).commit();
  }

  public dependsOn(
    fromId: string,
    toId: string,
    options?: { readonly metadata?: EdgeMetadata },
  ): void {
    this.#requireContext();
    if (options?.metadata !== undefined) {
      assertEmptyPlainEdgeMetadata(options.metadata);
    }
    if (!this.#nodes.has(fromId) || !this.#nodes.has(toId)) {
      throw new Error('Both dependency nodes must already be registered.');
    }
    this.#prepareEdgeMutation(fromId, toId, 'dependsOn')();
  }

  public snapshot(): GraphSnapshotV1 {
    const nodes = [...this.#nodes.values()]
      .sort((left, right) => compareCanonical(left.id, right.id))
      .map((node) => ({ ...node }));
    const edges = [...this.#edges.values()]
      .sort(
        (left, right) =>
          compareCanonical(left.from, right.from) ||
          compareCanonical(left.to, right.to) ||
          compareCanonical(left.kind, right.kind),
      )
      .map((edge) => ({ ...edge }));

    return {
      format: 'runtime-impact-graph/v0.1',
      schemaFingerprint: this.#schemaFingerprint,
      metadataPolicy: this.#metadataPolicy,
      nodes,
      edges,
      cycles: findDependencyCycles(
        nodes.map((node) => node.id),
        edges,
      ),
      warnings: [...this.#warnings.entries()]
        .sort(([left], [right]) => compareCanonical(left, right))
        .map(([code, count]) => ({ code, count })),
    };
  }

  #requireContext(): ExecutionContext {
    const context = this.#storage.getStore();
    if (context === undefined) throw new NoActiveExecutionError();
    return context;
  }

  #prepareNodeMutation(descriptor: NodeDescriptor): PreparedNodeMutation {
    if (
      typeof descriptor.id !== 'string' ||
      typeof descriptor.label !== 'string' ||
      typeof descriptor.kind !== 'string' ||
      descriptor.id.length === 0 ||
      descriptor.id.length > 128 ||
      hasControlCharacter(descriptor.id) ||
      descriptor.label.length === 0 ||
      !NODE_KINDS.has(descriptor.kind)
    ) {
      throw new TypeError('Node id or label is invalid.');
    }
    const existing = this.#nodes.get(descriptor.id);
    if (existing === undefined && this.#nodes.size >= this.#maxNodes) {
      return {
        admitted: false,
        commit: this.#prepareLimitMutation('node-limit'),
      };
    }
    if (
      descriptor.kind === 'custom' &&
      (typeof descriptor.metadata?.customKind !== 'string' ||
        descriptor.metadata.customKind.length === 0)
    ) {
      throw new TypeError(
        'Custom nodes require non-empty metadata.customKind.',
      );
    }
    const metadata = processMetadata(
      descriptor.metadata,
      this.#metadataSchema,
      this.#metadataSalt,
    );
    validateSnapshotNodeMetadata(
      {
        id: descriptor.id,
        kind: descriptor.kind,
        label: descriptor.label,
        metadata,
        observations: 1,
      },
      this.#metadataSchema,
    );
    if (existing === undefined) {
      return {
        admitted: true,
        commit: () => {
          this.#nodes.set(descriptor.id, {
            id: descriptor.id,
            kind: descriptor.kind,
            label: descriptor.label,
            metadata,
            observations: 1,
          });
        },
      };
    }

    if (
      existing.kind !== descriptor.kind ||
      existing.label !== descriptor.label
    ) {
      throw new Error('Conflicting descriptor for an existing node.');
    }
    const mergedMetadata = mergeMetadata(
      existing.metadata,
      metadata,
      this.#metadataSchema,
    );
    if (existing.observations === Number.MAX_SAFE_INTEGER) {
      throw new CountOverflowError();
    }
    return {
      admitted: true,
      commit: () => {
        existing.metadata = mergedMetadata;
        existing.observations += 1;
      },
    };
  }

  #prepareEdgeMutation(
    from: string,
    to: string,
    kind: EdgeV1['kind'],
  ): () => void {
    const key = JSON.stringify([from, to, kind]);
    const existing = this.#edges.get(key);
    if (existing === undefined) {
      if (this.#edges.size >= this.#maxEdges) {
        return this.#prepareLimitMutation('edge-limit');
      }
      if (kind === 'contains' && this.#closesContainmentCycle(from, to)) {
        throw new ContainmentCycleError(to);
      }
      return () => {
        this.#edges.set(key, { from, to, kind, observations: 1 });
      };
    }

    if (existing.observations === Number.MAX_SAFE_INTEGER) {
      throw new CountOverflowError();
    }
    return () => {
      existing.observations += 1;
    };
  }

  #prepareLimitMutation(code: 'node-limit' | 'edge-limit'): () => void {
    if (this.#onLimit === 'throw') {
      throw new RangeError('Configured graph cardinality limit exceeded.');
    }
    const count = this.#warnings.get(code) ?? 0;
    if (count === Number.MAX_SAFE_INTEGER) throw new CountOverflowError();
    return () => {
      this.#warnings.set(code, count + 1);
    };
  }

  #closesContainmentCycle(from: string, to: string): boolean {
    if (from === to) return true;
    const pending = [to];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined || visited.has(current)) continue;
      if (current === from) return true;
      visited.add(current);
      for (const edge of this.#edges.values()) {
        if (edge.kind === 'contains' && edge.from === current) {
          pending.push(edge.to);
        }
      }
    }
    return false;
  }

  #validateLimit(
    value: number | undefined,
    maximum: number,
    name: string,
  ): number {
    const resolved = value ?? maximum;
    if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximum) {
      throw new TypeError(
        `${name} must be a safe integer from 0 through ${String(maximum)}.`,
      );
    }
    return resolved;
  }
}

export function createGraph(options: GraphOptions): Graph {
  return new Graph(options);
}

export function setGraphCountsForTest(
  graph: Graph,
  overrides: GraphCountOverridesForTest,
): void {
  const setCounts = SET_COUNTS_FOR_TEST.get(graph);
  if (setCounts === undefined)
    throw new Error('Graph test seam is unavailable.');
  setCounts(overrides);
}
