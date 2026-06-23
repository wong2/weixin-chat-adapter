// src/adapter.ts
import { extractFiles, extractPostableAttachments, ValidationError as ValidationError3 } from "@chat-adapter/shared";
import { ConsoleLogger, Message, NotImplementedError } from "chat";

// src/config.ts
import { AuthenticationError } from "@chat-adapter/shared";

// src/types.ts
var DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
var DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
var DEFAULT_BOT_TYPE = "3";
var DEFAULT_BOT_USERNAME = "weixin-bot";
var ADAPTER_NAME = "weixin";
var UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4
};
var MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2
};
var MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5
};
var MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2
};
var TypingStatus = {
  TYPING: 1,
  CANCEL: 2
};

// src/config.ts
var DEFAULT_LONG_POLL_TIMEOUT_MS = 35e3;
var DEFAULT_RETRY_DELAY_MS = 2e3;
var DEFAULT_BACKOFF_DELAY_MS = 3e4;
var DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
function firstNonEmpty(...values) {
  return values.find((value) => value != null && value.trim() !== "")?.trim();
}
function resolveConfig(config = {}) {
  const accountId = firstNonEmpty(config.accountId, process.env.WEIXIN_ACCOUNT_ID);
  const token = firstNonEmpty(config.token, process.env.WEIXIN_BOT_TOKEN);
  if (!accountId) {
    throw new AuthenticationError(
      "weixin",
      "accountId is required. Pass config.accountId or set WEIXIN_ACCOUNT_ID."
    );
  }
  if (!token) {
    throw new AuthenticationError(
      "weixin",
      "token is required. Pass config.token or set WEIXIN_BOT_TOKEN."
    );
  }
  return {
    accountId,
    token,
    baseUrl: firstNonEmpty(config.baseUrl, process.env.WEIXIN_BASE_URL) ?? DEFAULT_BASE_URL,
    cdnBaseUrl: firstNonEmpty(config.cdnBaseUrl, process.env.WEIXIN_CDN_BASE_URL) ?? DEFAULT_CDN_BASE_URL,
    userName: firstNonEmpty(config.userName, process.env.WEIXIN_BOT_USERNAME) ?? DEFAULT_BOT_USERNAME,
    botType: firstNonEmpty(config.botType, process.env.WEIXIN_BOT_TYPE) ?? DEFAULT_BOT_TYPE,
    routeTag: config.routeTag ?? process.env.WEIXIN_ROUTE_TAG,
    polling: {
      enabled: config.polling?.enabled ?? true,
      longPollTimeoutMs: config.polling?.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
      retryDelayMs: config.polling?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      backoffDelayMs: config.polling?.backoffDelayMs ?? DEFAULT_BACKOFF_DELAY_MS,
      maxConsecutiveFailures: config.polling?.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES
    },
    logger: config.logger
  };
}

// src/format-converter.ts
import {
  BaseFormatConverter,
  markdownToPlainText as sdkMarkdownToPlainText,
  parseMarkdown,
  stringifyMarkdown
} from "chat";
var WeixinFormatConverter = class extends BaseFormatConverter {
  toAst(platformText) {
    return parseMarkdown(platformText);
  }
  fromAst(ast) {
    return markdownToPlainText(stringifyMarkdown(ast));
  }
  renderPostable(message) {
    return markdownToPlainText(super.renderPostable(message));
  }
};
function markdownToPlainText(text) {
  return sdkMarkdownToPlainText(text).replace(/^\|[\s:|-]+\|$/gm, "").replace(
    /^\|(.+)\|$/gm,
    (_match, inner) => inner.split("|").map((cell) => cell.trim()).filter(Boolean).join("  ")
  ).trim();
}

// src/media.ts
import crypto, { createCipheriv, createDecipheriv } from "crypto";
import { ValidationError } from "@chat-adapter/shared";

// src/silk.ts
var SILK_SAMPLE_RATE = 24e3;
function pcmBytesToWav(pcm, sampleRate) {
  const pcmBytes = pcm.byteLength;
  const totalSize = 44 + pcmBytes;
  const buf = Buffer.allocUnsafe(totalSize);
  let offset = 0;
  buf.write("RIFF", offset);
  offset += 4;
  buf.writeUInt32LE(totalSize - 8, offset);
  offset += 4;
  buf.write("WAVE", offset);
  offset += 4;
  buf.write("fmt ", offset);
  offset += 4;
  buf.writeUInt32LE(16, offset);
  offset += 4;
  buf.writeUInt16LE(1, offset);
  offset += 2;
  buf.writeUInt16LE(1, offset);
  offset += 2;
  buf.writeUInt32LE(sampleRate, offset);
  offset += 4;
  buf.writeUInt32LE(sampleRate * 2, offset);
  offset += 4;
  buf.writeUInt16LE(2, offset);
  offset += 2;
  buf.writeUInt16LE(16, offset);
  offset += 2;
  buf.write("data", offset);
  offset += 4;
  buf.writeUInt32LE(pcmBytes, offset);
  offset += 4;
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, offset);
  return buf;
}
async function silkToWav(silkBuf) {
  try {
    const { decode } = await import("silk-wasm");
    const result = await decode(silkBuf, SILK_SAMPLE_RATE);
    return pcmBytesToWav(result.data, SILK_SAMPLE_RATE);
  } catch {
    return null;
  }
}

// src/media.ts
function encryptAesEcb(plaintext, key) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
function decryptAesEcb(ciphertext, key) {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) {
    return decoded;
  }
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new ValidationError(
    "weixin",
    `aes_key must decode to 16 raw bytes or a 32-char hex string, got ${decoded.length} bytes`
  );
}
async function fileUploadToBuffer(file) {
  if (Buffer.isBuffer(file.data)) return file.data;
  if (file.data instanceof ArrayBuffer) return Buffer.from(file.data);
  if (typeof Blob !== "undefined" && file.data instanceof Blob) {
    return Buffer.from(await file.data.arrayBuffer());
  }
  throw new ValidationError("weixin", `Unsupported file data for ${file.filename}`);
}
async function attachmentToBuffer(attachment, fetchFn = fetch) {
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
        `Failed to fetch remote attachment ${attachment.url}: ${res.status}`
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }
  throw new ValidationError("weixin", `Attachment ${attachment.name ?? ""} has no uploadable data`);
}
async function uploadBufferToWeixin(params) {
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
    aeskey: aeskey.toString("hex")
  });
  const downloadEncryptedQueryParam = await uploadCiphertextToCdn({
    fetchFn: params.fetchFn,
    cdnBaseUrl: params.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL,
    uploadUrl,
    filekey,
    ciphertext
  });
  return {
    filekey,
    downloadEncryptedQueryParam,
    aeskey: aeskey.toString("hex"),
    fileSize: params.buffer.length,
    fileSizeCiphertext: ciphertext.length
  };
}
async function uploadCiphertextToCdn(params) {
  const url = params.uploadUrl.upload_full_url?.trim() || (params.uploadUrl.upload_param ? buildCdnUploadUrl(params.cdnBaseUrl, params.uploadUrl.upload_param, params.filekey) : void 0);
  if (!url) {
    throw new ValidationError("weixin", "getUploadUrl returned no upload URL or upload_param");
  }
  const fetchFn = params.fetchFn ?? fetch;
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(params.ciphertext)
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
function buildCdnUploadUrl(cdnBaseUrl, uploadParam, filekey) {
  return `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(
    uploadParam
  )}&filekey=${encodeURIComponent(filekey)}`;
}
function buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl) {
  return `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}
function uploadedToMessageItem(params) {
  const aesKeyForKind = params.kind === "image" ? Buffer.from(params.uploaded.aeskey, "hex").toString("base64") : Buffer.from(params.uploaded.aeskey, "ascii").toString("base64");
  const media = {
    encrypt_query_param: params.uploaded.downloadEncryptedQueryParam,
    aes_key: aesKeyForKind,
    encrypt_type: 1
  };
  if (params.kind === "image") {
    return {
      type: MessageItemType.IMAGE,
      image_item: {
        media,
        mid_size: params.uploaded.fileSizeCiphertext
      }
    };
  }
  if (params.kind === "video") {
    return {
      type: MessageItemType.VIDEO,
      video_item: {
        media,
        video_size: params.uploaded.fileSizeCiphertext
      }
    };
  }
  return {
    type: MessageItemType.FILE,
    file_item: {
      media,
      file_name: params.fileName ?? "file.bin",
      len: String(params.uploaded.fileSize)
    }
  };
}
function inferUploadKind(mimeType, type) {
  if (type === "image" || mimeType?.startsWith("image/")) {
    return { kind: "image", mediaType: UploadMediaType.IMAGE };
  }
  if (type === "video" || mimeType?.startsWith("video/")) {
    return { kind: "video", mediaType: UploadMediaType.VIDEO };
  }
  return { kind: "file", mediaType: UploadMediaType.FILE };
}
function attachmentFromMessageItem(params) {
  if (params.item.type === MessageItemType.VOICE && params.item.voice_item?.text) {
    return null;
  }
  const media = getMedia(params.item);
  if (!media?.encrypt_query_param) return null;
  const key = getAesKey(params.item, media);
  const url = media.full_url ?? buildCdnDownloadUrl(media.encrypt_query_param, params.cdnBaseUrl);
  const base = {
    url,
    fetchMetadata: {
      encryptedQueryParam: media.encrypt_query_param,
      aesKey: key?.toString("base64") ?? "",
      cdnBaseUrl: params.cdnBaseUrl
    },
    fetchData: async () => {
      const fetchFn = params.fetchFn ?? fetch;
      const res = await fetchFn(url);
      if (!res.ok) {
        throw new ValidationError("weixin", `CDN download failed with status ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return key ? decryptAesEcb(buf, key) : buf;
    }
  };
  if (params.item.type === MessageItemType.IMAGE) {
    return {
      ...base,
      type: "image",
      size: params.item.image_item?.hd_size ?? params.item.image_item?.mid_size,
      width: params.item.image_item?.thumb_width,
      height: params.item.image_item?.thumb_height,
      mimeType: "image/*",
      name: "image"
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
      name: "video.mp4"
    };
  }
  if (params.item.type === MessageItemType.VOICE) {
    return {
      ...base,
      type: "audio",
      mimeType: "audio/wav",
      name: "voice.wav",
      size: void 0,
      // Decrypt to SILK, then transcode to WAV via silk-wasm. If silk-wasm is
      // unavailable (optional dep) or decoding fails, fall back to raw SILK.
      fetchData: async () => {
        const silk = await base.fetchData();
        const wav = await silkToWav(silk);
        return wav ?? silk;
      }
    };
  }
  if (params.item.type === MessageItemType.FILE) {
    const len = params.item.file_item?.len ? Number(params.item.file_item.len) : void 0;
    return {
      ...base,
      type: "file",
      name: params.item.file_item?.file_name ?? "file.bin",
      size: Number.isFinite(len) ? len : void 0,
      mimeType: "application/octet-stream"
    };
  }
  return null;
}
function getMedia(item) {
  return item.image_item?.media ?? item.video_item?.media ?? item.file_item?.media ?? item.voice_item?.media;
}
function getAesKey(item, media) {
  const hex = item.image_item?.aeskey;
  if (hex && /^[a-f0-9]{32}$/i.test(hex)) return Buffer.from(hex, "hex");
  if (!media.aes_key) return void 0;
  return parseAesKey(media.aes_key);
}

// src/message-utils.ts
import crypto2 from "crypto";
function buildMessageId(msg) {
  if (msg.message_id != null) return String(msg.message_id);
  if (msg.client_id) return msg.client_id;
  if (msg.seq != null) return `seq:${msg.seq}`;
  const stable = JSON.stringify({
    from: msg.from_user_id,
    to: msg.to_user_id,
    ts: msg.create_time_ms,
    items: msg.item_list
  });
  return `weixin:${crypto2.createHash("sha1").update(stable).digest("hex").slice(0, 20)}`;
}
function getMessageUserId(msg) {
  if (msg.message_type === MessageType.BOT) {
    return msg.to_user_id || msg.from_user_id || "unknown";
  }
  return msg.from_user_id || msg.to_user_id || "unknown";
}
function isBotMessage(msg) {
  return msg.message_type === MessageType.BOT;
}
function bodyFromItemList(itemList) {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      const parts = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      return parts.length ? `[\u5F15\u7528: ${parts.join(" | ")}]
${text}` : text;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}
function isMediaItem(item) {
  return item.type === MessageItemType.IMAGE || item.type === MessageItemType.VIDEO || item.type === MessageItemType.FILE || item.type === MessageItemType.VOICE;
}
function createClientId(prefix = "chat-adapter-weixin") {
  return `${prefix}-${crypto2.randomUUID()}`;
}

// src/protocol.ts
import crypto3 from "crypto";
import { NetworkError } from "@chat-adapter/shared";
var DEFAULT_API_TIMEOUT_MS = 15e3;
var DEFAULT_CONFIG_TIMEOUT_MS = 1e4;
var DEFAULT_QR_TIMEOUT_MS = 35e3;
var ILINK_APP_ID = "bot";
var ILINK_CLIENT_VERSION = "1";
function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}
function randomWechatUin() {
  const uint32 = crypto3.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}
function buildBaseInfo(channelVersion = "0.1.0") {
  return { channel_version: channelVersion };
}
async function fetchWithTimeout(fetchFn, input, init, timeoutMs, signal) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener("abort", abortFromParent, { once: true });
  }
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromParent);
  }
}
var WeixinProtocolClient = class {
  baseUrl;
  token;
  routeTag;
  fetchFn;
  channelVersion;
  constructor(options) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.routeTag = options.routeTag;
    this.fetchFn = options.fetchFn ?? fetch;
    this.channelVersion = options.channelVersion ?? "0.1.0";
  }
  async getUpdates(params) {
    try {
      return await this.postJson(
        "ilink/bot/getupdates",
        {
          get_updates_buf: params.getUpdatesBuf ?? "",
          base_info: buildBaseInfo(this.channelVersion)
        },
        params.timeoutMs ?? 35e3,
        params.signal
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf };
      }
      throw error;
    }
  }
  async sendMessage(body, options = {}) {
    const resp = await this.postJson(
      "ilink/bot/sendmessage",
      { ...body, base_info: buildBaseInfo(this.channelVersion) },
      options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS
    );
    ensureWeixinOk(resp, "sendMessage");
  }
  async getUploadUrl(body, options = {}) {
    const resp = await this.postJson(
      "ilink/bot/getuploadurl",
      { ...body, base_info: buildBaseInfo(this.channelVersion) },
      options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS
    );
    ensureWeixinOk(resp, "getUploadUrl");
    return resp;
  }
  async getConfig(params, options = {}) {
    const resp = await this.postJson(
      "ilink/bot/getconfig",
      {
        ilink_user_id: params.ilinkUserId,
        context_token: params.contextToken,
        base_info: buildBaseInfo(this.channelVersion)
      },
      options.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS
    );
    ensureWeixinOk(resp, "getConfig");
    return resp;
  }
  async sendTyping(body, options = {}) {
    const resp = await this.postJson(
      "ilink/bot/sendtyping",
      { ...body, base_info: buildBaseInfo(this.channelVersion) },
      options.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS
    );
    ensureWeixinOk(resp, "sendTyping");
    return resp;
  }
  async fetchQRCode(botType = DEFAULT_BOT_TYPE) {
    return await this.getJson(
      `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`,
      5e3
    );
  }
  async pollQRStatus(qrcode) {
    try {
      return await this.getJson(
        `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
        DEFAULT_QR_TIMEOUT_MS
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return { status: "wait" };
      }
      return { status: "wait" };
    }
  }
  async postJson(endpoint, body, timeoutMs, signal) {
    const bodyText = JSON.stringify(body);
    const res = await fetchWithTimeout(
      this.fetchFn,
      new URL(endpoint, ensureTrailingSlash(this.baseUrl)).toString(),
      {
        method: "POST",
        headers: this.buildPostHeaders(bodyText),
        body: bodyText
      },
      timeoutMs,
      signal
    );
    return await parseJsonResponse(res, endpoint);
  }
  async getJson(endpoint, timeoutMs) {
    const res = await fetchWithTimeout(
      this.fetchFn,
      new URL(endpoint, ensureTrailingSlash(this.baseUrl)).toString(),
      {
        method: "GET",
        headers: this.buildCommonHeaders()
      },
      timeoutMs
    );
    return await parseJsonResponse(res, endpoint);
  }
  buildCommonHeaders() {
    const headers = {
      "iLink-App-Id": ILINK_APP_ID,
      "iLink-App-ClientVersion": ILINK_CLIENT_VERSION
    };
    if (this.routeTag != null && String(this.routeTag).trim() !== "") {
      headers.SKRouteTag = String(this.routeTag);
    }
    return headers;
  }
  buildPostHeaders(body) {
    const headers = {
      ...this.buildCommonHeaders(),
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body, "utf-8")),
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomWechatUin()
    };
    if (this.token?.trim()) {
      headers.Authorization = `Bearer ${this.token.trim()}`;
    }
    return headers;
  }
};
function ensureWeixinOk(resp, label) {
  const failed = resp.ret !== void 0 && resp.ret !== 0 || resp.errcode !== void 0 && resp.errcode !== 0;
  if (failed) {
    throw new NetworkError(
      "weixin",
      `${label} failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`
    );
  }
}
function createQrProtocolClient(fetchFn) {
  return new WeixinProtocolClient({ baseUrl: DEFAULT_BASE_URL, fetchFn });
}
async function parseJsonResponse(res, label) {
  const rawText = await res.text();
  if (!res.ok) {
    throw new NetworkError("weixin", `${label} failed with ${res.status}: ${rawText}`);
  }
  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw new NetworkError(
      "weixin",
      `${label} returned invalid JSON`,
      error instanceof Error ? error : void 0
    );
  }
}

// src/state.ts
var CONTEXT_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var GET_UPDATES_BUF_TTL_MS = 30 * 24 * 60 * 60 * 1e3;
var SENT_CLIENT_ID_TTL_MS = 10 * 60 * 1e3;
var WeixinRuntimeState = class {
  constructor(state, accountId) {
    this.state = state;
    this.accountId = accountId;
  }
  state;
  accountId;
  async getUpdatesBuf() {
    return await this.state.get(this.getUpdatesBufKey()) ?? "";
  }
  async setUpdatesBuf(value) {
    await this.state.set(this.getUpdatesBufKey(), value, GET_UPDATES_BUF_TTL_MS);
  }
  async setContextToken(userId, token) {
    if (!userId || !token) return;
    await this.state.set(this.contextTokenKey(userId), token, CONTEXT_TOKEN_TTL_MS);
  }
  async getContextToken(userId) {
    return await this.state.get(this.contextTokenKey(userId)) ?? void 0;
  }
  async markSentClientId(clientId) {
    await this.state.set(this.sentClientIdKey(clientId), true, SENT_CLIENT_ID_TTL_MS);
  }
  async isSentClientId(clientId) {
    if (!clientId) return false;
    return Boolean(await this.state.get(this.sentClientIdKey(clientId)));
  }
  enrichMessage(raw, isMe) {
    return { ...raw, __isMe: isMe };
  }
  getUpdatesBufKey() {
    return `weixin:${this.accountId}:get_updates_buf`;
  }
  contextTokenKey(userId) {
    return `weixin:${this.accountId}:${userId}:context_token`;
  }
  sentClientIdKey(clientId) {
    return `weixin:${this.accountId}:sent_client_id:${clientId}`;
  }
};

// src/thread-id.ts
import { ValidationError as ValidationError2 } from "@chat-adapter/shared";
function encodeSegment(value) {
  return Buffer.from(value, "utf-8").toString("base64url");
}
function decodeSegment(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ValidationError2("weixin", `Invalid base64url segment: ${value}`);
  }
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf-8");
    if (!decoded || encodeSegment(decoded) !== value) {
      throw new Error("non-canonical base64url segment");
    }
    return decoded;
  } catch {
    throw new ValidationError2("weixin", `Invalid base64url segment: ${value}`);
  }
}
function encodeThreadId(data) {
  if (!data.accountId || !data.userId) {
    throw new ValidationError2("weixin", "accountId and userId are required for thread IDs");
  }
  return `${ADAPTER_NAME}:${encodeSegment(data.accountId)}:${encodeSegment(data.userId)}`;
}
function decodeThreadId(threadId) {
  const parts = threadId.split(":");
  if (parts.length !== 3 || parts[0] !== ADAPTER_NAME || !parts[1] || !parts[2]) {
    throw new ValidationError2("weixin", `Invalid Weixin thread ID: ${threadId}`);
  }
  return {
    accountId: decodeSegment(parts[1]),
    userId: decodeSegment(parts[2])
  };
}
function channelIdFromThreadId(threadId) {
  const { accountId } = decodeThreadId(threadId);
  return `${ADAPTER_NAME}:${encodeSegment(accountId)}`;
}

// src/adapter.ts
var WeixinAdapter = class {
  name = ADAPTER_NAME;
  userName;
  persistThreadHistory = true;
  config;
  converter = new WeixinFormatConverter();
  protocol;
  fetchFn;
  chat = null;
  state = null;
  logger;
  abortController = null;
  pollPromise = null;
  nextPollTimeoutMs;
  constructor(config = {}) {
    this.config = resolveConfig(config);
    this.userName = this.config.userName;
    this.logger = this.config.logger ?? new ConsoleLogger("info", ADAPTER_NAME);
    this.fetchFn = config.fetchFn;
    this.protocol = config.protocolClient ?? new WeixinProtocolClient({
      baseUrl: this.config.baseUrl,
      token: this.config.token,
      routeTag: this.config.routeTag,
      fetchFn: this.fetchFn
    });
    this.nextPollTimeoutMs = this.config.polling.longPollTimeoutMs;
  }
  async initialize(chat) {
    this.chat = chat;
    this.logger = chat.getLogger(ADAPTER_NAME);
    this.state = new WeixinRuntimeState(chat.getState(), this.config.accountId);
    if (this.config.polling.enabled) {
      this.abortController = new AbortController();
      this.pollPromise = this.pollLoop(this.abortController.signal).catch((error) => {
        if (!this.abortController?.signal.aborted) {
          this.logger.error("Weixin polling stopped unexpectedly", error);
        }
      });
    }
  }
  async disconnect() {
    this.abortController?.abort();
    if (this.pollPromise) {
      await this.pollPromise.catch(() => void 0);
    }
    this.abortController = null;
    this.pollPromise = null;
  }
  encodeThreadId(data) {
    return encodeThreadId(data);
  }
  decodeThreadId(threadId) {
    return decodeThreadId(threadId);
  }
  channelIdFromThreadId(threadId) {
    return channelIdFromThreadId(threadId);
  }
  async handleWebhook(_request, _options) {
    return Response.json(
      { error: "weixin adapter uses long-poll transport; webhook not supported" },
      { status: 501 }
    );
  }
  parseMessage(raw) {
    const enriched = raw;
    const userId = getMessageUserId(raw);
    const threadId = encodeThreadId({ accountId: this.config.accountId, userId });
    const text = bodyFromItemList(raw.item_list);
    const isMe = Boolean(enriched.__isMe);
    const isBot = isMe || isBotMessage(raw);
    const authorUserId = isBot ? raw.from_user_id || this.config.accountId : userId;
    return new Message({
      id: buildMessageId(raw),
      threadId,
      text,
      formatted: this.converter.toAst(text),
      raw,
      author: {
        userId: authorUserId,
        userName: authorUserId,
        fullName: authorUserId,
        isBot,
        isMe
      },
      metadata: {
        dateSent: new Date(raw.create_time_ms ?? Date.now()),
        edited: false
      },
      attachments: this.attachmentsFromMessage(raw)
    });
  }
  renderFormatted(content) {
    return this.converter.fromAst(content);
  }
  async postMessage(threadId, message) {
    this.assertInitialized();
    const { accountId, userId } = decodeThreadId(threadId);
    if (accountId !== this.config.accountId) {
      throw new ValidationError3(
        "weixin",
        `Thread accountId ${accountId} does not match adapter accountId ${this.config.accountId}`
      );
    }
    const contextToken = await this.state.getContextToken(userId);
    const text = this.converter.renderPostable(message);
    const files = extractFiles(message);
    const attachments = extractPostableAttachments(message);
    let lastRaw = null;
    if (files.length === 0 && attachments.length === 0) {
      if (!text) throw new ValidationError3("weixin", "Cannot send an empty Weixin message");
      lastRaw = await this.sendItems(userId, [{ type: MessageItemType.TEXT, text_item: { text } }], contextToken);
      return { id: buildMessageId(lastRaw), threadId, raw: lastRaw };
    }
    if (text) {
      lastRaw = await this.sendItems(userId, [{ type: MessageItemType.TEXT, text_item: { text } }], contextToken);
    }
    for (const file of files) {
      const item = await this.fileUploadToMessageItem(userId, file);
      lastRaw = await this.sendItems(userId, [item], contextToken);
    }
    for (const attachment of attachments) {
      const item = await this.attachmentToMessageItem(userId, attachment);
      lastRaw = await this.sendItems(userId, [item], contextToken);
    }
    if (!lastRaw) {
      throw new ValidationError3("weixin", "Cannot send an empty Weixin message");
    }
    return { id: buildMessageId(lastRaw), threadId, raw: lastRaw };
  }
  async editMessage(_threadId, _messageId, _message) {
    throw new NotImplementedError("Weixin does not support editing messages in v1", "editMessage");
  }
  async deleteMessage(_threadId, _messageId) {
    throw new NotImplementedError("Weixin does not support deleting messages in v1", "deleteMessage");
  }
  async addReaction(_threadId, _messageId, _emoji) {
    throw new NotImplementedError("Weixin reactions are not supported in v1", "addReaction");
  }
  async removeReaction(_threadId, _messageId, _emoji) {
    throw new NotImplementedError("Weixin reactions are not supported in v1", "removeReaction");
  }
  async fetchMessages(_threadId, _options) {
    return { messages: [] };
  }
  async fetchThread(threadId) {
    const { accountId, userId } = decodeThreadId(threadId);
    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      channelName: userId,
      isDM: true,
      metadata: { accountId, userId }
    };
  }
  async openDM(userId) {
    return encodeThreadId({ accountId: this.config.accountId, userId });
  }
  isDM(threadId) {
    decodeThreadId(threadId);
    return true;
  }
  async startTyping(threadId, _status) {
    this.assertInitialized();
    const { userId } = decodeThreadId(threadId);
    const contextToken = await this.state.getContextToken(userId);
    if (!contextToken) return;
    const config = await this.protocol.getConfig({ ilinkUserId: userId, contextToken });
    if (!config.typing_ticket) return;
    await this.protocol.sendTyping({
      ilink_user_id: userId,
      typing_ticket: config.typing_ticket,
      status: TypingStatus.TYPING
    });
  }
  async pollLoop(signal) {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        await this.pollOnce(signal);
        consecutiveFailures = 0;
      } catch (error) {
        if (signal.aborted) return;
        consecutiveFailures += 1;
        this.logger.error(
          `Weixin getUpdates error (${consecutiveFailures}/${this.config.polling.maxConsecutiveFailures})`,
          error
        );
        const delay = consecutiveFailures >= this.config.polling.maxConsecutiveFailures ? this.config.polling.backoffDelayMs : this.config.polling.retryDelayMs;
        if (consecutiveFailures >= this.config.polling.maxConsecutiveFailures) {
          consecutiveFailures = 0;
        }
        await sleep(delay, signal);
      }
    }
  }
  async pollOnce(signal) {
    this.assertInitialized();
    const getUpdatesBuf = await this.state.getUpdatesBuf();
    const resp = await this.protocol.getUpdates({
      getUpdatesBuf,
      timeoutMs: this.nextPollTimeoutMs,
      signal
    });
    if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
      this.nextPollTimeoutMs = resp.longpolling_timeout_ms;
    }
    const isApiError = resp.ret !== void 0 && resp.ret !== 0 || resp.errcode !== void 0 && resp.errcode !== 0;
    if (isApiError) {
      throw new Error(
        `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`
      );
    }
    for (const raw of resp.msgs ?? []) {
      await this.processInbound(raw);
    }
    if (resp.get_updates_buf) {
      await this.state.setUpdatesBuf(resp.get_updates_buf);
    }
  }
  async processInbound(raw) {
    if (!this.chat || !this.state) return;
    const userId = getMessageUserId(raw);
    if (raw.context_token) {
      await this.state.setContextToken(userId, raw.context_token);
    }
    const isMe = isBotMessage(raw) || await this.state.isSentClientId(raw.client_id);
    const enriched = this.state.enrichMessage(raw, isMe);
    const threadId = encodeThreadId({ accountId: this.config.accountId, userId });
    await this.chat.processMessage(this, threadId, () => Promise.resolve(this.parseMessage(enriched)));
  }
  async sendItems(toUserId, itemList, contextToken) {
    const clientId = createClientId();
    const raw = {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: itemList,
      context_token: contextToken,
      create_time_ms: Date.now()
    };
    await this.state.markSentClientId(clientId);
    await this.protocol.sendMessage({ msg: raw });
    return raw;
  }
  async fileUploadToMessageItem(userId, file) {
    const buffer = await fileUploadToBuffer(file);
    const inferred = inferUploadKind(file.mimeType);
    const uploaded = await uploadBufferToWeixin({
      protocol: this.protocol,
      fetchFn: this.fetchFn,
      cdnBaseUrl: this.config.cdnBaseUrl,
      toUserId: userId,
      buffer,
      mediaType: inferred.mediaType
    });
    return uploadedToMessageItem({
      uploaded,
      kind: inferred.kind,
      fileName: file.filename
    });
  }
  async attachmentToMessageItem(userId, attachment) {
    const buffer = await attachmentToBuffer(attachment, this.fetchFn);
    const inferred = inferUploadKind(attachment.mimeType, attachment.type);
    const uploaded = await uploadBufferToWeixin({
      protocol: this.protocol,
      fetchFn: this.fetchFn,
      cdnBaseUrl: this.config.cdnBaseUrl,
      toUserId: userId,
      buffer,
      mediaType: inferred.mediaType
    });
    return uploadedToMessageItem({
      uploaded,
      kind: inferred.kind,
      fileName: attachment.name
    });
  }
  attachmentsFromMessage(raw) {
    return (raw.item_list ?? []).map(
      (item) => attachmentFromMessageItem({
        item,
        cdnBaseUrl: this.config.cdnBaseUrl,
        fetchFn: this.fetchFn
      })
    ).filter((attachment) => attachment != null);
  }
  rehydrateAttachment(attachment) {
    const metadata = attachment.fetchMetadata;
    const encryptedQueryParam = metadata?.encryptedQueryParam;
    if (!encryptedQueryParam) return attachment;
    const cdnBaseUrl = metadata?.cdnBaseUrl || this.config.cdnBaseUrl;
    const url = attachment.url || buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
    const aesKey = metadata?.aesKey ? Buffer.from(metadata.aesKey, "base64") : void 0;
    return {
      ...attachment,
      url,
      fetchData: async () => {
        const fetchFn = this.fetchFn ?? fetch;
        const res = await fetchFn(url);
        if (!res.ok) {
          throw new ValidationError3("weixin", `CDN download failed with status ${res.status}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const decrypted = aesKey && aesKey.length > 0 ? decryptAesEcb(buf, aesKey) : buf;
        if (attachment.type === "audio") {
          return await silkToWav(decrypted) ?? decrypted;
        }
        return decrypted;
      }
    };
  }
  assertInitialized() {
    if (!this.chat || !this.state) {
      throw new Error("WeixinAdapter is not initialized");
    }
  }
};
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

// src/factory.ts
function createWeixinAdapter(config) {
  return new WeixinAdapter(config);
}

// src/login.ts
var MAX_QR_REFRESH_COUNT = 3;
async function startWeixinLogin(options = {}) {
  let client = createQrProtocolClient(options.fetchFn);
  let activeBaseUrl = DEFAULT_BASE_URL;
  let qrcode = await client.fetchQRCode(options.botType ?? DEFAULT_BOT_TYPE);
  await options.onQRCode?.(qrcode.qrcode_img_content);
  const deadline = Date.now() + Math.max(options.timeoutMs ?? 48e4, 1e3);
  let refreshCount = 1;
  while (Date.now() < deadline) {
    const status = await client.pollQRStatus(qrcode.qrcode);
    if (options.verbose) process.stderr.write(".");
    if (status.status === "scaned_but_redirect" && status.redirect_host) {
      activeBaseUrl = `https://${status.redirect_host}`;
      client = new WeixinProtocolClient({ baseUrl: activeBaseUrl, fetchFn: options.fetchFn });
      continue;
    }
    if (status.status === "expired") {
      refreshCount += 1;
      if (refreshCount > MAX_QR_REFRESH_COUNT) {
        throw new Error("Weixin QR login timed out: QR code expired too many times");
      }
      client = createQrProtocolClient(options.fetchFn);
      activeBaseUrl = DEFAULT_BASE_URL;
      qrcode = await client.fetchQRCode(options.botType ?? DEFAULT_BOT_TYPE);
      await options.onQRCode?.(qrcode.qrcode_img_content);
      continue;
    }
    if (status.status === "confirmed") {
      if (!status.ilink_bot_id || !status.bot_token) {
        throw new Error("Weixin QR login confirmed without accountId or token");
      }
      return {
        accountId: status.ilink_bot_id,
        token: status.bot_token,
        baseUrl: status.baseurl || activeBaseUrl,
        userId: status.ilink_user_id
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 1e3));
  }
  throw new Error("Weixin QR login timed out");
}
export {
  WeixinAdapter,
  WeixinFormatConverter,
  WeixinProtocolClient,
  channelIdFromThreadId,
  createWeixinAdapter,
  decodeThreadId,
  encodeThreadId,
  markdownToPlainText,
  startWeixinLogin
};
//# sourceMappingURL=index.js.map