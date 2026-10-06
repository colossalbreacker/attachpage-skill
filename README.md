# AttachPage agent skill

Publish pages and documents, send private invitations, and apply recipient feedback.

## Install

```bash
npx skills add colossalbreacker/attachpage-skill --skill attachpage -g
```

Use the existing AttachPage MCP connection when your agent has one. Connect your own account at
[attachpage.com/agents](https://attachpage.com/agents). ChatGPT and Claude use OAuth; coding agents
can use remote MCP or device sign-in. AttachPage currently requires a private-beta invitation.

Browsing the documentation alone does not give an agent permission to publish. The installed
skill explains the available connections and HTTP fallback without asking for credentials in chat.

## Included files

- `SKILL.md`: connection, publishing, sharing, and feedback instructions.
- `scripts/publish.mjs`: upload a static folder or PDF, Word, PowerPoint, Excel, or CSV document.
  It finalizes before sending and sends invitations only when confirmed recipients are supplied.
  Direct storage uploads do not receive the AttachPage API key.

The helper is covered by four tests in the
[application repository](https://github.com/colossalbreacker/attachpage/tree/main/skill/tests).
They verify exact folder uploads, stopping on failed finalization, multipart document publishing,
and withholding account credentials from direct storage uploads.

## Other connections

- Remote MCP: `https://attachpage.com/mcp`
- Custom GPT Actions: `https://attachpage.com/openapi.json`
- Documentation: [attachpage.com/docs](https://attachpage.com/docs)

Pages and documents are private by default. New invitations require the exact recipient addresses
and message. Anonymous publishing is unavailable during private beta.
