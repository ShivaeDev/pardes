import { Effect } from 'effect';
import { describe, expect, test } from 'vitest';
import { makeWorkerEventDispatcher } from './events.ts';

describe('worker event dispatcher', () => {
  test('serializes offered events in FIFO order and drains a slow handler before shutdown', async () => {
    const events: number[] = [];
    const dispatcher = makeWorkerEventDispatcher<number>((event) =>
      Effect.gen(function* () {
        if (event === 1) yield* Effect.sleep('30 millis');
        events.push(event);
      }),
    );

    await Effect.runPromise(dispatcher.start);
    dispatcher.offer(1);
    dispatcher.offer(2);
    dispatcher.offer(3);
    await Effect.runPromise(dispatcher.shutdown);

    expect(events).toEqual([1, 2, 3]);
  });

  test('logs handler defects and continues dispatching later events', async () => {
    const events: number[] = [];
    const logged: unknown[][] = [];
    const previousError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const dispatcher = makeWorkerEventDispatcher<number>((event) =>
        event === 2
          ? Effect.die(new Error('fixture defect'))
          : Effect.sync(() => {
              events.push(event);
            }),
      );

      await Effect.runPromise(dispatcher.start);
      dispatcher.offer(1);
      dispatcher.offer(2);
      dispatcher.offer(3);
      await Effect.runPromise(dispatcher.shutdown);
    } finally {
      console.error = previousError;
    }

    expect(events).toEqual([1, 3]);
    expect(logged).toHaveLength(1);
    expect(logged[0]?.[0]).toBe('Pardes worker event handler failed');
    expect(logged[0]?.[1]).toBeInstanceOf(Error);
  });

  test('makes concurrent start and shutdown calls idempotent', async () => {
    const events: number[] = [];
    const dispatcher = makeWorkerEventDispatcher<number>((event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    );

    await Effect.runPromise(
      Effect.all([dispatcher.start, dispatcher.start], { concurrency: 'unbounded', discard: true }),
    );
    dispatcher.offer(1);
    await Effect.runPromise(
      Effect.all([dispatcher.shutdown, dispatcher.shutdown], {
        concurrency: 'unbounded',
        discard: true,
      }),
    );

    expect(events).toEqual([1]);
  });

  test('ignores offers before start and after shutdown', async () => {
    const events: number[] = [];
    const dispatcher = makeWorkerEventDispatcher<number>((event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    );

    dispatcher.offer(1);
    await Effect.runPromise(dispatcher.start);
    dispatcher.offer(2);
    await Effect.runPromise(dispatcher.shutdown);
    dispatcher.offer(3);
    await Effect.runPromise(dispatcher.shutdown);

    expect(events).toEqual([2]);
  });

  test('starts a fresh dispatcher after shutdown', async () => {
    const events: number[] = [];
    const dispatcher = makeWorkerEventDispatcher<number>((event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    );

    await Effect.runPromise(dispatcher.start);
    dispatcher.offer(1);
    await Effect.runPromise(dispatcher.shutdown);
    await Effect.runPromise(dispatcher.start);
    dispatcher.offer(2);
    await Effect.runPromise(dispatcher.shutdown);

    expect(events).toEqual([1, 2]);
  });
});
