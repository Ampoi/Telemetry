export const DAY = 86400_000, SLOT = 1800_000;
export interface PollMember { id: string; name: string }
export interface PollInput { id: string; guild: string; user: string; channel: string; document: string; created: number }
export interface PollState extends PollInput {
  start: number; duration?: number; title: string;
  status: 'draft' | 'open' | 'booking' | 'confirmed' | 'cancelled';
  members: PollMember[]; answers: Record<string, number[]>;
  meetingAt?: number; error?: string; notified?: boolean; notificationAttempted?: boolean;
}
export function windowStart(now: number): number {
  return Math.floor((now + 9 * 3600_000) / DAY) * DAY - 9 * 3600_000 + 5 * DAY;
}
// Prefer the central day, then the earlier day, then the earliest shared time.
export function commonSlot(p: PollState, now: number): number | undefined {
  if (!p.members.length || p.members.some(m => !Object.hasOwn(p.answers, m.id))) return;
  const sets = p.members.map(m => new Set(p.answers[m.id]));
  for (const day of [2, 1, 3, 0, 4]) for (let slot = 0; slot <= 48 - (p.duration ?? 30) / 30; slot++) {
    const index = day * 48 + slot;
    if (p.start + index * SLOT <= now + 3600_000) continue;
    if (sets.every(s => Array.from({ length: (p.duration ?? 30) / 30 }, (_, n) => index + n).every(n => s.has(n)))) return p.start + index * SLOT;
  }
}

export function meetingTitle(at: number): string {
  return new Date(at + 9 * 3600_000).toISOString().slice(0, 10).replaceAll('-', '/') + ' 定例mtg';
}
