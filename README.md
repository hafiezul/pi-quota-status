# pi-quota-status

[![npm version](https://img.shields.io/npm/v/pi-quota-status.svg)](https://www.npmjs.com/package/pi-quota-status)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`pi-quota-status` is a Pi extension package that adds a compact subscription quota/reset indicator beside Pi's default footer statusline.

```text
5h 78% 1:57PM · Wk 30% 8:57AM (28/06)
```

It uses its own `ctx.ui.setStatus("pi-quota-status", ...)` slot, so Pi's default footer stays intact.

The extension is intentionally scoped to `/login` subscription models. API-key, environment-key, runtime-key, and custom-key providers are hidden.

## Supported quota sources

- Anthropic `/login` models (`anthropic/claude-*`): subscription polling, response-header parsing, and optional fixed-window fallback.
- OpenAI Codex `/login` models (`openai-codex/*`): subscription polling from the ChatGPT Codex usage endpoint.
- Generic OpenAI-compatible headers: optional named header mappings for OpenAI-compatible providers or proxies.

The extension only displays quota for models Pi reports as using `/login` OAuth. If the same provider/model is configured with an API key, it is ignored.

## Requirements

- Pi coding agent with extension package support.
- Node.js `>=22.19.0`.
- A provider/model authenticated through Pi's `/login` OAuth flow for subscription quota display.

This package is a Pi extension package, not a standalone CLI.

## Install

```bash
pi install npm:pi-quota-status
```

Try it for one run:

```bash
pi -e npm:pi-quota-status
```

From GitHub:

```bash
pi install git:github.com/hafiezul/pi-quota-status
```

## Quick start

1. Install the package with one of the commands above.
2. Start Pi with a `/login` subscription model.
3. Run `/quota` to view tracked quota rows.
4. Run `/quota config` if you want to create or edit adapter settings.
5. After editing config, run `/quota reload` in Pi.

See [docs/configuration.md](docs/configuration.md) for config schema, adapter examples, fallback quotas, polling details, and UI behavior.

## Commands

- `/quota` - table for tracked `/login` subscription models: provider/model, remaining %, reset, source, dimension, freshness.
- `/quota config` - shows config/state paths and creates a static template config if missing.
- `/quota reload` - reloads config and state from disk.
- `/quota debug` - shows adapter/debug status without raw headers.

## Storage and privacy

Global files are kept separate:

```text
~/.pi/agent/pi-quota-status/config.json
~/.pi/agent/pi-quota-status/state.json
```

`config.json` is user-editable. `state.json` contains parsed quota observations only. Raw provider headers, prompts, responses, and tokens are never persisted.

State writes use a small lock plus atomic rename so concurrent Pi sessions merge state instead of overwriting the whole file blindly. `/quota debug` reports sanitized status fields only, not raw provider payloads.

## Configuration

If `config.json` is absent, the extension uses built-in defaults at runtime. Running `/quota config` creates an editable template with enabled Anthropic and generic OpenAI header adapters.

Anthropic and OpenAI Codex subscription polling do not require config adapter entries; they run whenever the active supported provider/model is using `/login` OAuth and Pi can provide the OAuth token.

Read the [configuration reference](docs/configuration.md) for:

- Top-level config and adapter fields.
- Anthropic and generic header adapter examples.
- Manual fixed-window fallback quotas.
- Subscription polling behavior and suspicious OpenAI Codex observation handling.

## UI behavior

- Footer status shows only the active model.
- API-key, environment-key, runtime-key, and custom-key providers are hidden.
- Subscription models with no quota data show `quota n/a (sub)` plus context usage when available.
- Colors are used only below thresholds: warning below 25%, critical below 10% by default. Multi-window status uses the lowest displayed remaining percentage.
- Quota polling and countdown refresh run once per minute by default.
- On HTTP 429 with retry/reset data, the footer shows a compact zero-remaining segment such as `Req 0% 1:57PM`.

## Known limitations

- Providers and transports vary in whether they expose rate-limit headers to Pi extensions.
- Header naming differs across providers and proxies; use a generic adapter mapping for custom headers.
- Token/cost fallback units are reserved for later expansion; v1's automatic fallback deduction is turn-based.
