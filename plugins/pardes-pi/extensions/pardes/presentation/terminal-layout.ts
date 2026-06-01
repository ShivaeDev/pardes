import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import {
  type BridgeMonitorWorker,
  renderBridgeMonitorLines,
  type TerminalTextLayout,
} from './bridge-monitor.ts';
import { PLAIN_DASHBOARD_PALETTE } from './palette.ts';

export const TUI_TERMINAL_TEXT_LAYOUT: TerminalTextLayout = {
  truncateToWidth,
  visibleWidth,
};

export function bridgeMonitorLines(
  workers: ReadonlyArray<BridgeMonitorWorker>,
  width: number,
  terminalRows = Number.POSITIVE_INFINITY,
): string[] {
  return renderBridgeMonitorLines(
    workers,
    width,
    PLAIN_DASHBOARD_PALETTE,
    TUI_TERMINAL_TEXT_LAYOUT,
    terminalRows,
  );
}
