const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const hits = new Map<string, number[]>();

// ponytail: one process-local window; a cold start clears it
export function allowQuestion(groupId: string, now = Date.now()): boolean {
  const recent = (hits.get(groupId) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    hits.set(groupId, recent);
    return false;
  }
  recent.push(now);
  hits.set(groupId, recent);
  return true;
}

export function resetQuestionLimits(): void {
  hits.clear();
}
