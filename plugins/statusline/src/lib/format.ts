// Compact human formatting for tokens, costs, durations, and reset times.

/** 182345 -> "182k", 1_250_000 -> "1.2M", 940 -> "940". */
export function tokens(n: number | undefined): string {
  if (!n || n < 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const k = n / 1000;
    return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return m < 10 ? `${m.toFixed(2)}M` : `${m.toFixed(1)}M`;
}

/** Money, always two decimals: 0.4231 -> "$0.42". Sub-cent keeps 3 dp. */
export function cost(usd: number | undefined): string {
  const v = usd ?? 0;
  if (v > 0 && v < 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** ms -> "45s" | "12m04s" | "1h02m". */
export function duration(ms: number | undefined): string {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  if (total < 60) return `${total}s`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}m${String(s).padStart(2, '0')}s`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

/** Short relative span for "resets in": 8100s -> "2h15m", 50s -> "50s". */
export function until(epochSeconds: number, now: number): string {
  const diff = Math.max(0, Math.round(epochSeconds - now));
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  const h = Math.floor(diff / 3600);
  const m = Math.round((diff % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

/** Absolute reset clock: "14:20" if today, else "Sat 14:20". */
export function clock(epochSeconds: number, now: number): string {
  const d = new Date(epochSeconds * 1000);
  const nd = new Date(now * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const sameDay =
    d.getFullYear() === nd.getFullYear() &&
    d.getMonth() === nd.getMonth() &&
    d.getDate() === nd.getDate();
  if (sameDay) return `${hh}:${mm}`;
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
  return `${day} ${hh}:${mm}`;
}
