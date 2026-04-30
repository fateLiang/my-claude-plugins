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
