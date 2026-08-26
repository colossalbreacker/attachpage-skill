---
name: attachpage
description: Send a web page like an attachment, or publish it right from your chat. AttachPage hosts a static folder (index.html + assets) privately at a chosen address or the user's own domain, emails each recipient a personal link, tracks who opened it, and lets the sender update, revoke, expire, or make the page public. Works with any agent that can make an HTTP request.
---

# AttachPage

The always-current version of these instructions is served by the app at `<ORIGIN>/skill.md`
(`https://preview.attachpage.com/skill.md` during the beta). Read that first if you have network
access; it contains the exact origin, limits and the full API. This file is the offline summary.

## What it does
- **Send** a page to named people: each gets a personal, revocable, expiring link. No accounts for recipients.
- **Publish** a page publicly (anyone with the link) when the user explicitly asks.
- Chosen address `<slug>.<usercontent-domain>` or the user's own domain (set up in the dashboard).

## Ways to authenticate (pick the first that applies)
1. **API key** the user pasted (`Authorization: Bearer ap_…`). Store it in `~/.attachpage/credentials`
   as `ATTACHPAGE_API_KEY=…` with `ATTACHPAGE_ORIGIN=<ORIGIN>`.
2. **Sign in from the chat**: `POST <ORIGIN>/api/v1/device/start` → show the user the `verificationUrl`
   and `userCode`; poll `POST <ORIGIN>/api/v1/device/poll` until `approved` → store the `apiKey`.
3. **No account**: `POST <ORIGIN>/api/v1/anonymous/publish-inline` — public page, expires in 48 h,
   returns `claimUrl`. **Print the claimUrl verbatim on its own line**; it cannot be recovered.

## Publish
- One call, files in the body (≤ 4 MB): `POST <ORIGIN>/api/v1/publish-inline`
  `{"siteName","slug"?,"visibility"?,"siteId"?,"files":[{"path":"index.html","content":"…"},{"path":"logo.png","content":"<base64>","encoding":"base64"}]}`
- Larger folders: `scripts/publish.mjs <folder> --name "…" [--slug …] [--site <id>] [--to a@b.com] [--message "…"] [--expires 7]`
  (declare → PUT each file → finalize → optional send).

## Send, list, edit
- `POST <ORIGIN>/api/v1/sites/<siteId>/send` `{"recipients":[…],"message":"…","expiresInDays":7}`
- `GET <ORIGIN>/api/v1/sites` · `GET <ORIGIN>/api/v1/sites/<siteId>`
- `PATCH <ORIGIN>/api/sites/<siteId>` `{"name"?,"slug"?,"visibility"?}`
- Replace a page at the same address: publish again with `siteId`.

## Other transports
- OpenAPI: `<ORIGIN>/openapi.json` (ChatGPT Custom GPT Actions, any OpenAPI client).
- MCP (Streamable HTTP): `<ORIGIN>/mcp` with the same bearer key.

## Rules
- Confirm name, address and recipient list with the user before sending; emails are irreversible.
- Default to private; make a page public only when the user asks.
- Never upload folders with secrets or password forms (the service rejects them).
- Print the returned page URL on its own line.
