import test from "node:test";
import assert from "node:assert/strict";
import quotaStatusExtension from "../src/index.js";
import type {
	PiAfterProviderResponseEvent,
	PiCommandDefinition,
	PiContext,
	PiExtensionAPI,
	PiModelSelectEvent,
} from "../src/pi-types.js";
import {
	extractChatGPTAccountId,
	fetchOpenAICodexQuota,
	fetchSubscriptionQuota,
	parseAnthropicUsage,
	parseOpenAICodexUsage,
} from "../src/subscription.js";

test("extension registers expected events and /quota command", () => {
	const events: string[] = [];
	const commands = new Map<string, PiCommandDefinition>();
	const pi: PiExtensionAPI = {
		on(event: string) {
			events.push(event);
		},
		registerCommand(name: string, definition: PiCommandDefinition) {
			commands.set(name, definition);
		},
		sendMessage() {
			// no-op
		},
	};
	quotaStatusExtension(pi);
	assert.deepEqual(events, [
		"session_start",
		"session_shutdown",
		"model_select",
		"after_provider_response",
	]);
	assert.ok(commands.has("quota"));
});

test("/quota status is accepted as table alias", async () => {
	const commands = new Map<string, PiCommandDefinition>();
	const messages: string[] = [];
	const notifications: string[] = [];
	const pi: PiExtensionAPI = {
		on() {
			// no-op
		},
		registerCommand(name: string, definition: PiCommandDefinition) {
			commands.set(name, definition);
		},
		sendMessage(message) {
			messages.push(message.content);
		},
	};
	quotaStatusExtension(pi);

	await commands.get("quota")?.handler("status", {
		ui: {
			theme: { fg: (_color, text) => text },
			notify(message) {
				notifications.push(message);
			},
			setStatus() {
				// no-op
			},
		},
		modelRegistry: {},
		hasUI: true,
		mode: "tui",
	});

	assert.deepEqual(notifications, []);
	assert.deepEqual(messages, ["No tracked quota data yet."]);
});

test("/quota status explains subscription quota unavailability", async () => {
	const commands = new Map<string, PiCommandDefinition>();
	const messages: string[] = [];
	const model = { provider: "openai-codex", id: "gpt-5.5" };
	const pi: PiExtensionAPI = {
		on() {
			// no-op
		},
		registerCommand(name: string, definition: PiCommandDefinition) {
			commands.set(name, definition);
		},
		sendMessage(message) {
			messages.push(message.content);
		},
	};
	quotaStatusExtension(pi);

	await commands.get("quota")?.handler("status", {
		ui: {
			theme: { fg: (_color, text) => text },
			notify() {
				// no-op
			},
			setStatus() {
				// no-op
			},
		},
		model,
		modelRegistry: {
			isUsingOAuth(candidate) {
				return candidate === model;
			},
		},
		hasUI: true,
		mode: "tui",
		getContextUsage() {
			return { tokens: 12_784, contextWindow: 272_000, percent: 4.7 };
		},
	});

	assert.ok(/No provider quota data/.test(messages[0] ?? ""));
	assert.ok(/Context usage: 4\.7%\/272k/.test(messages[0] ?? ""));
});

test("custom key models clear extension status", async () => {
	type CapturedHandler = (
		event: unknown,
		ctx: PiContext,
	) => void | Promise<void>;
	const handlers = new Map<string, CapturedHandler>();
	const statuses: Array<string | undefined> = [];
	const model = { provider: "openai", id: "gpt-5.5" };
	const pi = {
		on(event: string, handler: unknown) {
			handlers.set(event, handler as CapturedHandler);
		},
		registerCommand() {
			// no-op
		},
		sendMessage() {
			// no-op
		},
	} as PiExtensionAPI;
	quotaStatusExtension(pi);

	const ctx: PiContext = {
		ui: {
			theme: { fg: (_color, text) => text },
			notify() {
				// no-op
			},
			setStatus(_key, text) {
				statuses.push(text);
			},
		},
		model,
		modelRegistry: {
			isUsingOAuth() {
				return false;
			},
		},
		hasUI: true,
		mode: "tui",
	};

	await handlers.get("model_select")?.(
		{ model, source: "set" } satisfies PiModelSelectEvent,
		ctx,
	);
	await handlers.get("after_provider_response")?.(
		{
			status: 200,
			headers: {
				"x-ratelimit-limit-requests": "100",
				"x-ratelimit-remaining-requests": "72",
			},
		} satisfies PiAfterProviderResponseEvent,
		ctx,
	);

	assert.deepEqual(statuses, [undefined, undefined]);
});

test("OpenAI Codex subscription usage parses quota windows", () => {
	const parsed = parseOpenAICodexUsage(
		{
			rate_limit: {
				primary_window: {
					used_percent: 28,
					reset_at: 1_767_200_400,
				},
				secondary_window: {
					used_percent: 65,
					reset_at: 1_767_805_200,
				},
			},
		},
		Date.UTC(2026, 0, 1, 0, 0, 0),
	);

	assert.equal(parsed?.dimensions.length, 2);
	assert.equal(parsed?.dimensions[0]?.name, "5h");
	assert.equal(parsed?.dimensions[0]?.limit, 100);
	assert.equal(parsed?.dimensions[0]?.remaining, 72);
	assert.equal(parsed?.dimensions[0]?.resetAt, 1_767_200_400_000);
	assert.equal(parsed?.dimensions[1]?.name, "weekly");
	assert.equal(parsed?.dimensions[1]?.remaining, 35);
});

test("OpenAI Codex subscription usage parses block metadata and extra limits", () => {
	const parsed = parseOpenAICodexUsage(
		{
			rate_limit: {
				allowed: false,
				limit_reached: true,
				primary_window: {
					used_percent: 100,
					reset_at: 1_767_200_400,
				},
			},
			rate_limit_reached_type: "primary",
			additional_rate_limits: [
				{
					id: "GPT-5.3-Codex-Spark",
					used_percent: 12,
					reset_at: 1_767_200_500,
				},
			],
		},
		Date.UTC(2026, 0, 1, 0, 0, 0),
		{ accountHeaderSent: true },
	);

	assert.equal(parsed?.metadata?.accountHeaderSent, true);
	assert.equal(parsed?.metadata?.allowed, false);
	assert.equal(parsed?.metadata?.limitReached, true);
	assert.equal(parsed?.metadata?.rateLimitReachedType, "primary");
	assert.equal(parsed?.metadata?.extraLimits?.[0]?.name, "GPT-5.3-Codex-Spark");
	assert.equal(parsed?.metadata?.extraLimits?.[0]?.remaining, 88);
});

test("OpenAI Codex account id is extracted from OAuth JWT", () => {
	assert.equal(
		extractChatGPTAccountId(
			"header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF8xMjMifX0.sig",
		),
		"acct_123",
	);
	assert.equal(extractChatGPTAccountId("not-a-jwt"), undefined);
});

test("Anthropic subscription usage parses quota windows", () => {
	const parsed = parseAnthropicUsage(
		{
			five_hour: {
				utilization: 22,
				resets_at: "2026-01-01T05:00:00Z",
			},
			seven_day: {
				utilization: 60,
				resets_at: "2026-01-05T08:00:00Z",
			},
			seven_day_sonnet: {
				utilization: 0.8,
				resets_at: "2026-01-04T08:00:00Z",
			},
		},
		Date.UTC(2026, 0, 1, 0, 0, 0),
	);

	assert.equal(parsed?.dimensions.length, 3);
	assert.equal(parsed?.dimensions[0]?.name, "5h");
	assert.equal(parsed?.dimensions[0]?.remaining, 78);
	assert.equal(parsed?.dimensions[0]?.resetAt, Date.UTC(2026, 0, 1, 5, 0, 0));
	assert.equal(parsed?.dimensions[2]?.name, "weekly_sonnet");
	assert.equal(parsed?.dimensions[2]?.remaining, 20);
});

test("subscription quota fetch uses Pi OAuth token for OpenAI Codex", async () => {
	type FetchLike = (
		input: string,
		init?: { headers?: Record<string, string>; signal?: unknown },
	) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
	const globalWithFetch = globalThis as unknown as { fetch: FetchLike };
	const originalFetch = globalWithFetch.fetch;
	let requestedUrl = "";
	let authorization = "";
	globalWithFetch.fetch = async (input, init) => {
		requestedUrl = input;
		authorization = init?.headers?.authorization ?? "";
		return {
			ok: true,
			status: 200,
			async json() {
				return {
					rate_limit: {
						primary_window: {
							used_percent: 40,
							reset_after_seconds: 300,
						},
					},
				};
			},
		};
	};
	try {
		const parsed = await fetchSubscriptionQuota(
			{
				ui: {
					theme: { fg: (_color, text) => text },
					notify() {
						// no-op
					},
					setStatus() {
						// no-op
					},
				},
				modelRegistry: {
					async getApiKeyForProvider(provider) {
						assert.equal(provider, "openai-codex");
						return "oauth-token";
					},
				},
				hasUI: true,
				mode: "tui",
			},
			{ provider: "openai-codex", model: "gpt-5.5" },
			Date.UTC(2026, 0, 1, 0, 0, 0),
		);

		assert.equal(requestedUrl, "https://chatgpt.com/backend-api/wham/usage");
		assert.equal(authorization, "Bearer oauth-token");
		assert.equal(parsed?.dimensions[0]?.remaining, 60);
		assert.equal(parsed?.dimensions[0]?.resetAt, Date.UTC(2026, 0, 1, 0, 5, 0));
	} finally {
		globalWithFetch.fetch = originalFetch;
	}
});

test("OpenAI Codex healthy zero uses CLI RPC fallback when available", async () => {
	type FetchLike = (
		input: string,
		init?: { headers?: Record<string, string>; signal?: unknown },
	) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
	const globalWithFetch = globalThis as unknown as { fetch: FetchLike };
	const originalFetch = globalWithFetch.fetch;
	globalWithFetch.fetch = async () => ({
		ok: true,
		status: 200,
		async json() {
			return {
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: {
						used_percent: 100,
						reset_at: 1_767_218_000,
					},
					secondary_window: {
						used_percent: 35,
						reset_at: 1_767_805_200,
					},
				},
			};
		},
	});
	try {
		const parsed = await fetchOpenAICodexQuota(
			"oauth-token",
			Date.UTC(2026, 0, 1, 0, 0, 0),
			{
				async fetchCliRateLimits() {
					return {
						dimensions: [
							{
								name: "5h",
								limit: 100,
								remaining: 91,
								resetAt: 1_767_217_391_000,
							},
							{
								name: "weekly",
								limit: 100,
								remaining: 64,
								resetAt: 1_767_805_246_000,
							},
						],
					};
				},
			},
		);

		assert.equal(parsed?.dimensions[0]?.name, "5h");
		assert.equal(parsed?.dimensions[0]?.remaining, 91);
		assert.equal(parsed?.dimensions[1]?.name, "weekly");
		assert.equal(parsed?.dimensions[1]?.remaining, 64);
		assert.equal(parsed?.metadata?.codexCliRpcFallback, true);
	} finally {
		globalWithFetch.fetch = originalFetch;
	}
});

test("subscription quota fetch sends ChatGPT account header when OAuth JWT contains it", async () => {
	type FetchLike = (
		input: string,
		init?: { headers?: Record<string, string>; signal?: unknown },
	) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
	const globalWithFetch = globalThis as unknown as { fetch: FetchLike };
	const originalFetch = globalWithFetch.fetch;
	let accountHeader = "";
	globalWithFetch.fetch = async (_input, init) => {
		accountHeader = init?.headers?.["ChatGPT-Account-Id"] ?? "";
		return {
			ok: true,
			status: 200,
			async json() {
				return {
					rate_limit: {
						primary_window: {
							used_percent: 40,
							reset_after_seconds: 300,
						},
					},
				};
			},
		};
	};
	try {
		await fetchSubscriptionQuota(
			{
				ui: {
					theme: { fg: (_color, text) => text },
					notify() {
						// no-op
					},
					setStatus() {
						// no-op
					},
				},
				modelRegistry: {
					async getApiKeyForProvider() {
						return "header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF8xMjMifX0.sig";
					},
				},
				hasUI: true,
				mode: "tui",
			},
			{ provider: "openai-codex", model: "gpt-5.5" },
			Date.UTC(2026, 0, 1, 0, 0, 0),
		);

		assert.equal(accountHeader, "acct_123");
	} finally {
		globalWithFetch.fetch = originalFetch;
	}
});

test("subscription quota fetch uses Pi OAuth token for Anthropic", async () => {
	type FetchLike = (
		input: string,
		init?: { headers?: Record<string, string>; signal?: unknown },
	) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
	const globalWithFetch = globalThis as unknown as { fetch: FetchLike };
	const originalFetch = globalWithFetch.fetch;
	let requestedUrl = "";
	let authorization = "";
	let beta = "";
	globalWithFetch.fetch = async (input, init) => {
		requestedUrl = input;
		authorization = init?.headers?.authorization ?? "";
		beta = init?.headers?.["anthropic-beta"] ?? "";
		return {
			ok: true,
			status: 200,
			async json() {
				return {
					five_hour: {
						utilization: 0.25,
						resets_at: "2026-01-01T01:00:00Z",
					},
				};
			},
		};
	};
	try {
		const parsed = await fetchSubscriptionQuota(
			{
				ui: {
					theme: { fg: (_color, text) => text },
					notify() {
						// no-op
					},
					setStatus() {
						// no-op
					},
				},
				modelRegistry: {
					async getApiKeyForProvider(provider) {
						assert.equal(provider, "anthropic");
						return "oauth-token";
					},
				},
				hasUI: true,
				mode: "tui",
			},
			{ provider: "anthropic", model: "claude-sonnet-4" },
			Date.UTC(2026, 0, 1, 0, 0, 0),
		);

		assert.equal(requestedUrl, "https://api.anthropic.com/api/oauth/usage");
		assert.equal(authorization, "Bearer oauth-token");
		assert.equal(beta, "oauth-2025-04-20");
		assert.equal(parsed?.dimensions[0]?.remaining, 75);
	} finally {
		globalWithFetch.fetch = originalFetch;
	}
});
