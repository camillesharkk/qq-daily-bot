type Claim = { at: number };

const claims = new Map<string, Claim>();
const TTL_MS = 10 * 60 * 1000;

function prune(now: number): void {
  for (const [id, claim] of claims) {
    if (now - claim.at > TTL_MS) claims.delete(id);
  }
}

export function hasReply(id: string, now = Date.now()): boolean {
  prune(now);
  return claims.has(id);
}

export function finishReply(id: string, sent: boolean, now = Date.now()): void {
  if (sent) claims.set(id, { at: now });
  else claims.delete(id);
}

export function resetReplyClaims(): void {
  claims.clear();
}
