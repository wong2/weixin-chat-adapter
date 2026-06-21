import { extractFiles, extractPostableAttachments, ValidationError } from "@chat-adapter/shared";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  RawMessage,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import { ConsoleLogger, Message, NotImplementedError } from "chat";
import { resolveConfig } from "./config.js";
import { WeixinFormatConverter } from "./format-converter.js";
import {
  attachmentFromMessageItem,
  attachmentToBuffer,
  buildCdnDownloadUrl,
  decryptAesEcb,
  fileUploadToBuffer,
  inferUploadKind,
  uploadedToMessageItem,
  uploadBufferToWeixin,
} from "./media.js";
import { silkToWav } from "./silk.js";
import {
  bodyFromItemList,
  buildMessageId,
  createClientId,
  getMessageUserId,
  isBotMessage,
} from "./message-utils.js";
import { WeixinProtocolClient } from "./protocol.js";
import { WeixinRuntimeState } from "./state.js";
import {
  ADAPTER_NAME,
  MessageItemType,
  MessageState,
  MessageType,
  TypingStatus,
  type EnrichedWeixinMessage,
  type MessageItem,
  type ResolvedWeixinAdapterConfig,
  type WeixinAdapterConfig,
  type WeixinFetch,
  type WeixinMessage,
  type WeixinThreadId,
} from "./types.js";
import { channelIdFromThreadId, decodeThreadId, encodeThreadId } from "./thread-id.js";

type InternalConfig = WeixinAdapterConfig & {
  protocolClient?: WeixinProtocolClient;
  fetchFn?: WeixinFetch;
};

export class WeixinAdapter implements Adapter<WeixinThreadId, WeixinMessage> {
  readonly name = ADAPTER_NAME;
  readonly userName: string;
  readonly persistThreadHistory = true;

  private readonly config: ResolvedWeixinAdapterConfig;
  private readonly converter = new WeixinFormatConverter();
  private readonly protocol: WeixinProtocolClient;
  private readonly fetchFn?: WeixinFetch;
  private chat: ChatInstance | null = null;
  private state: WeixinRuntimeState | null = null;
  private logger: Logger;
  private abortController: AbortController | null = null;
  private pollPromise: Promise<void> | null = null;
  private nextPollTimeoutMs: number;

  constructor(config: InternalConfig = {}) {
    this.config = resolveConfig(config);
    this.userName = this.config.userName;
    this.logger = this.config.logger ?? new ConsoleLogger("info", ADAPTER_NAME);
    this.fetchFn = config.fetchFn;
    this.protocol =
      config.protocolClient ??
      new WeixinProtocolClient({
        baseUrl: this.config.baseUrl,
        token: this.config.token,
        routeTag: this.config.routeTag,
        fetchFn: this.fetchFn,
      });
    this.nextPollTimeoutMs = this.config.polling.longPollTimeoutMs;
  }

  async initialize(chat: ChatInstance): Promise<void> {
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

  async disconnect(): Promise<void> {
    this.abortController?.abort();
    if (this.pollPromise) {
      await this.pollPromise.catch(() => undefined);
    }
    this.abortController = null;
    this.pollPromise = null;
  }

  encodeThreadId(data: WeixinThreadId): string {
    return encodeThreadId(data);
  }

  decodeThreadId(threadId: string): WeixinThreadId {
    return decodeThreadId(threadId);
  }

  channelIdFromThreadId(threadId: string): string {
    return channelIdFromThreadId(threadId);
  }

  async handleWebhook(_request: Request, _options?: WebhookOptions): Promise<Response> {
    return Response.json(
      { error: "weixin adapter uses long-poll transport; webhook not supported" },
      { status: 501 },
    );
  }

  parseMessage(raw: WeixinMessage): Message<WeixinMessage> {
    const enriched = raw as EnrichedWeixinMessage;
    const userId = getMessageUserId(raw);
    const threadId = encodeThreadId({ accountId: this.config.accountId, userId });
    const text = bodyFromItemList(raw.item_list);
    const isMe = Boolean(enriched.__isMe);
    const isBot = isMe || isBotMessage(raw);
    const authorUserId = isBot ? raw.from_user_id || this.config.accountId : userId;

    return new Message<WeixinMessage>({
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
        isMe,
      },
      metadata: {
        dateSent: new Date(raw.create_time_ms ?? Date.now()),
        edited: false,
      },
      attachments: this.attachmentsFromMessage(raw),
    });
  }

  renderFormatted(content: FormattedContent): string {
    return this.converter.fromAst(content);
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<WeixinMessage>> {
    this.assertInitialized();
    const { accountId, userId } = decodeThreadId(threadId);
    if (accountId !== this.config.accountId) {
      throw new ValidationError(
        "weixin",
        `Thread accountId ${accountId} does not match adapter accountId ${this.config.accountId}`,
      );
    }

    const contextToken = await this.state!.getContextToken(userId);
    const text = this.converter.renderPostable(message);
    const files = extractFiles(message);
    const attachments = extractPostableAttachments(message);
    let lastRaw: WeixinMessage | null = null;

    if (files.length === 0 && attachments.length === 0) {
      if (!text) throw new ValidationError("weixin", "Cannot send an empty Weixin message");
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
      throw new ValidationError("weixin", "Cannot send an empty Weixin message");
    }
    return { id: buildMessageId(lastRaw), threadId, raw: lastRaw };
  }

  async editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<WeixinMessage>> {
    throw new NotImplementedError("Weixin does not support editing messages in v1", "editMessage");
  }

  async deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    throw new NotImplementedError("Weixin does not support deleting messages in v1", "deleteMessage");
  }

  async addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new NotImplementedError("Weixin reactions are not supported in v1", "addReaction");
  }

  async removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    throw new NotImplementedError("Weixin reactions are not supported in v1", "removeReaction");
  }

  async fetchMessages(
    _threadId: string,
    _options?: FetchOptions,
  ): Promise<FetchResult<WeixinMessage>> {
    return { messages: [] };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { accountId, userId } = decodeThreadId(threadId);
    return {
      id: threadId,
      channelId: this.channelIdFromThreadId(threadId),
      channelName: userId,
      isDM: true,
      metadata: { accountId, userId },
    };
  }

  async openDM(userId: string): Promise<string> {
    return encodeThreadId({ accountId: this.config.accountId, userId });
  }

  isDM(threadId: string): boolean {
    decodeThreadId(threadId);
    return true;
  }

  async startTyping(threadId: string, _status?: string): Promise<void> {
    this.assertInitialized();
    const { userId } = decodeThreadId(threadId);
    const contextToken = await this.state!.getContextToken(userId);
    if (!contextToken) return;
    const config = await this.protocol.getConfig({ ilinkUserId: userId, contextToken });
    if (!config.typing_ticket) return;
    await this.protocol.sendTyping({
      ilink_user_id: userId,
      typing_ticket: config.typing_ticket,
      status: TypingStatus.TYPING,
    });
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
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
          error,
        );
        const delay =
          consecutiveFailures >= this.config.polling.maxConsecutiveFailures
            ? this.config.polling.backoffDelayMs
            : this.config.polling.retryDelayMs;
        if (consecutiveFailures >= this.config.polling.maxConsecutiveFailures) {
          consecutiveFailures = 0;
        }
        await sleep(delay, signal);
      }
    }
  }

  async pollOnce(signal?: AbortSignal): Promise<void> {
    this.assertInitialized();
    const getUpdatesBuf = await this.state!.getUpdatesBuf();
    const resp = await this.protocol.getUpdates({
      getUpdatesBuf,
      timeoutMs: this.nextPollTimeoutMs,
      signal,
    });
    if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
      this.nextPollTimeoutMs = resp.longpolling_timeout_ms;
    }
    const isApiError =
      (resp.ret !== undefined && resp.ret !== 0) ||
      (resp.errcode !== undefined && resp.errcode !== 0);
    if (isApiError) {
      throw new Error(
        `getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""}`,
      );
    }
    for (const raw of resp.msgs ?? []) {
      await this.processInbound(raw);
    }
    if (resp.get_updates_buf) {
      await this.state!.setUpdatesBuf(resp.get_updates_buf);
    }
  }

  private async processInbound(raw: WeixinMessage): Promise<void> {
    if (!this.chat || !this.state) return;
    const userId = getMessageUserId(raw);
    if (raw.context_token) {
      await this.state.setContextToken(userId, raw.context_token);
    }
    const isMe = isBotMessage(raw) || (await this.state.isSentClientId(raw.client_id));
    const enriched = this.state.enrichMessage(raw, isMe);
    const threadId = encodeThreadId({ accountId: this.config.accountId, userId });
    await this.chat.processMessage(this, threadId, () => Promise.resolve(this.parseMessage(enriched)));
  }

  private async sendItems(
    toUserId: string,
    itemList: MessageItem[],
    contextToken?: string,
  ): Promise<WeixinMessage> {
    const clientId = createClientId();
    const raw: WeixinMessage = {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: itemList,
      context_token: contextToken,
      create_time_ms: Date.now(),
    };
    await this.state!.markSentClientId(clientId);
    await this.protocol.sendMessage({ msg: raw });
    return raw;
  }

  private async fileUploadToMessageItem(userId: string, file: {
    data: Buffer | Blob | ArrayBuffer;
    filename: string;
    mimeType?: string;
  }): Promise<MessageItem> {
    const buffer = await fileUploadToBuffer(file);
    const inferred = inferUploadKind(file.mimeType);
    const uploaded = await uploadBufferToWeixin({
      protocol: this.protocol,
      fetchFn: this.fetchFn,
      cdnBaseUrl: this.config.cdnBaseUrl,
      toUserId: userId,
      buffer,
      mediaType: inferred.mediaType,
    });
    return uploadedToMessageItem({
      uploaded,
      kind: inferred.kind,
      fileName: file.filename,
    });
  }

  private async attachmentToMessageItem(userId: string, attachment: Attachment): Promise<MessageItem> {
    const buffer = await attachmentToBuffer(attachment, this.fetchFn);
    const inferred = inferUploadKind(attachment.mimeType, attachment.type);
    const uploaded = await uploadBufferToWeixin({
      protocol: this.protocol,
      fetchFn: this.fetchFn,
      cdnBaseUrl: this.config.cdnBaseUrl,
      toUserId: userId,
      buffer,
      mediaType: inferred.mediaType,
    });
    return uploadedToMessageItem({
      uploaded,
      kind: inferred.kind,
      fileName: attachment.name,
    });
  }

  private attachmentsFromMessage(raw: WeixinMessage): Attachment[] {
    return (raw.item_list ?? [])
      .map((item) =>
        attachmentFromMessageItem({
          item,
          cdnBaseUrl: this.config.cdnBaseUrl,
          fetchFn: this.fetchFn,
        }),
      )
      .filter((attachment): attachment is Attachment => attachment != null);
  }

  rehydrateAttachment(attachment: Attachment): Attachment {
    const metadata = attachment.fetchMetadata;
    const encryptedQueryParam = metadata?.encryptedQueryParam;
    if (!encryptedQueryParam) return attachment;

    const cdnBaseUrl = metadata?.cdnBaseUrl || this.config.cdnBaseUrl;
    const url = attachment.url || buildCdnDownloadUrl(encryptedQueryParam, cdnBaseUrl);
    const aesKey = metadata?.aesKey ? Buffer.from(metadata.aesKey, "base64") : undefined;

    return {
      ...attachment,
      url,
      fetchData: async () => {
        const fetchFn = this.fetchFn ?? fetch;
        const res = await fetchFn(url);
        if (!res.ok) {
          throw new ValidationError("weixin", `CDN download failed with status ${res.status}`);
        }
        const buf = Buffer.from(await res.arrayBuffer());
        const decrypted = aesKey && aesKey.length > 0 ? decryptAesEcb(buf, aesKey) : buf;
        if (attachment.type === "audio") {
          return (await silkToWav(decrypted)) ?? decrypted;
        }
        return decrypted;
      },
    };
  }

  private assertInitialized(): void {
    if (!this.chat || !this.state) {
      throw new Error("WeixinAdapter is not initialized");
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
