import type { AgentRecord } from '../manager/index.ts';
import type { WorkerRuntimeSnapshot, WorkerStatus } from '../worker-runtime/index.ts';

export const ATTACHED_AGENT_STATUSES = new Set<WorkerStatus>(['starting', 'running', 'idle']);

function optionalProperty(value: object | undefined, property: string): unknown {
  if (!value || !(property in value)) return undefined;
  return (value as Record<string, unknown>)[property];
}

export function optionalString(value: object | undefined, property: string): string | undefined {
  const candidate = optionalProperty(value, property);
  if (typeof candidate !== 'string' || candidate.trim().length === 0) return undefined;
  return candidate.trim();
}

export function optionalNumber(value: object | undefined, property: string): number | undefined {
  const candidate = optionalProperty(value, property);
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
}

export function optionalTimestamp(value: object | undefined, property: string): number | undefined {
  const candidate = optionalProperty(value, property);
  if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  if (typeof candidate !== 'string') return undefined;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function shortAgentId(id: string): string {
  const separator = id.indexOf('-');
  if (separator === -1) return id.slice(0, 12);
  return `${id.slice(0, separator)}-${id.slice(separator + 1, separator + 9)}`;
}

export function agentLabel(agent: AgentRecord, runtime: WorkerRuntimeSnapshot | undefined): string {
  return (
    optionalString(agent, 'title') ?? optionalString(runtime, 'title') ?? shortAgentId(agent.id)
  );
}

export function agentStatus(
  agent: AgentRecord,
  runtime: WorkerRuntimeSnapshot | undefined,
): WorkerStatus {
  return runtime?.status ?? agent.status;
}
