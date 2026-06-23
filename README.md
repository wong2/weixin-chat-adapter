# chat-adapter-weixin

Weixin iLink bot adapter for [Chat SDK](https://chat-sdk.dev/).

This package talks to Weixin's iLink bot HTTP JSON APIs directly. It uses long
polling for inbound messages and Chat SDK's `StateAdapter` for runtime cursor,
context-token, dedupe, and thread-history data.

## Install

```bash
pnpm add chat-adapter-weixin chat @chat-adapter/state-memory
```

## Quick Start

```ts
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createWeixinAdapter } from "chat-adapter-weixin";

const bot = new Chat({
  userName: "mybot",
  state: createMemoryState(),
  adapters: {
    weixin: createWeixinAdapter({
      accountId: process.env.WEIXIN_ACCOUNT_ID,
      token: process.env.WEIXIN_BOT_TOKEN,
      baseUrl: process.env.WEIXIN_BASE_URL,
    }),
  },
});

bot.onDirectMessage(async (thread, message) => {
  await thread.post(`You said: ${message.text}`);
});

await bot.initialize();
```

## QR Login

The CLI can acquire credentials. It does not replace Chat SDK state storage.

```bash
weixin-chat-adapter login --env
weixin-chat-adapter login --json
weixin-chat-adapter login --save --state-dir ./.weixin-dev
```

Use `--save` only as a local-development convenience. In production, pass the
resulting token through environment variables or your secret manager.
