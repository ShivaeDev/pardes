import { Data } from 'effect';

export class AgentNotFoundError extends Data.TaggedError('AgentNotFoundError')<{
  readonly agentId: string;
}> {}

export class AgentAlreadyRunningError extends Data.TaggedError('AgentAlreadyRunningError')<{
  readonly agentId: string;
}> {}
