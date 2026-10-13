import nacl from "tweetnacl";

const SEED_LENGTH = 32;

export function deriveSeed(secret: string): Uint8Array {
  const bytes = new TextEncoder().encode(secret);
  if (bytes.length === 0) {
    throw new Error("Missing required environment variable: QQ_APP_SECRET");
  }
  const seed = new Uint8Array(SEED_LENGTH);
  let offset = 0;
  while (offset < SEED_LENGTH) {
    const take = Math.min(bytes.length, SEED_LENGTH - offset);
    seed.set(bytes.subarray(0, take), offset);
    offset += take;
  }
  return seed;
}

function keyPairFromSecret(secret: string): nacl.SignKeyPair {
  return nacl.sign.keyPair.fromSeed(deriveSeed(secret));
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function signUtf8(secret: string, message: string): string {
  const pair = keyPairFromSecret(secret);
  const signature = nacl.sign.detached(new TextEncoder().encode(message), pair.secretKey);
  return toHex(signature);
}

export function signValidation(secret: string, eventTs: string, plainToken: string): string {
  return signUtf8(secret, `${eventTs}${plainToken}`);
}

function decodeSignature(signatureHex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]{128}$/.test(signatureHex)) return null;
  const bytes = Buffer.from(signatureHex, "hex");
  if (bytes.length !== nacl.sign.signatureLength) return null;
  const last = bytes[63];
  if (last === undefined || (last & 224) !== 0) return null;
  return bytes;
}

export function verifyEventSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signatureHex: string,
): boolean {
  const signature = decodeSignature(signatureHex);
  if (!signature) return false;
  const pair = keyPairFromSecret(secret);
  const message = new TextEncoder().encode(`${timestamp}${rawBody}`);
  return nacl.sign.detached.verify(message, signature, pair.publicKey);
}
