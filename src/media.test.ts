import { describe, expect, it, vi } from "vitest";
import { attachmentFromMessageItem, encryptAesEcb, parseAesKey } from "./media.js";
import { MessageItemType } from "./types.js";

describe("parseAesKey", () => {
  const rawKey = Buffer.from("00112233445566778899aabbccddeeff", "hex");

  it("decodes base64 of raw 16 bytes (image format)", () => {
    expect(parseAesKey(rawKey.toString("base64"))).toEqual(rawKey);
  });

  it("decodes base64 of a 32-char hex string (file/voice/video format)", () => {
    const hexTextKey = Buffer.from(rawKey.toString("hex"), "ascii");
    expect(parseAesKey(hexTextKey.toString("base64"))).toEqual(rawKey);
  });

  it("rejects keys that decode to neither 16 bytes nor 32-char hex", () => {
    expect(() => parseAesKey(Buffer.from("too-short").toString("base64"))).toThrow(/aes_key must/);
  });
});

describe("voice message handling", () => {
  it("skips the audio attachment when the server provides a transcription", () => {
    const attachment = attachmentFromMessageItem({
      cdnBaseUrl: "https://cdn.example/c2c",
      item: {
        type: MessageItemType.VOICE,
        voice_item: {
          text: "你好",
          media: { encrypt_query_param: "voice-param", aes_key: "AAAA" },
        },
      },
    });
    expect(attachment).toBeNull();
  });

  it("decrypts the SILK payload and exposes it as audio when there is no text", async () => {
    const keyHex = "00112233445566778899aabbccddeeff";
    // voice/file/video carry aes_key as base64 of the 32-char hex string.
    const aesKey = Buffer.from(keyHex, "ascii").toString("base64");
    const silk = Buffer.from("#!SILK_V3 raw payload fixture");
    const ciphertext = encryptAesEcb(silk, Buffer.from(keyHex, "hex"));
    const fetchFn = vi.fn(async () => new Response(new Uint8Array(ciphertext), { status: 200 }));

    const attachment = attachmentFromMessageItem({
      cdnBaseUrl: "https://cdn.example/c2c",
      fetchFn,
      item: {
        type: MessageItemType.VOICE,
        voice_item: { media: { encrypt_query_param: "voice-param", aes_key: aesKey } },
      },
    });

    expect(attachment?.type).toBe("audio");
    // silk-wasm cannot decode the fixture, so fetchData falls back to raw SILK.
    await expect(attachment?.fetchData?.()).resolves.toEqual(silk);
  });
});
