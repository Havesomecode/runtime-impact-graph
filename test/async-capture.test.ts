import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createGraph, NoActiveExecutionError } from '../src/index.js';

const route = (id: string) => ({
  id,
  kind: 'route' as const,
  label: id,
});

const capability = (id: string) => ({
  id,
  kind: 'capability' as const,
  label: id,
});

const resource = (id: string) => ({
  id,
  kind: 'resource' as const,
  label: id,
});

const waitForTimer = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('isolated asynchronous semantic capture', () => {
  it('keeps intentionally interleaved run roots independent', async () => {
    const graph = createGraph({ metadataSchema: {} });
    let releaseFirst: (() => void) | undefined;
    const firstCanContinue = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    await Promise.all([
      graph.run(async () => {
        await graph.withNode(route('route:first'), async () => {
          await firstCanContinue;
          await waitForTimer();
          await graph.withNode(capability('capability:first'), async () => {
            await Promise.resolve();
          });
        });
      }),
      graph.run(async () => {
        await graph.withNode(route('route:second'), async () => {
          await waitForTimer();
          releaseFirst?.();
          await graph.withNode(capability('capability:second'), async () => {
            await Promise.resolve();
          });
        });
      }),
    ]);

    assert.deepEqual(graph.snapshot().edges, [
      {
        from: 'route:first',
        to: 'capability:first',
        kind: 'contains',
        observations: 1,
      },
      {
        from: 'route:second',
        to: 'capability:second',
        kind: 'contains',
        observations: 1,
      },
    ]);
  });

  it('restores the parent scope after nested work completes', async () => {
    const graph = createGraph({ metadataSchema: {} });

    await graph.run(async () => {
      await graph.withNode(route('route:parent'), async () => {
        await graph.withNode(capability('capability:nested'), async () => {
          await waitForTimer();
        });
        await graph.withNode(resource('resource:after'), async () => {
          await Promise.resolve();
        });
      });
    });

    assert.deepEqual(graph.snapshot().edges, [
      {
        from: 'route:parent',
        to: 'capability:nested',
        kind: 'contains',
        observations: 1,
      },
      {
        from: 'route:parent',
        to: 'resource:after',
        kind: 'contains',
        observations: 1,
      },
    ]);
  });

  it('restores the parent scope after a synchronous throw', () => {
    const graph = createGraph({ metadataSchema: {} });

    graph.run(() => {
      graph.withNode(route('route:parent'), () => {
        assert.throws(
          () =>
            graph.withNode(capability('capability:throws'), () => {
              throw new Error('expected sync failure');
            }),
          /expected sync failure/,
        );
        graph.withNode(resource('resource:after'), () => undefined);
      });
    });

    assert.deepEqual(graph.snapshot().edges, [
      {
        from: 'route:parent',
        to: 'capability:throws',
        kind: 'contains',
        observations: 1,
      },
      {
        from: 'route:parent',
        to: 'resource:after',
        kind: 'contains',
        observations: 1,
      },
    ]);
  });

  it('restores the parent scope after a rejected promise', async () => {
    const graph = createGraph({ metadataSchema: {} });

    await graph.run(async () => {
      await graph.withNode(route('route:parent'), async () => {
        await assert.rejects(
          graph.withNode(capability('capability:rejects'), async () => {
            await waitForTimer();
            throw new Error('expected async failure');
          }),
          /expected async failure/,
        );
        await graph.withNode(resource('resource:after'), async () => {
          await Promise.resolve();
        });
      });
    });

    assert.deepEqual(graph.snapshot().edges, [
      {
        from: 'route:parent',
        to: 'capability:rejects',
        kind: 'contains',
        observations: 1,
      },
      {
        from: 'route:parent',
        to: 'resource:after',
        kind: 'contains',
        observations: 1,
      },
    ]);
  });

  it('does not bind a detached callback to the scope where it was created', () => {
    const graph = createGraph({ metadataSchema: {} });
    let detached: (() => void) | undefined;

    graph.run(() => {
      graph.withNode(route('route:creator'), () => {
        detached = () => {
          graph.withNode(resource('resource:detached'), () => undefined);
        };
      });
    });

    assert.throws(() => detached?.(), NoActiveExecutionError);
    graph.run(() => {
      graph.withNode(route('route:invoker'), () => detached?.());
    });

    assert.deepEqual(graph.snapshot().edges, [
      {
        from: 'route:invoker',
        to: 'resource:detached',
        kind: 'contains',
        observations: 1,
      },
    ]);
  });

  it('requires an active root for explicit dependency declarations', () => {
    const graph = createGraph({ metadataSchema: {} });
    graph.run(() => {
      graph.observe(resource('resource:upstream'));
      graph.observe(capability('capability:dependent'));
    });

    assert.throws(
      () => graph.dependsOn('resource:upstream', 'capability:dependent'),
      NoActiveExecutionError,
    );
    assert.deepEqual(graph.snapshot().edges, []);

    graph.run(() => {
      graph.dependsOn('resource:upstream', 'capability:dependent');
      graph.dependsOn('resource:upstream', 'capability:dependent');
    });

    assert.deepEqual(graph.snapshot().edges, [
      {
        from: 'resource:upstream',
        to: 'capability:dependent',
        kind: 'dependsOn',
        observations: 2,
      },
    ]);
  });

  it('keeps active contexts private to each graph instance', () => {
    const first = createGraph({ metadataSchema: {} });
    const second = createGraph({ metadataSchema: {} });

    first.run(() => {
      first.observe(resource('resource:first'));
      assert.throws(
        () => second.observe(resource('resource:second')),
        NoActiveExecutionError,
      );
    });

    assert.deepEqual(
      first.snapshot().nodes.map((node) => node.id),
      ['resource:first'],
    );
    assert.deepEqual(second.snapshot().nodes, []);
  });
});
