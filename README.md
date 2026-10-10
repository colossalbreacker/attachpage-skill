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
- `tests/publish.test.mjs`: end-to-end tests for the helper against a local mock of the API.

## Credentials for the helper

`publish.mjs` uses the first key it finds: `ATTACHPAGE_API_KEY` in the environment,
`~/.attachpage/credentials`, then your operating system's credential manager (Windows Credential
Manager, macOS Keychain, or the Secret Service through `secret-tool` on Linux).

```bash
node scripts/publish.mjs login                # sign in in the browser, save the key to the credential manager
node scripts/publish.mjs login --store file   # save to ~/.attachpage/credentials instead
node scripts/publish.mjs logout               # remove the saved key
```

`login --key-stdin` saves a key you pipe in from your own terminal. Entries are per origin: the
Windows generic credential `attachpage:<origin>`, or service `attachpage` with account `<origin>`
in the Keychain and Secret Service. Pass `--origin` for a deployment other than attachpage.com.

## Tests

```bash
node --test
```

The tests cover exact folder uploads, stopping on failed finalization, multipart document publishing,
withholding account credentials from direct storage uploads, and every credential source including
the credential manager, which they skip when none is usable (set `REQUIRE_OS_STORE=1` to fail
instead). GitHub Actions runs them on Windows, macOS, and Ubuntu.

## Other connections

- Remote MCP: `https://attachpage.com/mcp`
- Custom GPT Actions: `https://attachpage.com/openapi.json`
- Documentation: [attachpage.com/docs](https://attachpage.com/docs)

Pages and documents are private by default. New invitations require the exact recipient addresses
and message. Anonymous publishing is unavailable during private beta.
