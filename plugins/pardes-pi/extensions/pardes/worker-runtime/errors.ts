import { Data } from 'effect';

export class WorkerProcessError extends Data.TaggedError('WorkerProcessError')<{
  readonly agentId: string;
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class WorkerRpcError extends Data.TaggedError('WorkerRpcError')<{
  readonly agentId: string;
  readonly command: string;
  readonly cause: unknown;
}> {}
