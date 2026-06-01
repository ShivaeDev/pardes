import type { ManagerState } from '../manager/index.ts';
import type { WorkerRuntimeSnapshot, WorkerStatus } from '../worker-runtime/index.ts';
import type { DashboardPalette } from './palette.ts';
import { ATTACHED_AGENT_STATUSES, agentLabel, agentStatus } from './worker-projections.ts';

const BRIDGE_MONITOR_MAX_COLUMNS = 3;
const BRIDGE_MONITOR_COLUMN_GAP = 1;
const BRIDGE_MONITOR_MIN_PANE_WIDTH = 32;
const MAX_BRIDGE_MONITOR_ACTIVITY_LINES = 5;
const MIN_BRIDGE_MONITOR_ACTIVITY_LINES = 1;
const BRIDGE_MONITOR_RESERVED_TERMINAL_ROWS = 25;

export interface TerminalTextLayout {
  readonly visibleWidth: (text: string) => number;
  readonly truncateToWidth: (text: string, width: number, ellipsis?: string) => string;
}

export interface BridgeMonitorWorker {
  readonly agentId: string;
  readonly label: string;
  readonly status: WorkerStatus;
  readonly task: string;
  readonly recentActivityLines: ReadonlyArray<string>;
}

function fillToWidth(text: string, width: number, layout: TerminalTextLayout): string {
  const boundedWidth = Math.max(0, width);
  const truncated = layout.truncateToWidth(text, boundedWidth, '…');
  return `${truncated}${' '.repeat(Math.max(0, boundedWidth - layout.visibleWidth(truncated)))}`;
}

function bridgeMonitorPane(
  worker: BridgeMonitorWorker,
  width: number,
  maxActivityLines: number,
  palette: DashboardPalette,
  layout: TerminalTextLayout,
): string[] {
  if (width < 6)
    return [layout.truncateToWidth(`${worker.label} ${worker.status}`, Math.max(1, width), '…')];
  const innerWidth = width - 2;
  const border = (text: string) => palette.separator(text);
  const content = (text: string) =>
    `${border('│')}${fillToWidth(text, innerWidth, layout)}${border('│')}`;
  const title = fillToWidth(`${worker.label} · ${worker.status}`, innerWidth, layout);
  const activity =
    worker.recentActivityLines.length > 0
      ? worker.recentActivityLines.slice(-maxActivityLines)
      : [palette.dim('(waiting for visible activity)')];
  return [
    `${border('╭')}${palette.accent(title)}${border('╮')}`,
    ...activity.map((line) => content(palette.muted(line))),
    `${border('╰')}${border('─'.repeat(innerWidth))}${border('╯')}`,
  ];
}

function combineBridgeMonitorPanes(
  panes: ReadonlyArray<ReadonlyArray<string>>,
  paneWidth: number,
  width: number,
  layout: TerminalTextLayout,
): string[] {
  const height = Math.max(...panes.map((pane) => pane.length));
  const lines: string[] = [];
  for (let row = 0; row < height; row++) {
    const line = panes
      .map((pane) => fillToWidth(pane[row] ?? '', paneWidth, layout))
      .join(' '.repeat(BRIDGE_MONITOR_COLUMN_GAP));
    lines.push(layout.truncateToWidth(line, width, ''));
  }
  return lines;
}

function renderBridgeMonitorLinesWithActivityLimit(
  workers: ReadonlyArray<BridgeMonitorWorker>,
  width: number,
  maxActivityLines: number,
  palette: DashboardPalette,
  layout: TerminalTextLayout,
): string[] {
  const boundedWidth = Math.max(1, width);
  const lines = [
    layout.truncateToWidth(
      palette.accent('Pardes bridge monitor') +
        palette.dim(
          ` · ${workers.length} attached worker${workers.length === 1 ? '' : 's'} · /pardes monitor toggles`,
        ),
      boundedWidth,
      '…',
    ),
  ];
  const columns = Math.max(
    1,
    Math.min(
      workers.length,
      BRIDGE_MONITOR_MAX_COLUMNS,
      Math.max(
        1,
        Math.floor(
          (boundedWidth + BRIDGE_MONITOR_COLUMN_GAP) /
            (BRIDGE_MONITOR_MIN_PANE_WIDTH + BRIDGE_MONITOR_COLUMN_GAP),
        ),
      ),
    ),
  );
  const paneWidth =
    columns === 1
      ? boundedWidth
      : Math.max(
          1,
          Math.floor((boundedWidth - BRIDGE_MONITOR_COLUMN_GAP * (columns - 1)) / columns),
        );
  for (let index = 0; index < workers.length; index += columns) {
    const panes = workers
      .slice(index, index + columns)
      .map((worker) => bridgeMonitorPane(worker, paneWidth, maxActivityLines, palette, layout));
    lines.push(...combineBridgeMonitorPanes(panes, paneWidth, boundedWidth, layout));
  }
  return lines;
}

export function renderBridgeMonitorLines(
  workers: ReadonlyArray<BridgeMonitorWorker>,
  width: number,
  palette: DashboardPalette,
  layout: TerminalTextLayout,
  terminalRows = Number.POSITIVE_INFINITY,
): string[] {
  const monitorBudget = Number.isFinite(terminalRows)
    ? Math.max(0, Math.floor(terminalRows) - BRIDGE_MONITOR_RESERVED_TERMINAL_ROWS)
    : Number.POSITIVE_INFINITY;
  for (
    let maxActivityLines = MAX_BRIDGE_MONITOR_ACTIVITY_LINES;
    maxActivityLines >= MIN_BRIDGE_MONITOR_ACTIVITY_LINES;
    maxActivityLines -= 1
  ) {
    const lines = renderBridgeMonitorLinesWithActivityLimit(
      workers,
      width,
      maxActivityLines,
      palette,
      layout,
    );
    if (lines.length <= monitorBudget) return lines;
  }
  return [];
}

export function attachedBridgeMonitorWorkers(
  state: ManagerState,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
): BridgeMonitorWorker[] {
  return Object.values(state.agents).flatMap((agent) => {
    const runtime = runtimes.get(agent.id);
    const status = agentStatus(agent, runtime);
    if (!ATTACHED_AGENT_STATUSES.has(status)) return [];
    return [
      {
        agentId: agent.id,
        label: agentLabel(agent, runtime),
        recentActivityLines: runtime?.recentActivityLines ?? [],
        status,
        task: runtime?.task ?? agent.task,
      },
    ];
  });
}
