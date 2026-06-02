import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  type Component,
  Key,
  matchesKey,
  Text,
  type TUI,
  truncateToWidth,
} from '@earendil-works/pi-tui';
import type { GitHubRateLimitCompactStatus } from '../github/index.ts';
import type { ManagerCompactionSafetySnapshot, ManagerState } from '../manager/index.ts';
import type { WorkerRuntimeSnapshot } from '../worker-runtime/index.ts';
import {
  attachedBridgeMonitorWorkers,
  type BridgeMonitorWorker,
  renderBridgeMonitorLines,
} from './bridge-monitor.ts';
import {
  compactWidgetLines,
  dashboardLines,
  dashboardSummary,
  githubRateStatusToken,
  renderCompactWidgetLines,
  renderDashboardLines,
} from './dashboard.ts';
import { managerContextSummary } from './manager-context.ts';
import type { DashboardPalette } from './palette.ts';
import { TUI_TERMINAL_TEXT_LAYOUT } from './terminal-layout.ts';

const WIDGET_KEY = 'pardes-manager';
const STATUS_KEY = 'pardes-manager';
const BRIDGE_MONITOR_WIDGET_KEY = 'pardes-bridge-monitor';

function themePalette(theme: Theme): DashboardPalette {
  return {
    accent: (text) => theme.fg('accent', text),
    dim: (text) => theme.fg('dim', text),
    error: (text) => theme.fg('error', text),
    muted: (text) => theme.fg('muted', text),
    separator: (text) => theme.fg('borderMuted', text),
    success: (text) => theme.fg('success', text),
    warning: (text) => theme.fg('warning', text),
  };
}

interface DashboardWidgetFactory {
  (tui: TUI, theme: Theme): Component;
  join(separator?: string): string;
}

function dashboardWidgetFactory(
  ctx: ExtensionContext,
  state: ManagerState,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
  githubRateStatus?: GitHubRateLimitCompactStatus,
): DashboardWidgetFactory {
  const factory = ((_tui: TUI, theme: Theme) => ({
    invalidate: () => {},
    render: (width: number) =>
      renderCompactWidgetLines(
        state,
        runtimes,
        Date.now(),
        themePalette(theme),
        managerContextSummary(ctx.getContextUsage()),
        githubRateStatus,
      ).map((line) => truncateToWidth(line, width)),
  })) as DashboardWidgetFactory;
  // Preserve a plain projection for simple headless adapters that inspect widget text without instantiating its component.
  factory.join = (separator?: string) =>
    compactWidgetLines(state, runtimes, Date.now(), githubRateStatus).join(separator);
  return factory;
}

interface BridgeMonitorState {
  readonly managerId: string;
  manuallyHidden: boolean;
}

function bridgeMonitorWidgetFactory(workers: ReadonlyArray<BridgeMonitorWorker>) {
  return (tui: TUI, theme: Theme): Component => ({
    invalidate: () => {},
    render: (width) =>
      renderBridgeMonitorLines(
        workers,
        width,
        themePalette(theme),
        TUI_TERMINAL_TEXT_LAYOUT,
        tui.terminal.rows,
      ),
  });
}

function overlayText(
  state: ManagerState | undefined,
  runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
  palette: DashboardPalette,
): string {
  if (!state) {
    return [
      palette.warning('Pardes manager is inactive'),
      '',
      palette.muted('Run /pardes start to activate a manager for this Pi session.'),
      '',
      palette.dim('Esc, Enter, or q closes this panel.'),
    ].join('\n');
  }
  return [
    palette.accent(`Pardes manager ${state.managerId}`),
    palette.muted(`Repository: ${state.repo.primaryCheckout}`),
    palette.dim(`Revision: ${state.revision}`),
    '',
    ...renderDashboardLines(state, runtimes, Date.now(), palette),
    '',
    palette.accent('Commands:'),
    palette.muted('  /pardes start    activate this session'),
    palette.muted('  /pardes stop     deactivate this session'),
    palette.muted('  /pardes          open this panel'),
    '',
    palette.accent('Tool groups:'),
    palette.muted('  status and inbox · workstreams · workers · advisory verification · reports'),
    palette.muted('  pull_request_create publishes only; merges remain user-controlled'),
    '',
    palette.dim('Esc, Enter, or q closes this panel.'),
  ].join('\n');
}

export interface ManagerPresentation {
  readonly updateDashboard: (
    ctx: ExtensionContext,
    state: ManagerState,
    runtimes?: ReadonlyMap<string, WorkerRuntimeSnapshot>,
    compactionSafety?: ManagerCompactionSafetySnapshot,
    githubRateStatus?: GitHubRateLimitCompactStatus,
  ) => void;
  readonly clearDashboard: (ctx: ExtensionContext) => void;
  readonly toggleBridgeMonitor: (
    ctx: ExtensionContext,
    state: ManagerState | undefined,
    runtimes?: ReadonlyMap<string, WorkerRuntimeSnapshot>,
  ) => 'hidden' | 'shown' | 'unavailable';
  readonly showDashboardOverlay: (
    ctx: ExtensionContext,
    state: ManagerState | undefined,
    runtimes?: ReadonlyMap<string, WorkerRuntimeSnapshot>,
  ) => Promise<void>;
}

/** Own transient Pi dashboard state for one loaded Pardes extension instance. */
export function makeManagerPresentation(): ManagerPresentation {
  let bridgeMonitorState: BridgeMonitorState | undefined;

  const currentBridgeMonitorState = (managerId: string): BridgeMonitorState => {
    if (bridgeMonitorState?.managerId === managerId) return bridgeMonitorState;
    bridgeMonitorState = { managerId, manuallyHidden: false };
    return bridgeMonitorState;
  };

  const setBridgeMonitorWidget = (
    ctx: ExtensionContext,
    workers: ReadonlyArray<BridgeMonitorWorker>,
    hidden: boolean,
  ): void => {
    ctx.ui.setWidget(
      BRIDGE_MONITOR_WIDGET_KEY,
      workers.length === 0 || hidden ? undefined : bridgeMonitorWidgetFactory(workers),
      { placement: 'aboveEditor' },
    );
  };

  const updateBridgeMonitor = (
    ctx: ExtensionContext,
    state: ManagerState,
    runtimes: ReadonlyMap<string, WorkerRuntimeSnapshot>,
  ): void => {
    if (!ctx.hasUI) return;
    const monitorState = currentBridgeMonitorState(state.managerId);
    const workers = attachedBridgeMonitorWorkers(state, runtimes);
    setBridgeMonitorWidget(ctx, workers, monitorState.manuallyHidden);
  };

  return {
    clearDashboard(ctx) {
      bridgeMonitorState = undefined;
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setWidget(BRIDGE_MONITOR_WIDGET_KEY, undefined);
    },

    async showDashboardOverlay(ctx, state, runtimes = new Map()) {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          state ? dashboardLines(state, runtimes).join('\n') : 'Pardes manager is inactive.',
          'info',
        );
        return;
      }
      await ctx.ui.custom<void>(
        (_tui, theme, _keybindings, done) => ({
          handleInput: (data) => {
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === 'q') done();
          },
          invalidate: () => {},
          render: (width) =>
            new Text(
              theme.fg('accent', theme.bold('Pardes control plane')) +
                `\n\n${overlayText(state, runtimes, themePalette(theme))}`,
              1,
              1,
            ).render(width),
        }),
        {
          overlay: true,
          overlayOptions: { anchor: 'center', margin: 1, maxHeight: '80%', width: '80%' },
        },
      );
    },
    toggleBridgeMonitor(ctx, state, runtimes = new Map()) {
      if (!state || !ctx.hasUI) return 'unavailable';
      const monitorState = currentBridgeMonitorState(state.managerId);
      const workers = attachedBridgeMonitorWorkers(state, runtimes);
      if (workers.length === 0) {
        setBridgeMonitorWidget(ctx, workers, monitorState.manuallyHidden);
        return 'unavailable';
      }
      monitorState.manuallyHidden = !monitorState.manuallyHidden;
      setBridgeMonitorWidget(ctx, workers, monitorState.manuallyHidden);
      return monitorState.manuallyHidden ? 'hidden' : 'shown';
    },

    updateDashboard(ctx, state, runtimes = new Map(), compactionSafety, githubRateStatus) {
      const { counts, statuses } = dashboardSummary(state, runtimes);
      const warning = statuses.warnings > 0 ? ` warn:${statuses.warnings}` : '';
      const compaction =
        compactionSafety === undefined
          ? ''
          : compactionSafety.phase === 'started_unsettled'
            ? ' cmp:hold/expiry'
            : compactionSafety.phase === 'succeeded_unsettled'
              ? ' cmp:ok/resume'
              : ' cmp:abort/expiry';
      const githubRate =
        githubRateStatus === undefined ? '' : ` ${githubRateStatusToken(githubRateStatus)}`;
      const status = `pardes:${state.managerId.slice(0, 8)} run:${statuses.running} idle:${statuses.idle}${warning} inbox:${state.inbox.length}${compaction}${githubRate}`;
      ctx.ui.setStatus(
        STATUS_KEY,
        ctx.ui.theme.fg(
          statuses.warnings > 0 || compactionSafety !== undefined ? 'warning' : 'accent',
          status,
        ),
      );
      ctx.ui.setWidget(WIDGET_KEY, dashboardWidgetFactory(ctx, state, runtimes, githubRateStatus), {
        placement: 'belowEditor',
      });
      ctx.ui.setTitle(
        `pi · pardes ${state.managerId.slice(0, 8)} · ${counts.workstreams} workstreams`,
      );
      updateBridgeMonitor(ctx, state, runtimes);
    },
  };
}
