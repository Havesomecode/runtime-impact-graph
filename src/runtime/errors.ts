export class NoActiveExecutionError extends Error {
  public constructor() {
    super('An active graph.run execution is required.');
    this.name = 'NoActiveExecutionError';
  }
}

export class CountOverflowError extends Error {
  public constructor() {
    super('An observation count exceeded Number.MAX_SAFE_INTEGER.');
    this.name = 'CountOverflowError';
  }
}

export class ContainmentCycleError extends Error {
  public constructor(nodeId: string) {
    super(`Containment cycle detected at node ${nodeId}.`);
    this.name = 'ContainmentCycleError';
  }
}
