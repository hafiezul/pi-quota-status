# pi-quota-status

[![npm version](https://img.shields.io/npm/v/pi-quota-status.svg)](https://www.npmjs.com/package/pi-quota-status)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`pi-quota-status` is a Pi extension package that adds compact provider quota/reset information beside Pi's default footer statusline.

```text
5h 78% 1:57PM · Wk 30% 8:57AM (28/06)
```

It uses its own `ctx.ui.setStatus("pi-quota-status", ...)` slot, so Pi's default footer stays intact.

## Supported quota sources

- Anthropic `/login` models (`anthropic/claude-*`): native subscription polling, response-header parsing, and optional fixed-window fallback.
- OpenAI Codex `/login` models (`openai-codex/*`): native polling from the ChatGPT Codex usage endpoint, with local Codex CLI RPC reconciliation when the endpoint reports a healthy-but-stale 5h zero.
- Antigravity (`antigravity/*`): native polling through Pi-resolved credentials. The extension reads the active runtime model quota from Antigravity's available-models endpoint.
- Command Code (`commandcode/*`): native polling through Pi-resolved credentials. The footer can show Command Code's 5h and weekly windows.
- DeepSeek (`deepseek/*`): native balance polling through Pi-resolved credentials.
- Fireworks (`fireworks/*`): native billing-summary polling through Pi-resolved credentials, displayed as recent billed spend.
- Groq (`groq/*`): native Prometheus usage polling through Pi-resolved credentials, displayed as request/minute and token/minute rates.
- Hugging Face (`huggingface/*`): native billing polling through Pi-resolved credentials, including monthly inference spend/limit and ZeroGPU quota when available.
- Moonshot (`moonshotai/*`, `moonshotai-cn/*`): native balance polling through Pi-resolved credentials.
- Kimi Coding (`kimi-coding/*`): native polling for 5h, weekly, and monthly usage windows.
- MiniMax (`minimax/*`, `minimax-cn/*`): native token-plan polling for interval and weekly quota windows, with the legacy coding-plan endpoint as fallback.
- OpenCode Go (`opencode-go/*`): native polling through Pi-resolved credentials. The footer can show its rolling 5h, weekly, and monthly windows.
- OpenAI API (`openai/*`): best-effort credit-grant polling through Pi-resolved API-key credentials when that account endpoint is available.
- OpenRouter (`openrouter/*`): native polling through Pi-resolved credentials. Capped API keys show the key's remaining spending quota using OpenRouter's `/api/v1/key` metadata.
- xAI (`xai/*`): native SuperGrok subscription billing polling when Pi is using xAI OAuth. API-key xAI models are left alone because the subscription endpoint requires the OAuth credential.
- Z.AI / GLM (`zai/*`, `zai-coding-cn/*`): native polling for 5h, weekly, monthly, and MCP quota windows exposed by the provider.
- Provider response headers: built-in Anthropic/OpenAI parsing plus configurable generic header mappings for other providers and proxies.
- Manual fixed-window fallback quotas configured per provider/model adapter.

Native polling uses credentials from Pi's model registry. CodexBar is a reference for provider coverage, endpoints, and quota semantics; the extension does not execute or depend on CodexBar. Provider rate-limit headers can update the active observation immediately when Pi exposes them through its response hook.

## Requirements

- Pi coding agent with extension package support.
- Node.js `>=22.19.0`.
- Optional: the `codex` CLI on `PATH` for OpenAI Codex stale-zero reconciliation. If unavailable, the extension keeps the last trusted value and retries instead of failing.

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
2. Start Pi with any model.
3. Run `/quota` to view tracked quota rows.
4. Run `/quota config` if you want to create or edit adapter settings.
5. After editing config, run `/quota reload` in Pi.

See [docs/configuration.md](docs/configuration.md) for config schema, adapter examples, fallback quotas, polling details, and UI behavior.

## Commands

- `/quota` - table for tracked quota observations: provider/model, remaining %, reset, source, dimension, freshness.
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

Anthropic and OpenAI Codex native subscription polling do not require config adapter entries; they run whenever the active supported provider/model is using `/login` OAuth and Pi can provide the OAuth token. Antigravity, Command Code, DeepSeek, Fireworks, Groq, Hugging Face, Moonshot, Kimi Coding, MiniMax, OpenCode Go, OpenAI API, OpenRouter, xAI, and Z.AI native polling also require no adapter entry; they use authentication resolved by Pi's model registry.

Read the [configuration reference](docs/configuration.md) for:

- Top-level config and adapter fields.
- Anthropic and generic header adapter examples.
- Manual fixed-window fallback quotas.
- Native provider polling, Codex CLI reconciliation, and suspicious OpenAI Codex observation handling.

## UI behavior

- Footer status shows only the active model.
- API-key, environment-key, runtime-key, and custom-key providers can show quota from a native provider poller, provider headers, or configured fallback adapters.
- Subscription models with no quota data show `quota n/a (sub)`.
- Non-subscription models with a known quota source but no current data show `quota n/a`; models with no quota source do not add a footer segment.
- Colors are used only below thresholds: warning below 25%, critical below 10% by default. Multi-window status uses the lowest displayed remaining percentage.
- Quota polling and countdown refresh run once per minute by default.
- On HTTP 429 with retry/reset data, the footer shows a compact zero-remaining segment such as `Req 0% 1:57PM`.

## Known limitations

- Providers and transports vary in whether they expose rate-limit headers to Pi extensions.
- Native account polling currently has provider-specific implementations for Anthropic, OpenAI Codex, Antigravity, Command Code, DeepSeek, Fireworks, Groq, Hugging Face, Moonshot, Kimi Coding, MiniMax, OpenCode Go, OpenAI API, OpenRouter, xAI, and Z.AI. CodexBar remains the reference for expanding coverage.
- Some CodexBar providers use credentials Pi does not expose for quota access. Examples include GitHub Copilot's raw GitHub OAuth token, Gemini CLI OAuth, browser-session billing for Mistral/OpenCode/Qwen Cloud/Xiaomi MiMo, and cloud billing credentials for Bedrock/Vertex AI. Those providers are not given synthetic `quota n/a` data from an incompatible Pi inference key.
- Header naming differs across providers and proxies; use a generic adapter mapping for custom headers.
- Token/cost fallback units are reserved for later expansion; v1's automatic fallback deduction is turn-based.
