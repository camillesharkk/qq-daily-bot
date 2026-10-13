import { timingSafeEqual } from "node:crypto";

export function isBearerAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const given = match?.[1];
  if (!given) return false;
  const givenBytes = Buffer.from(given);
  const expectedBytes = Buffer.from(secret);
  if (givenBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(givenBytes, expectedBytes);
}
