import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { deriveSeed, signUtf8, signValidation, verifyEventSignature } from "@/lib/qq/signature";

const OFFICIAL_PUBLIC_KEY = [
  215, 195, 98, 254, 120, 174, 248, 31, 242, 50, 135, 180, 147, 98, 139, 93, 176, 42, 60, 79, 227,
  11, 33, 94, 77, 25, 96, 155, 93, 118, 103, 58,
];

describe("qq ed25519 signature", () => {
  it("derives a 32-byte seed", () => {
    expect(deriveSeed("DG5g3B4j9X2KOErG")).toHaveLength(32);
    expect(deriveSeed("a-secret-that-is-longer-than-thirty-two-bytes")).toHaveLength(32);
  });

  it("repeats a short app secret until the seed is filled", () => {
    const secret = "abc";
    const expected = new TextEncoder().encode(secret.repeat(11)).subarray(0, 32);
    expect(Buffer.from(deriveSeed(secret)).equals(Buffer.from(expected))).toBe(true);
    expect(Buffer.from(deriveSeed("naOC0ocQE3shWLAfffVLB1rhYPG7")).toString("utf8")).toBe(
      "naOC0ocQE3shWLAfffVLB1rhYPG7naOC",
    );
  });

  it("returns a lowercase hex validation signature", () => {
    const signature = signValidation("DG5g3B4j9X2KOErG", "1725442341", "Arq0D5A61EgUu4OxUvOp");
    expect(signature).toMatch(/^[0-9a-f]+$/);
    expect(signature).toHaveLength(128);
  });

  it("matches the official callback validation vector", () => {
    expect(signValidation("DG5g3B4j9X2KOErG", "1725442341", "Arq0D5A61EgUu4OxUvOp")).toBe(
      "87befc99c42c651b3aac0278e71ada338433ae26fcb24307bdc5ad38c1adc2d01bcfcadc0842edac85e85205028a1132afe09280305f13aa6909ffc2d652c706",
    );
  });

  it("matches the official seed public key", () => {
    const publicKey = nacl.sign.keyPair.fromSeed(deriveSeed("naOC0ocQE3shWLAfffVLB1rhYPG7")).publicKey;
    expect(Array.from(publicKey)).toEqual(OFFICIAL_PUBLIC_KEY);
  });

  it("round-trips a signature and fails when the raw body changes", () => {
    const secret = "round-trip-secret";
    const raw = '{"op":0,"t":"GROUP_AT_MESSAGE_CREATE","d":{"group_openid":"g"}}';
    const timestamp = "1725442341";
    const signature = signUtf8(secret, `${timestamp}${raw}`);
    expect(signature).toMatch(/^[0-9a-f]+$/);
    expect(verifyEventSignature(secret, timestamp, raw, signature)).toBe(true);
    expect(verifyEventSignature(secret, timestamp, raw.replace("g", "h"), signature)).toBe(false);
    expect(verifyEventSignature(secret, timestamp, raw, "")).toBe(false);
  });
});
