# pi-quota-status

[![npm version](https://img.shields.io/npm/v/pi-quota-status.svg)](https://www.npmjs.com/package/pi-quota-status)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`pi-quota-status` is a Pi extension package that adds a compact subscription quota/reset indicator beside Pi's default footer statusline.

```text
quota 72% left · reset 4:20 PM
```

It uses its own `ctx.ui.setStatus("pi-quota-status", ...)` slot, so Pi's default footer stays intact.

The extension is intentionally scoped to `/login` subscription models. If the active model is using an API key, environment key, runtime key, or custom provider key, the quota status is hidden.

## Supported quota sources

Current support is split by how quota data is exposed:

- Anthropic `/login` models (`anthropic/claude-*`) — parsed from Anthropic rate-limit headers when Pi exposes them to extensions. You can also enable a manual fixed-window fallback in config.
- OpenAI Codex `/login` models (`openai-codex/*`) — polled from the ChatGPT Codex usage endpoint with Pi's OAuth token. This produces rows such as `openai-codex/gpt-5.5` with `5h` and `weekly` dimensions.
- Generic OpenAI-compatible headers — optional named header mappings for OpenAI-compatible providers or proxies. This is header-based and separate from the OpenAI Codex subscription poll.

The extension only displays quota for models Pi reports as using `/login` OAuth. If the same provider/model is configured with an API key, it is ignored.

## Requirements

- Pi coding agent with extension package support.
- Node.js `>=22.19.0`.
- A provider/model authenticated through Pi's `/login` OAuth flow for subscription quota display.

This package is a Pi extension package, not a standalone CLI.

## Install

From npm:

```bash
pi install npm:pi-quota-status
```

Or try it for one run:

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

## Commands

- `/quota` — table for tracked `/login` subscription models: provider/model, remaining %, reset, source, dimension, freshness.
- `/quota config` — shows the config/state paths and creates a template config if missing. The template is static; it does not inspect current `/login` accounts or create different entries per user.
- `/quota reload` — reloads config and state from disk.
- `/quota debug` — shows adapter/debug status without raw headers.

## Storage

Global files are kept separate:

```text
~/.pi/agent/pi-quota-status/config.json
~/.pi/agent/pi-quota-status/state.json
```

`config.json` is user-editable. `state.json` contains parsed quota observations only. Raw provider headers, prompts, responses, and tokens are never persisted.

State writes use a small lock plus atomic rename so concurrent Pi sessions merge state instead of overwriting the whole file blindly.

## Config schema

If `config.json` is absent, the extension uses built-in defaults at runtime. Running `/quota config` creates an editable template file with both an enabled Anthropic adapter and an enabled generic OpenAI header adapter. OpenAI Codex subscription polling does not require a config adapter entry; it runs whenever the active `openai-codex/*` model is using `/login` OAuth and Pi can provide the OAuth token.

Top-level fields:

```json
{
  "version": 1,
  "refreshIntervalMs": 60000,
  "warningThreshold": 25,
  "criticalThreshold": 10,
  "adapters": []
}
```

Adapter fields:

```json
{
  "name": "anthropic",
  "type": "anthropic",
  "enabled": true,
  "provider": "anthropic",
  "models": ["claude-*"],
  "fallback": {
    "enabled": false,
    "dimension": "messages",
    "limit": 45,
    "windowSeconds": 18000,
    "consume": { "unit": "turns", "amount": 1 }
  }
}
```

Matching uses `provider` plus model globs. `*` and `?` are supported.

## Adding missing default adapters

`/quota config` creates a config only when one does not already exist. If you already have `config.json`, add whichever entry is missing to its `adapters` array, then run `/quota reload`.

Anthropic:

```json
{
  "name": "anthropic",
  "type": "anthropic",
  "enabled": true,
  "provider": "anthropic",
  "models": ["claude-*"]
}
```

OpenAI header adapter:

```json
{
  "name": "openai",
  "type": "generic",
  "enabled": true,
  "provider": "openai*",
  "models": ["gpt-*", "o*", "chatgpt-*"],
  "dimensions": [
    {
      "dimension": "requests",
      "limit": "x-ratelimit-limit-requests",
      "remaining": "x-ratelimit-remaining-requests",
      "reset": "x-ratelimit-reset-requests",
      "retryAfter": "retry-after"
    },
    {
      "dimension": "tokens",
      "limit": "x-ratelimit-limit-tokens",
      "remaining": "x-ratelimit-remaining-tokens",
      "reset": "x-ratelimit-reset-tokens",
      "retryAfter": "retry-after"
    }
  ]
}
```

## Header adapters

Header parsing ships with:

- `anthropic` — parses common Anthropic rate-limit headers such as request/token/message dimensions.
- `generic` — parses named header mappings for OpenAI-compatible or proxy headers. The default OpenAI entry is a generic adapter scoped to `provider: "openai*"`.

These adapters parse provider response headers only. The OpenAI Codex `/login` quota support is handled by subscription polling, not by the generic OpenAI header adapter.

Adapters are evaluated only after Pi reports that the active model uses OAuth subscription auth from `/login`. API-key and custom-key providers are ignored even if their headers match an adapter.

Generic mappings use named fields only; no user-supplied JavaScript parser functions are executed.

```json
{
  "name": "custom-generic",
  "type": "generic",
  "provider": "openai*",
  "models": ["gpt-*", "o*", "chatgpt-*"],
  "dimensions": [
    {
      "dimension": "requests",
      "limit": "x-ratelimit-limit-requests",
      "remaining": "x-ratelimit-remaining-requests",
      "reset": "x-ratelimit-reset-requests",
      "retryAfter": "retry-after"
    },
    {
      "dimension": "tokens",
      "limit": "x-ratelimit-limit-tokens",
      "remaining": "x-ratelimit-remaining-tokens",
      "reset": "x-ratelimit-reset-tokens",
      "retryAfter": "retry-after"
    }
  ]
}
```

If multiple provider-header dimensions are present, the footer uses the most constrained remaining percentage. For polled subscription quota with both short and weekly windows, the footer prefers the short reset window and only surfaces the weekly window when it is exhausted.

## Manual fallback

When provider headers are absent for a `/login` subscription model, an adapter can declare a fixed-window fallback quota. v1 automatically deducts `turns` after successful provider responses, including internal provider calls that Pi routes through the same response hook.

```json
{
  "fallback": {
    "enabled": true,
    "dimension": "messages",
    "limit": 45,
    "windowSeconds": 18000,
    "consume": { "unit": "turns", "amount": 1 }
  }
}
```

After the reset time passes, fallback observations recompute the next fixed window. Header-only observations are hidden from the footer after their reset time until fresh headers arrive.

## Subscription polling

On session start, model selection, `/quota reload`, and every `refreshIntervalMs`, the extension polls known subscription quota sources when Pi can provide an OAuth access token.

Currently supported poll source:

- `openai-codex` — polls the ChatGPT Codex usage endpoint and maps its 5h and weekly windows into quota dimensions.

This poll is conditional on the model being authenticated through `/login`; the config template is not personalized based on which user is logged in. Provider response headers and fallback observations remain supported for other `/login` subscription providers.

## UI behavior

- Footer status shows only the active model.
- API-key, environment-key, runtime-key, and custom-key providers are hidden.
- Subscription models with no quota data show `quota n/a (sub)` plus context usage when available.
- Colors are used only below thresholds: warning below 25%, critical below 10% by default.
- Quota polling and countdown refresh run once per minute by default.
- On HTTP 429 with retry/reset data, the footer shows `quota 0% left · reset ...`.

## Privacy notes

The extension stores parsed numbers and reset timestamps only. It does not persist raw headers, prompts, responses, or API keys. `/quota debug` reports adapter names, model ids, status categories, and parsed-dimension counts, not raw header values.

## Known limitations

- Providers and transports vary in whether they expose rate-limit headers to Pi extensions.
- Header naming differs across providers and proxies; use a generic adapter mapping for custom headers.
- Token/cost fallback units are reserved for later expansion; v1's automatic fallback deduction is turn-based.
