# attachpage

Send a website like an attachment. Point it at a folder with an `index.html`; get a link.

Sign in once with your Google or Microsoft account:

```bash
npx attachpage connect                                 # add AttachPage to Claude Code, Codex, Cursor, VS Code, Gemini CLI
npx attachpage login                                   # approve in your browser, once
npx attachpage ./dist                                  # publish (private by default)
npx attachpage send ./dist --to client@example.com --message "Here's the new version"
npx attachpage feedback <pageId>                       # what they said, and where
npx attachpage ./dist --site <pageId> --notify "Applied your feedback"
```

Pages are private by default: only the people you send them to can open them, each with a
personal link you can revoke. Recipients can comment on the page and approve it; `feedback`
lists what they said with the element they pointed at, which is handy for agents. Add `--public`
to make a page open to anyone with the link. Without signing in, `npx attachpage ./dist` publishes a
public page that expires after 48 hours and prints a link to keep it.

- No dependencies, Node 18+.
- Your files are uploaded exactly as they are. Nothing is built, bundled or rewritten.
- `login` keeps your key in the system password store: Windows Credential Manager, the macOS Keychain,
  or the Linux keyring (Secret Service via `secret-tool`). Use `login --store file` on machines without one;
  the key then goes to `~/.attachpage/credentials`, readable only by you. `ATTACHPAGE_API_KEY` overrides both.
  `whoami` shows where the key came from; `logout` removes it from every place.
- `--json` on any command prints machine-readable output.

## Agents and MCP

This package is a command line, not an MCP server. AttachPage's MCP server is remote
(Streamable HTTP with OAuth sign-in) at `https://attachpage.com/mcp`; add that URL to your MCP
client. For clients that only run local stdio servers, bridge it with
[mcp-remote](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "attachpage": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://attachpage.com/mcp"]
    }
  }
}
```

Setup for Claude, ChatGPT, Cursor, VS Code and Codex: https://attachpage.com/agents.
Agent instructions: https://attachpage.com/skill.md.

Support: support@attachpage.com. MIT licensed, by JP Technology Services.

## Connect your AI apps

`npx attachpage connect` adds the AttachPage MCP server (`https://attachpage.com/mcp`) to the AI apps
it finds: Claude Code, OpenAI Codex and Gemini CLI through their own commands, and Cursor and VS Code
through their user config files (backed up first; existing entries and files it cannot parse are left
alone). `--dry-run` shows what it would change; `--client cursor,vscode` limits it to some apps. Each
app asks you to sign in to AttachPage the first time you use it.

