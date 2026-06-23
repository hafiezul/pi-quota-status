# Configuration reference

This page covers the advanced configuration and behavior details for `pi-quota-status`. For install and quick-start instructions, see the [README](../README.md).

## Storage

Global files are kept separate:

```text
~/.pi/agent/pi-quota-status/config.json
~/.pi/agent/pi-quota-status/state.json
```

`config.json` is user-editable. `state.json` contains parsed quota observations only. Raw provider headers, prompts, responses, and tokens are never persisted.

State writes use a small lock plus atomic rename so concurrent Pi sessions merge state instead of overwriting the whole file blindly.

## Config schema

If `config.json` is absent, the extension uses built-in defaults at runtime. Running `/quota config` creates an editable template file with both an enabled Anthropic adapter and an enabled generic OpenAI header adapter.

Anthropic and OpenAI Codex subscription polling do not require config adapter entries. They run whenever the active supported provider/model is using `/login` OAuth and Pi can provide the OAuth token.

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

- `anthropic` - parses common Anthropic rate-limit headers such as request/token/message dimensions.
- `generic` - parses named header mappings for OpenAI-compatible or proxy headers. The default OpenAI entry is a generic adapter scoped to `provider: "openai*"`.

These adapters parse provider response headers only. Anthropic and OpenAI Codex `/login` quota windows are handled by subscription polling, not by the generic OpenAI header adapter.

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

If multiple provider-header dimensions are present, the compact footer uses the most constrained remaining percentage as a single segment. For polled Anthropic and OpenAI Codex subscription quota, the footer shows short and weekly windows together, such as `5h 78% 1:57PM · Wk 30% 8:57AM (28/06)`.

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

Currently supported poll sources:

- `anthropic` - polls Anthropic's OAuth usage endpoint and maps `five_hour`, `seven_day`, and active-model weekly buckets into quota dimensions. The footer shows `5h` plus the stricter relevant weekly bucket (`Wk`, `Son`, or `Opus`).
- `openai-codex` - polls the ChatGPT Codex usage endpoint and maps its 5h and weekly windows into quota dimensions. When the OAuth access token contains a ChatGPT account id, the request includes `ChatGPT-Account-Id` to avoid ambiguous account selection.

For OpenAI Codex, a sudden 5h drop from high remaining quota to near-zero is treated as suspicious unless the server explicitly reports a block (`allowed: false`, `limit_reached: true`, or a non-null `rate_limit_reached_type`). This includes drops seen immediately after a 5h window rolls over. If the server simultaneously reports healthy metadata (`allowed: true`, `limit_reached: false`, and no reached type), the extension attempts to reconcile the stale `/wham/usage` value with the local Codex CLI JSON-RPC app server (`codex -s read-only -a untrusted app-server`, `account/rateLimits/read`) when `codex` is available on `PATH`. A successful RPC reconciliation replaces the stale 5h/weekly windows and `/quota debug` reports `codex_rpc=yes`. If RPC is unavailable or also returns near-zero, the near-zero value is kept pending and is not accepted merely because a quick retry repeats it. The extension keeps the last trusted value, stores the suspicious observation as pending, and schedules one quick retry. If a confirmable second poll repeats the near-zero value, it is accepted; if a sane value returns, the pending observation is discarded. `/quota debug` reports this using sanitized fields only.

Polling is conditional on the model being authenticated through `/login`; the config template is not personalized based on which user is logged in. Provider response headers and fallback observations remain supported for other `/login` subscription providers.

## UI behavior

- Footer status shows only the active model.
- API-key, environment-key, runtime-key, and custom-key providers are hidden.
- Subscription models with no quota data show `quota n/a (sub)` plus context usage when available.
- Colors are used only below thresholds: warning below 25%, critical below 10% by default. Multi-window status uses the lowest displayed remaining percentage.
- Quota polling and countdown refresh run once per minute by default.
- On HTTP 429 with retry/reset data, the footer shows a compact zero-remaining segment such as `Req 0% 1:57PM`.

## Privacy notes

The extension stores parsed numbers, reset timestamps, and optional pending suspicious-observation metadata only. It does not persist raw headers, prompts, responses, OAuth tokens, account ids, emails, or API keys.

`/quota debug` reports adapter names, model ids, status categories, parsed-dimension counts, and sanitized quota-poll flags, not raw provider payloads.

## Known limitations

- Providers and transports vary in whether they expose rate-limit headers to Pi extensions.
- Header naming differs across providers and proxies; use a generic adapter mapping for custom headers.
- Token/cost fallback units are reserved for later expansion; v1's automatic fallback deduction is turn-based.
