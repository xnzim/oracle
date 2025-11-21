# oracle 🧿 — Whispering your tokens to the silicon sage

<p align="center">
  <img src="https://raw.githubusercontent.com/steipete/oracle/main/README-header.png" alt="Oracle CLI header banner" width="1100">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@steipete/oracle"><img src="https://img.shields.io/npm/v/@steipete/oracle?style=for-the-badge&logo=npm&logoColor=white" alt="npm version"></a>
  <a href="https://github.com/steipete/oracle/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/steipete/oracle/ci.yml?branch=main&style=for-the-badge&label=tests" alt="CI Status"></a>
  <a href="https://github.com/steipete/oracle"><img src="https://img.shields.io/badge/platforms-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=for-the-badge" alt="Platforms"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=for-the-badge" alt="MIT License"></a>
</p>

Oracle bundles your prompt + the right files into a markdown package the model can cite. One command feeds large, coherent context to GPT-5.1 Pro (default), GPT-5.1, or GPT-5.1 Codex (API-only). Attach whole directories, get token estimates/warnings, and optionally copy or render the bundle before sending.

## What is Oracle?
Think “one-shot context drop.” You point Oracle at the files that matter; it builds a structured markdown (SYSTEM/USER + `### File:` fenced sections), then either calls the API or drives ChatGPT in the browser—same flags, same session logs.

## Quick start (npx, no install)

```bash
# API engine (recommended)
npx -y @steipete/oracle -p "Review the TS data layer" --file "src/**/*.ts,!src/**/*.test.ts"

# Browser engine (no API key)
npx -y @steipete/oracle --engine browser -p "Review the TS data layer" --file "src/**/*.ts,!src/**/*.test.ts"

# Multi-model in one call (API): GPT-5.1 Pro + Gemini 3 Pro + Claude Sonnet
npx -y @steipete/oracle --models "gpt-5.1-pro,gemini-3-pro,claude-4.5-sonnet" -p "Cross-check this design" --file src/

# Sessions (list + reattach)
npx -y @steipete/oracle status
npx -y @steipete/oracle session <id>
```

**Recommendation:** Prefer API (default) or manual bundle/copy flows. Full browser automation is experimental (macOS + Chrome only today) and may be blocked by login/Cloudflare challenges.
Keys are loaded automatically from provider env vars (OpenAI, Gemini, Claude, Azure/LiteLLM); pass them inline only if you must.

## Manual handoff (no automation)
- Copy + preview: `npx -y @steipete/oracle --copy --render -p "Your prompt" --file "src/**/*.ts,!src/**/*.test.ts"`
  - Clipboard + colorized preview. Add `--render-plain` if you want unstyled text while copying.
- Save to disk: `npx -y @steipete/oracle --render-plain -p "Your prompt" --file path/to/files > bundle.md`
  - Plain markdown with SYSTEM/USER + fenced `### File:` sections, ready to paste into ChatGPT.

## Highlights

- Bundle once, reuse anywhere — prompt + files as cit-able markdown.
- Flexible file selection — globs and `!` excludes, merged across repeated `--file` flags.
- Pro-friendly — GPT-5.1 Pro background runs with reconnect + token/cost tracking.
- Two paths, one UX — API or browser, same flags and session logs.
- Safety — per-file tokens, size guardrails, `--files-report` when you need detail.
- Preview/copy — `--render`, `--render-plain`, `--copy` for manual workflows.

## CLI usage (short form)
- CI one-liner: `npx -y @steipete/oracle -p "Smoke-check latest PR" --file src/,docs/ --preview summary`
- Background Pro run: `npx -y @steipete/oracle -p "Deep review" --file src/ --wait`
- Sessions: `npx -y @steipete/oracle status` → `npx -y @steipete/oracle session <id>`

## MCP usage
- stdio server: `npx -y @steipete/oracle oracle-mcp` (tools: `consult`, `sessions`; resources: `oracle-session://{id}/{metadata|log|request}`). See [docs/mcp.md](docs/mcp.md).
- mcporter snippet:
  ```json
  { "name": "oracle", "type": "stdio", "command": "npx", "args": ["-y", "@steipete/oracle", "oracle-mcp"] }
  ```

## Prompting tips (what the CLI hints at)
- Aim for 6–30 sentences; include stack, platform, versions, and why it matters.
- Attach source (dirs beat single files) and label cross-repo paths so the model can cite them.
- State expectations: summary vs deep dive, format, tone, constraints.
- Call out prior attempts and suspected areas; include logs/errors next to the code.

## Flags (most common)

| Flag | Purpose |
| --- | --- |
| `-p, --prompt <text>` | Required prompt. |
| `-f, --file <paths...>` | Attach files/dirs (globs + `!` excludes; multiple flags merge). |
| `-e, --engine <api|browser>` | API by default when `OPENAI_API_KEY` is set; otherwise browser. |
| `-m, --model <name>` | `gpt-5.1-pro` (default), `gpt-5.1`, `gpt-5.1-codex` (API-only), others per config. |
| `--render` / `--render-markdown` | Pretty-print the bundle to stdout. |
| `--render-plain` | Force plain markdown (no ANSI) even in TTY. Wins if combined with `--render`. |
| `--copy` / `--copy-markdown` | Copy the bundle to the clipboard; can combine with render flags. |
| `--files-report` | Show per-file token usage. |
| `--dry-run [summary|json|full]` | Preview without calling the model. |
| `--chatgpt-url <url>` | Target a specific ChatGPT workspace/folder in browser mode. |
| `--base-url <url>` | Point API runs at any OpenAI-compatible endpoint (LiteLLM/Azure/etc.). |

Full flag list: `npx -y @steipete/oracle --help` (or `--help --verbose` for hidden flags).

## Configuration
- User defaults live in `~/.oracle/config.json` (JSON5). Set engine/model, notify prefs, browser defaults, prompt suffixes, timeouts, etc. Precedence: CLI flag > env var > config file. See [docs/configuration.md](docs/configuration.md).
- Browser cookies: `--browser-inline-cookies[(-file)]` to avoid Keychain/Chrome reads; fallback files: `~/.oracle/cookies.{json,base64}`.

## FAQ / troubleshooting
- **Browser keeps prompting for login/Keychain?** Use API mode or `--browser-inline-cookies[(-file)]` / `--browser-no-cookie-sync`.
- **Oversize bundle warning (~196k tokens)?** Trim files or use `--files-report` to see heavy hitters.
- **Progress spam?** Use non-verbose mode; browser automation logs stay quiet unless `--verbose`.
- **Need Chromium/Edge?** Set `--browser-chrome-path` and `--browser-cookie-path`; see [docs/chromium-forks.md](docs/chromium-forks.md).
- **Detach vs wait?** Pro API runs detach by default; add `--wait` to stay attached, else reattach via `oracle session <id>`.
- **New model availability (GPT-5.1 Pro / Codex Max via API)** We publish support as soon as OpenAI ships stable API IDs. Until then, the CLI will refuse unknown model names to avoid 404s.

## Testing

```bash
pnpm test
pnpm run lint
```

## Docs & credits
- Docs: `docs/browser-mode.md`, `docs/chromium-forks.md`, `docs/configuration.md`, `docs/manual-tests.md`, `docs/mcp.md`, `docs/testing/mcp-smoke.md`, `docs/tui-debug.md`.
- Sessions and tooling share `~/.oracle/sessions` across CLI and MCP.
- MIT licensed. Maintained by @steipete. Inspired by https://ampcode.com/news/oracle.

If you’re looking for an even more powerful context-management tool, check out https://repoprompt.com
