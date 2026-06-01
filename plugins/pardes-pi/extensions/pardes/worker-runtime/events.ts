import { Cause, Effect, Exit, Fiber, Queue, Scope, Semaphore } from 'effect';

type WorkerEventDispatch<A> =
  | { readonly _tag: 'event'; readonly event: A }
  | { readonly _tag: 'stop' };

interface ActiveWorkerEventDispatcher<A> {
  readonly queue: Queue.Queue<WorkerEventDispatch<A>>;
  readonly scope: Scope.Closeable;
  readonly fiber: Fiber.Fiber<void>;
  accepting: boolean;
}

export interface WorkerEventDispatcher<A> {
  readonly start: Effect.Effect<void>;
  readonly offer: (event: A) => void;
  readonly shutdown: Effect.Effect<void>;
}

export function makeWorkerEventDispatcher<A>(
  onEvent?: (event: A) => Effect.Effect<void, unknown>,
): WorkerEventDispatcher<A> {
  const semaphore = Semaphore.makeUnsafe(1);
  let dispatcher: ActiveWorkerEventDispatcher<A> | undefined;

  const start = semaphore.withPermit(
    Effect.gen(function* () {
      if (!onEvent || dispatcher) return;
      const queue = yield* Queue.unbounded<WorkerEventDispatch<A>>();
      const scope = yield* Scope.make();
      const fiber = yield* Effect.gen(function* () {
        while (true) {
          const dispatch = yield* Queue.take(queue);
          if (dispatch._tag === 'stop') return;
          yield* onEvent(dispatch.event).pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                console.error('Pardes worker event handler failed', Cause.squash(cause));
              }),
            ),
          );
        }
      }).pipe(Effect.forkIn(scope, { startImmediately: true }));
      dispatcher = { accepting: true, fiber, queue, scope };
    }),
  );

  const offer = (event: A) => {
    const active = dispatcher;
    if (!active?.accepting) return;
    // Node stream listeners are synchronous callback boundaries. The unbounded
    // Effect queue makes this lossless without launching detached handler fibers.
    Queue.offerUnsafe(active.queue, { _tag: 'event', event });
  };

  const shutdown = semaphore.withPermit(
    Effect.gen(function* () {
      const active = dispatcher;
      if (!active) return;
      active.accepting = false;
      yield* Queue.offer(active.queue, { _tag: 'stop' });
      yield* Fiber.await(active.fiber);
      yield* Queue.shutdown(active.queue);
      yield* Scope.close(active.scope, Exit.void);
      if (dispatcher === active) dispatcher = undefined;
    }),
  );

  return { offer, shutdown, start };
}
