export type Activity = { tool: string; ok: boolean; duration_ms: number; at: string };
const recent: Activity[] = [];

export function recordActivity(tool: string, ok: boolean, duration_ms: number): void {
  recent.push({ tool, ok, duration_ms, at: new Date().toISOString() });
  if (recent.length > 100) recent.shift();
}

export function getRecentActivity(limit = 20): Activity[] {
  return recent.slice(-Math.min(Math.max(limit, 1), 100)).reverse();
}
