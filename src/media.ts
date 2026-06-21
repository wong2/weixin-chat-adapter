import crypto, { createCipheriv, createDecipheriv } from "node:crypto";
import { ValidationError } from "@chat-adapter/shared";
import type { Attachment, FileUpload } from "chat";
import {
  DEFAULT_CDN_BASE_URL,
  MessageItemType,
  UploadMediaType,
  type CDNMedia,
  type GetUploadUrlResp,
  type MessageItem,
  type UploadedFileInfo,
  type WeixinFetch,
} from "./types.js";
import type { WeixinProtocolClient } from "./protocol.js";
import { silkToWav } from "./silk.js";

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Parse CDNMedia.aes_key into a raw 16-byte AES key.
 *
 * Two encodings appear on the wire (see @tencent-weixin/openclaw-weixin):
 *   - base64(raw 16 bytes)           → images (aes_key from media field)
 *   - base64(32-char hex string)     → file / voice / video
 *
 * In the second case, base64-decoding yields 32 ASCII hex chars which must
 * then be parsed as hex to recover the actual 16-byte key.
 */
export function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new ValidationError(
    "weixin",
    `aes_key must decode to 16 raw bytes or a 32-char hex string, got ${decoded.length} bytes`,
  );
}

export async function fileUploadToBuffer(file: FileUpload): Promise<Buffer> {
  if (Buffer.isBuffer(file.data)) return file.data;
  if (file.data instanceof ArrayBuffer) return Buffer.from(file.data);
  if (typeof Blob !== "undefined" && file.data instanceof Blob) {
    return Buffer.from(await file.data.arrayBuffer());
  }
  throw new ValidationError("weixin", `Unsupported file data for ${file.filename}`);
}

export async function attachmentToBuffer(
  attachment: Attachment,
  fetchFn: WeixinFetch = fetch,
): Promise<Buffer> {
  if (Buffer.isBuffer(attachment.data)) return attachment.data;
  if (typeof Blob !== "undefined" && attachment.data instanceof Blob) {
    return Buffer.from(await attachment.data.arrayBuffer());
  }
  if (attachment.fetchData) return await attachment.fetchData();
  if (attachment.url?.startsWith("http://") || attachment.url?.startsWith("https://")) {
    const res = await fetchFn(attachment.url);
    if (!res.ok) {
      throw new ValidationError(
        "weixin",
        `Failed to fetch remote attachment ${attachment.url}: ${res.status}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }
  throw new ValidationError("weixin", `Attachment ${attachment.name ?? ""} has no uploadable data`);
}

export async function uploadBufferToWeixin(params: {
  protocol: WeixinProtocolClient;
  fetchFn?: WeixinFetch;
  cdnBaseUrl?: string;
  toUserId: string;
  buffer: Buffer;
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
}): Promise<UploadedFileInfo> {
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);
  const rawfilemd5 = crypto.createHash("md5").update(params.buffer).digest("hex");
  const ciphertext = encryptAesEcb(params.buffer, aeskey);
  const uploadUrl = await params.protocol.getUploadUrl({
    filekey,
    media_type: params.mediaType,
    to_user_id: params.toUserId,
    rawsize: params.buffer.length,
    rawfilemd5,
    filesize: ciphertext.length,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });
  const downloadEncryptedQueryParam = await uploadCiphertextToCdn({
    fetchFn: params.fetchFn,
    cdnBaseUrl: params.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
    uploadUrl,
    filekey,
    ciphertext,
  });

  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString("hex"),
    fileSize: params.buffer.length,
    fileSizeCiphertext: ciphertext.length,
  };
}

async function uploadCiphertextToCdn(params: {
  uploadUrl: GetUploadUrlResp;
  filekey: string;
  cdnBaseUrl: string;
  ciphertext: Buffer;
  fetchFn?: WeixinFetch;
}): Promise<string> {
  const url =
    params.uploadUrl.upload_full_url?.trim() ||
    (params.uploadUrl.upload_param
      ? buildCdnUploadUrl(params.cdnBaseUrl, params.uploadUrl.upload_param, params.filekey)
      : undefined);
  if (!url) {
    throw new ValidationError("weixin", "getUploadUrl returned no upload URL or upload_param");
  }
  const fetchFn = params.fetchFn ?? fetch;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(params.ciphertext),
  });
  if (!res.ok) {
    throw new ValidationError("weixin", `CDN upload failed with status ${res.status}`);
  }
  const encryptedParam = res.headers.get("x-encrypted-param");
  if (!encryptedParam) {
    throw new ValidationError("weixin", "CDN upload response missing x-encrypted-param");
  }
  return encryptedParam;
}

function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(
    uploadParam,
  )}&filekey=${encodeURIComponent(filekey)}`;
}

export function buildCdnDownloadUrl(encryptedQueryParam: string, cdnBaseUrl: string): string {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

export function uploadedToMessageItem(params: {
  uploaded: UploadedFileInfo;
  kind: "image" | "video" | "file";
  fileName?: string;
}): MessageItem {
  const media: CDNMedia = {
    encrypt_query_param: params.uploaded.downloadEncryptedQueryParam,
    aes_key: Buffer.from(params.uploaded.aeskey, "hex").toString("base64"),
    encrypt_type: 1,
  };
  if (params.kind === "image") {
    return {
      type: MessageItemType.IMAGE,
      image_item: {
        media,
        mid_size: params.uploaded.fileSizeCiphertext,
      },
    };
  }
  if (params.kind === "video") {
    return {
      type: MessageItemType.VIDEO,
      video_item: {
        media,
        video_size: params.uploaded.fileSizeCiphertext,
      },
    };
  }
  return {
    type: MessageItemType.FILE,
    file_item: {
      media,
      file_name: params.fileName ?? "file.bin",
      len: String(params.uploaded.fileSize),
    },
  };
}

export function inferUploadKind(
  mimeType: string | undefined,
  type?: Attachment["type"],
): {
  kind: "image" | "video" | "file";
  mediaType: (typeof UploadMediaType)[keyof typeof UploadMediaType];
} {
  if (type === "image" || mimeType?.startsWith("image/")) {
    return { kind: "image", mediaType: UploadMediaType.IMAGE };
  }
  if (type === "video" || mimeType?.startsWith("video/")) {
    return { kind: "video", mediaType: UploadMediaType.VIDEO };
  }
  return { kind: "file", mediaType: UploadMediaType.FILE };
}

export function attachmentFromMessageItem(params: {
  item: MessageItem;
  cdnBaseUrl: string;
  fetchFn?: WeixinFetch;
}): Attachment | null {
  // Prefer the server-side transcription when present: skip the audio download
  // entirely (mirrors @tencent-weixin/openclaw-weixin's `!voice_item.text` gate).
  if (params.item.type === MessageItemType.VOICE && params.item.voice_item?.text) {
    return null;
  }
  const media = getMedia(params.item);
  if (!media?.encrypt_query_param) return null;
  const key = getAesKey(params.item, media);
  const url = media.full_url ?? buildCdnDownloadUrl(media.encrypt_query_param, params.cdnBaseUrl);
  const base: Omit<Attachment, "type"> = {
    url,
    fetchMetadata: {
      encryptedQueryParam: media.encrypt_query_param,
      aesKey: key?.toString("base64") ?? "",
      cdnBaseUrl: params.cdnBaseUrl,
    },
    fetchData: async () => {
      const fetchFn = params.fetchFn ?? fetch;
      const res = await fetchFn(url);
      if (!res.ok) {
        throw new ValidationError("weixin", `CDN download failed with status ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return key ? decryptAesEcb(buf, key) : buf;
    },
  };

  if (params.item.type === MessageItemType.IMAGE) {
    return {
      ...base,
      type: "image",
      size: params.item.image_item?.hd_size ?? params.item.image_item?.mid_size,
      width: params.item.image_item?.thumb_width,
      height: params.item.image_item?.thumb_height,
      mimeType: "image/*",
      name: "image",
    };
  }
  if (params.item.type === MessageItemType.VIDEO) {
    return {
      ...base,
      type: "video",
      size: params.item.video_item?.video_size,
      width: params.item.video_item?.thumb_width,
      height: params.item.video_item?.thumb_height,
      mimeType: "video/mp4",
      name: "video.mp4",
    };
  }
  if (params.item.type === MessageItemType.VOICE) {
    return {
      ...base,
      type: "audio",
      mimeType: "audio/wav",
      name: "voice.wav",
      size: undefined,
      // Decrypt to SILK, then transcode to WAV via silk-wasm. If silk-wasm is
      // unavailable (optional dep) or decoding fails, fall back to raw SILK.
      fetchData: async () => {
        const silk = await base.fetchData!();
        const wav = await silkToWav(silk);
        return wav ?? silk;
      },
    };
  }
  if (params.item.type === MessageItemType.FILE) {
    const len = params.item.file_item?.len ? Number(params.item.file_item.len) : undefined;
    return {
      ...base,
      type: "file",
      name: params.item.file_item?.file_name ?? "file.bin",
      size: Number.isFinite(len) ? len : undefined,
      mimeType: "application/octet-stream",
    };
  }
  return null;
}

function getMedia(item: MessageItem): CDNMedia | undefined {
  return (
    item.image_item?.media ??
    item.video_item?.media ??
    item.file_item?.media ??
    item.voice_item?.media
  );
}

function getAesKey(item: MessageItem, media: CDNMedia): Buffer | undefined {
  const hex = item.image_item?.aeskey;
  if (hex && /^[a-f0-9]{32}$/i.test(hex)) return Buffer.from(hex, "hex");
  if (!media.aes_key) return undefined;
  return parseAesKey(media.aes_key);
}
