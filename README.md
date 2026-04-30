> **🔱 Personal fork — not affiliated with Anthropic.**
>
> This is a personal fork of [`anthropics/claude-plugins-official`](https://github.com/anthropics/claude-plugins-official) maintained by [@fateLiang](https://github.com/fateLiang) for personal Claude Code use. It is **not** an official Anthropic distribution.
>
> **Differences from upstream `main`:**
> - `external_plugins/telegram` (bumped to `0.0.7`) — adds forward / reply attribution metadata and inline-hyperlink (`text_link`) URL surfacing on inbound messages. Upstream PR: [anthropics/claude-plugins-official#1657](https://github.com/anthropics/claude-plugins-official/pull/1657).
>
> Use at your own risk. This fork does not represent Anthropic's position.

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
