# AttachPage agent skill

Send a web page like an attachment — or publish it right from your chat.

Works with **any agent or tool that can make an HTTP request**: Claude Code, Cursor, Codex, OpenClaw, Amp, Gemini CLI, Aider, ChatGPT (as a Custom GPT Action), scripts, CI.

## Install

```bash
npx skills add colossalbreacker/attachpage-skill --skill attachpage -g
```

or just tell your agent: *"Read https://preview.attachpage.com/skill.md and follow it."*

## What's here

- `SKILL.md` — the instructions agents follow (offline copy of `/skill.md`).
- `scripts/publish.mjs` — declare → upload → finalize → send in one command for larger folders.

## Other ways in

- OpenAPI for ChatGPT Actions: `https://preview.attachpage.com/openapi.json`
- MCP server (Streamable HTTP): `https://preview.attachpage.com/mcp`
- No account? Anonymous 48-hour public pages with a claim link — see `SKILL.md`.
