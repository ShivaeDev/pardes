export interface DashboardPalette {
  readonly accent: (text: string) => string;
  readonly muted: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly success: (text: string) => string;
  readonly warning: (text: string) => string;
  readonly error: (text: string) => string;
  readonly separator: (text: string) => string;
}

const plain = (text: string) => text;

export const PLAIN_DASHBOARD_PALETTE: DashboardPalette = {
  accent: plain,
  dim: plain,
  error: plain,
  muted: plain,
  separator: plain,
  success: plain,
  warning: plain,
};
