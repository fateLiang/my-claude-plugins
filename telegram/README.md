# Telegram

Connect a Telegram bot to your Claude Code with an MCP server.

The MCP server logs into Telegram as a bot and provides tools to Claude to reply, react, or edit messages. When you message the bot, the server forwards the message to your Claude Code session.

> **Unofficial fork** (`telegram-durable@fateliang-plugins`, repo [`fateLiang/telegram-durable`](https://github.com/fateLiang/telegram-durable)). Patched on top of Anthropic's official telegram plugin with:
>
> - **A durable inbound store.** Every message is written to disk *before* it is handed to the session, and anything the session never received is replayed on the next start — with the original timestamp and a structured `replay` flag, so an automation can tell a three-day-old instruction from one just sent. Without this, a message that arrives while the session is down is gone with no sign at either end: Telegram deletes an update as soon as the poller advances its offset, which happens on read, not on delivery.
> - **The sender's highlighted quote.** When you select part of a message and reply to it, `message.quote` carries the selected span (plus `is_manual` and `position`). It is a different field from `reply_to_message.text`, and the official plugin never reads it — so the selection you made to point at *one line* arrives as the truncated head of the whole message.
> - Forward/reply attribution in the `<channel>` notification, `text_link` URL surfacing, and `ask_decision` buttons for multiple-choice questions.
>
> Not Anthropic-managed. Because it's not on the official approved-channels allowlist, it loads via `--dangerously-load-development-channels` (see step 4).

## Prerequisites

- [Bun](https://bun.sh) — the MCP server runs on Bun. Install with `curl -fsSL https://bun.sh/install | bash`.

## Quick Setup
> Default pairing flow for a single-user DM bot. See [ACCESS.md](./ACCESS.md) for groups and multi-user setups.

**1. Create a bot with BotFather.**

Open a chat with [@BotFather](https://t.me/BotFather) on Telegram and send `/newbot`. BotFather asks for two things:

- **Name** — the display name shown in chat headers (anything, can contain spaces)
- **Username** — a unique handle ending in `bot` (e.g. `my_assistant_bot`). This becomes your bot's link: `t.me/my_assistant_bot`.

BotFather replies with a token that looks like `123456789:AAHfiqksKZ8...` — that's the whole token, copy it including the leading number and colon.

**2. Install the plugin.**

These are Claude Code commands — run `claude` to start a session first.

Add this fork's marketplace, then install the plugin:
```
/plugin marketplace add fateLiang/telegram-durable
/plugin install telegram-durable@fateliang-plugins
/reload-plugins
```

> **Three different names here, and they are not interchangeable.** The marketplace
> registers itself as `fateliang-plugins` (the `name` in `marketplace.json`), *not* as
> the repository name — so the install target is `<entry>@fateliang-plugins`.
> Two catalog entries point at this same plugin: `telegram-durable` (use this one) and
> `telegram` (the original entry, kept so existing installs don't break).
> The plugin's own `plugin.json` name is `telegram`, and that is what supplies the
> command prefix, so its commands are `/telegram-durable:access` either way.
>
> For step 4, pass the **entry you installed** — `plugin:telegram-durable@fateliang-plugins`.
> Claude Code prints a channels notice at startup saying which servers inject into the
> session, with a warning line if a plugin you named didn't register; if you see that
> warning, try the other entry name. (This fork is only tested with the `telegram`
> entry, which is what its author runs.)

**3. Give the server the token.**

```
/telegram-durable:configure 123456789:AAHfiqksKZ8...
```

Writes `TELEGRAM_BOT_TOKEN=...` to `~/.claude/channels/telegram/.env`. You can also write that file by hand, or set the variable in your shell environment — shell takes precedence.

> To run multiple bots on one machine (different tokens, separate allowlists), point `TELEGRAM_STATE_DIR` at a different directory per instance.

**4. Relaunch with the channel flag.**

The server won't connect without this — exit your session and start a new one:

```sh
claude --dangerously-load-development-channels plugin:telegram-durable@fateliang-plugins
```

> **Why `--dangerously-load-development-channels` and not `--channels`?** Plain `--channels` only loads channel plugins that are on the approved-channels allowlist (`allowedChannelPlugins` in managed/policy settings, or the built-in default — which lists Anthropic's official telegram, not this fork). A personal fork is rejected with *"not on the approved channels allowlist"*. `--dangerously-load-development-channels` is the supported mechanism for loading a non-allowlisted channel — that's the right path for this fork, not a workaround.
>
> If you'd rather use plain `--channels`, add the fork to the allowlist in managed/policy settings, then launch with `--channels plugin:telegram-durable@fateliang-plugins`:
> ```json
> { "allowedChannelPlugins": [ { "plugin": "telegram-durable", "marketplace": "fateliang-plugins" } ] }
> ```

**5. Pair.**

With Claude Code running from the previous step, DM your bot on Telegram — it replies with a 6-character pairing code. If the bot doesn't respond, make sure your session is running with the channel flag from step 4. In your Claude Code session:

```
/telegram-durable:access pair <code>
```

Your next DM reaches the assistant.

> Unlike Discord, there's no server invite step — Telegram bots accept DMs immediately. Pairing handles the user-ID lookup so you never touch numeric IDs.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't get pairing-code replies. Ask Claude to do it, or `/telegram-durable:access policy allowlist` directly.

## Access control

See **[ACCESS.md](./ACCESS.md)** for DM policies, groups, mention detection, delivery config, skill commands, and the `access.json` schema.

Quick reference: IDs are **numeric user IDs** (get yours from [@userinfobot](https://t.me/userinfobot)). Default policy is `pairing`. `ackReaction` only accepts Telegram's fixed emoji whitelist.

## Tools exposed to the assistant

| Tool | Purpose |
| --- | --- |
| `reply` | Send to a chat. Takes `chat_id` + `text`, optionally `reply_to` (message ID) for native threading and `files` (absolute paths) for attachments. Images (`.jpg`/`.png`/`.gif`/`.webp`) send as photos with inline preview; other types send as documents. Max 50MB each. Auto-chunks text; files send as separate messages after the text. Returns the sent message ID(s). |
| `react` | Add an emoji reaction to a message by ID. **Only Telegram's fixed whitelist** is accepted (👍 👎 ❤ 🔥 👀 etc). |
| `edit_message` | Edit a message the bot previously sent. Useful for "working…" → result progress updates. Only works on the bot's own messages. |

Inbound messages trigger a typing indicator automatically — Telegram shows
"botname is typing…" while the assistant works on a response.

## Photos

Inbound photos are downloaded to `~/.claude/channels/telegram/inbox/` and the
local path is included in the `<channel>` notification so the assistant can
`Read` it. Telegram compresses photos — if you need the original file, send it
as a document instead (long-press → Send as File).

## No history or search

Telegram's Bot API exposes **neither** message history nor search. The bot
only sees messages as they arrive — no `fetch_messages` tool exists. If the
assistant needs earlier context, it will ask you to paste or summarize.

This also means there's no `download_attachment` tool for historical messages
— photos are downloaded eagerly on arrival since there's no way to fetch them
later.
