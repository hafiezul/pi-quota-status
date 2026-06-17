# pi-quota-status

`pi-quota-status` is a Pi extension package that adds a compact quota/reset indicator to Pi's default footer statusline.

```text
quota 72% left · reset 3h
```

It uses `ctx.ui.setStatus(...)`, so Pi's default footer stays intact.

## Install by path

From this checkout:

```bash
pi install /Users/hj88956/Workspace/personal/pi-quota-status
```

Or try it for one run:

```bash
pi -e /Users/hj88956/Workspace/personal/pi-quota-status
```

After editing config, run `/quota reload` in Pi.

## Commands

- `/quota` — table for all tracked models: provider/model, remaining %, reset, source, dimension, freshness.
- `/quota config` — shows the config/state paths and creates a template config if missing.
- `/quota reload` — reloads config and state from disk.
- `/quota debug` — shows adapter/debug status without raw headers.

## Storage

Global files are kept separate:

```text
~/.pi/agent/pi-quota-status/config.json
~/.pi/agent/pi-quota-status/state.json
```

`config.json` is user-editable. `state.json` contains parsed quota observations only. Raw provider headers are never persisted.

State writes use a small lock plus atomic rename so concurrent Pi sessions merge state instead of overwriting the whole file blindly.

## Config schema

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

## Header adapters

v1 ships with:

- `anthropic` — parses common Anthropic rate-limit headers such as request/token/message dimensions.
- `generic` — parses named header mappings for OpenAI-compatible or proxy headers.

Generic/custom mappings use named fields only; no user-supplied JavaScript parser functions are executed.

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

If multiple dimensions are present, the footer uses the most constrained remaining percentage.

## Manual fallback

When provider headers are absent, an adapter can declare a fixed-window fallback quota. v1 automatically deducts `turns` after successful provider responses, including internal provider calls that Pi routes through the same response hook.

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

## UI behavior

- Footer status shows only the active model.
- Unsupported or unknown quota data is hidden.
- Colors are used only below thresholds: warning below 25%, critical below 10% by default.
- Countdown refreshes once per minute by default.
- On HTTP 429 with retry/reset data, the footer shows `quota 0% left · reset ...`.

## Privacy notes

The extension stores parsed numbers and reset timestamps only. It does not persist raw headers, prompts, responses, or API keys. `/quota debug` reports adapter names, model ids, status categories, and parsed-dimension counts, not raw header values.

## Known limitations

- Providers and transports vary in whether they expose rate-limit headers to Pi extensions.
- Header naming differs across providers and proxies; use a generic adapter mapping for custom headers.
- Token/cost fallback units are reserved for later expansion; v1's automatic fallback deduction is turn-based.
