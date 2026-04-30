# ⚠️ UNOFFICIAL PERSONAL FORK — NOT ANTHROPIC

> **This repository is NOT affiliated with, endorsed by, or sponsored by Anthropic, PBC.**
>
> It is a **personal** fork of [`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official) maintained by [@fateLiang](https://github.com/fateLiang) **for the maintainer's own use only**. No support, no warranty, no community distribution intent.
>
> **Other users are not the audience.** If you found this repository through search, GitHub forks-network, or a closed pull-request reference: this is not an official source, not curated for general use, and may diverge from upstream at any time without notice. **Please use the official upstream marketplace instead** → `anthropics/claude-plugins-official`.

## Trademark notice

"Claude," "Claude Code," and "Anthropic" are trademarks of Anthropic, PBC. This fork uses these names solely in a descriptive sense — to identify the upstream project being forked and the runtime tool the plugins target. **No trademark license is granted, claimed, or implied.** All trademark rights belong to their respective holders. If a representative of Anthropic believes this fork's existence creates confusion or violates trademark guidelines, please open an issue or contact the maintainer directly and the offending content will be addressed promptly.

## Why this fork exists

Two small additions were prototyped against `external_plugins/telegram` for the maintainer's own Claude Code workflow:

- forward / reply attribution metadata on inbound messages
- inline-hyperlink (`text_link`) URL surfacing so URLs hidden behind link labels survive into the agent's view

`plugin.json` is bumped to `0.0.7` to mark divergence. The patches were proposed upstream in [PR #1657](https://github.com/anthropics/claude-plugins-official/pull/1657) but the upstream project does not accept external contributions, so the changes live here.

## Setup (maintainer reference)

Switching a Claude Code installation from `telegram@claude-plugins-official` to `telegram@my-claude-plugins` requires a few steps. The fork is not on Anthropic's approved-channels ledger, so Claude Code rejects it unless launched with the development-channels bypass flag.

### 1. Register the marketplace

Inside Claude Code:

```
/plugin marketplace add fateLiang/my-claude-plugins
/plugin install telegram@my-claude-plugins
/plugin uninstall telegram@claude-plugins-official
/reload-plugins
```

If `/plugin uninstall` fails or the CLI silently re-routes the install back to `claude-plugins-official` (a known quirk when both names exist at once), edit `~/.claude/plugins/installed_plugins.json` directly and remove the `telegram@claude-plugins-official` entry. The valid resulting state has only `telegram@my-claude-plugins` and points its `installPath` at `~/.claude/plugins/cache/my-claude-plugins/telegram/0.0.7`.

### 2. Update each project's settings

Project-local `.claude/settings.json` and `.claude/settings.local.json` files override the global setting, so every project that previously enabled `telegram@claude-plugins-official` needs the key flipped:

```jsonc
{
  "enabledPlugins": {
    "telegram@my-claude-plugins": true   // was: "telegram@claude-plugins-official": true
  }
}
```

Preserve any `env.TELEGRAM_STATE_DIR` and other unrelated entries.

### 3. Launch Claude Code with the dev-channels flag

```bash
claude \
  --dangerously-skip-permissions \
  --dangerously-load-development-channels plugin:telegram@my-claude-plugins \
  -c
```

The `--dangerously-load-development-channels` flag is a list — pass channel entries (in the same `plugin:<name>@<marketplace>` form as `--channels`) directly to it. Channels passed via this flag are tagged `dev=true` internally, which bypasses the Anthropic-managed channels allowlist. You only need this for non-Anthropic marketplaces; channels in Anthropic's official ledger continue to work via plain `--channels`.

### 4. Verify the patches are live

Send a Telegram message containing an inline link, e.g. `[test](https://example.com/abc)`.

The receiving Claude Code session should see `[test](https://example.com/abc)` in the channel content. If it sees only `test`, the patched plugin isn't loaded — re-check that `bun` is running from `~/.claude/plugins/cache/my-claude-plugins/telegram/0.0.7` (`ps -ef | grep bun.*telegram`) rather than from the upstream cache or marketplace dir.

## Use at your own risk

If you choose to use this fork anyway despite the warnings above, you accept all risk. The maintainer makes no representations about correctness, security, or longevity. The fork may be deleted, made private, or reset at any time.

---

# Claude Code Plugins Directory

A curated directory of high-quality plugins for Claude Code.

> **⚠️ Important:** Make sure you trust a plugin before installing, updating, or using it. Anthropic does not control what MCP servers, files, or other software are included in plugins and cannot verify that they will work as intended or that they won't change. See each plugin's homepage for more information.

## Structure

- **`/plugins`** - Internal plugins developed and maintained by Anthropic
- **`/external_plugins`** - Third-party plugins from partners and the community

## Installation

Plugins can be installed directly from this marketplace via Claude Code's plugin system.

To install, run `/plugin install {plugin-name}@claude-plugins-official`

or browse for the plugin in `/plugin > Discover`

## Contributing

### Internal Plugins

Internal plugins are developed by Anthropic team members. See `/plugins/example-plugin` for a reference implementation.

### External Plugins

Third-party partners can submit plugins for inclusion in the marketplace. External plugins must meet quality and security standards for approval. To submit a new plugin, use the [plugin directory submission form](https://clau.de/plugin-directory-submission).

## Plugin Structure

Each plugin follows a standard structure:

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json      # Plugin metadata (required)
├── .mcp.json            # MCP server configuration (optional)
├── commands/            # Slash commands (optional)
├── agents/              # Agent definitions (optional)
├── skills/              # Skill definitions (optional)
└── README.md            # Documentation
```

## License

Please see each linked plugin for the relevant LICENSE file.

## Documentation

For more information on developing Claude Code plugins, see the [official documentation](https://code.claude.com/docs/en/plugins).
