# Provider verification

Run the automated checks from the repository root:

```bash
npm ci
npm run typecheck
npm run check:fetch
npm test
npm run test:integration
```

`npm run test:integration` runs the copied extension in a fresh Pi RPC process for each fixture. It covers all 19 supported native provider IDs with 20 cases, including a separate Anthropic low-utilization case. Regional aliases run separately. The test uses the Pi version installed by `npm ci`.

The test creates temporary agent, project, credential, extension, and quota directories. Credentials are fictional and unexpired. The HTTP fixture handler checks request methods, endpoint paths, authentication headers, and relevant query parameters or request bodies. It returns synthetic responses without forwarding requests to providers. Pi receives only registered extension commands. The test checks that no agent turn starts and removes each disposable profile after use.

## Fixture sources

[providers.json](../tests/fixtures/providers.json) records each case's public source and expected values. Sources include official DeepSeek, Moonshot, and OpenRouter documentation, plus public CodexBar provider implementations and tests. CodexBar references use a pinned commit. The OpenAI API fixture follows the historical credit-grants schema used by the cited public implementation; that endpoint remains best-effort.

Values and identifiers are fictional. Reset timestamps are relative to the test run, preserving the source's seconds, milliseconds, or ISO timestamp encoding. Source schemas are adapted into the specific endpoint envelopes used by this extension. No real credentials or personal account responses are stored.

The fixture handler returns HTTP responses to the production pollers. It does not insert normalized quota observations into state. Each case checks the resulting persisted dimensions, amounts, metrics, reset timestamps, footer text, and `/quota` table.

## Failure and recovery checks

Every case checks HTTP 401, 429, and 503 responses, invalid JSON, an unexpected JSON shape, and a network failure. These failures must preserve the last trusted observation. A subsequent successful poll must recover. Additional cases check Antigravity and MiniMax endpoint fallbacks, optional Hugging Face GPU quota failure, and Groq rate overflow.

Run one case by its fixture name:

```bash
npm run test:integration -- anthropic-low-percent
npm run test:integration -- groq
```

The runner writes `.tmp-test/provider-integration-report.json`. Run integration tests after unit tests because `npm test` clears `.tmp-test`. CI runs both suites on its configured Node versions.

## Verification limits

Synthetic tests verify request construction, parsing, persistence, failure handling, and Pi integration against the cited response schemas. They cannot verify a provider's current authentication service, account permissions, or private API availability. OpenAI Codex Legacy has also passed a separate live quota check in disposable Pi. The newer `openai` OAuth login is outside the supported Codex subscription path.
