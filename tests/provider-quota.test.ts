import test from "node:test";
import assert from "node:assert/strict";
import {
	fetchProviderQuota,
	getProviderQuotaPollerName,
	parseAntigravityModels,
	parseCommandCodeCredits,
	parseDeepSeekBalance,
	parseFireworksSummary,
	parseGroqMetric,
	parseHuggingFaceGpuQuota,
	parseHuggingFaceUsage,
	parseKimiUsage,
	parseMiniMaxUsage,
	parseMoonshotBalance,
	parseOpenCodeGoUsage,
	parseOpenAICreditGrants,
	parseOpenRouterKey,
	parseXaiSubscriptionBilling,
	parseZaiQuota,
} from "../src/provider-quota.js";
import type { PiContext, PiModel } from "../src/pi-types.js";

test("native provider registry exposes supported Pi provider pollers", () => {
	assert.equal(getProviderQuotaPollerName("antigravity"), "antigravity");
	assert.equal(getProviderQuotaPollerName("commandcode"), "commandcode");
	assert.equal(getProviderQuotaPollerName("deepseek"), "deepseek");
	assert.equal(getProviderQuotaPollerName("fireworks"), "fireworks");
	assert.equal(getProviderQuotaPollerName("groq"), "groq");
	assert.equal(getProviderQuotaPollerName("huggingface"), "huggingface");
	assert.equal(getProviderQuotaPollerName("moonshotai"), "moonshot");
	assert.equal(getProviderQuotaPollerName("moonshotai-cn"), "moonshot");
	assert.equal(getProviderQuotaPollerName("kimi-coding"), "kimi");
	assert.equal(getProviderQuotaPollerName("minimax"), "minimax");
	assert.equal(getProviderQuotaPollerName("minimax-cn"), "minimax");
	assert.equal(getProviderQuotaPollerName("opencode-go"), "opencode-go");
	assert.equal(getProviderQuotaPollerName("openai"), "openai");
	assert.equal(getProviderQuotaPollerName("openrouter"), "openrouter");
	assert.equal(getProviderQuotaPollerName("xai"), "xai");
	assert.equal(getProviderQuotaPollerName("zai"), "zai");
	assert.equal(getProviderQuotaPollerName("zai-coding-cn"), "zai");
});

test("Antigravity model quota uses the active runtime model", () => {
	const parsed = parseAntigravityModels(
		{
			models: {
				"gemini-3.8-flash-low": {
					quotaInfo: { remainingFraction: 0.8 },
				},
				"gemini-3.8-flash-medium": {
					quotaInfo: {
						remainingFraction: 0.42,
						resetTime: "2026-09-23T13:00:00Z",
					},
				},
			},
		},
		"gemini-3.8-flash",
		"gemini-3.8-flash-medium",
	);

	assert.deepEqual(parsed?.dimensions, [
		{
			name: "quota",
			limit: 100,
			remaining: 42,
			resetAt: Date.parse("2026-09-23T13:00:00Z"),
		},
	]);
});

test("Antigravity model quota falls back to the most constrained model pool", () => {
	const parsed = parseAntigravityModels(
		{
			models: {
				"gemini-3.8-flash-low": {
					quotaInfo: { remainingFraction: 0.75 },
				},
				"gemini-3.8-flash-high": {
					quotaInfo: { remainingFraction: 0.6 },
				},
			},
		},
		"gemini-3.8-flash",
	);
	assert.equal(parsed?.dimensions[0]?.remaining, 60);
});

test("Command Code window limits become 5h and weekly quota dimensions", () => {
	const parsed = parseCommandCodeCredits({
		credits: {
			monthlyCredits: 100,
			purchasedCredits: 0,
			freeCredits: 0,
		},
		windowLimits: {
			fiveHour: {
				used: 25,
				cap: 100,
				resetAt: 1_797_000_000,
			},
			weekly: {
				used: 60,
				cap: 200,
				resetAt: "2026-09-30T12:00:00Z",
			},
		},
	});

	assert.deepEqual(parsed?.dimensions, [
		{
			name: "5h",
			limit: 100,
			remaining: 75,
			resetAt: 1_797_000_000_000,
		},
		{
			name: "weekly",
			limit: 200,
			remaining: 140,
			resetAt: Date.parse("2026-09-30T12:00:00Z"),
		},
	]);
});

test("DeepSeek balance prefers a funded USD wallet", () => {
	const parsed = parseDeepSeekBalance({
		is_available: true,
		balance_infos: [
			{ currency: "CNY", total_balance: "88.50" },
			{ currency: "USD", total_balance: "12.25" },
		],
	});
	assert.deepEqual(parsed, {
		dimensions: [],
		metrics: [{ name: "balance", value: 12.25, unit: "USD" }],
	});
});

test("Fireworks billing summary becomes a 30-day spend metric", () => {
	const parsed = parseFireworksSummary({
		lineItems: [
			{ totalCost: { units: "12", nanos: 250_000_000, currencyCode: "USD" } },
			{ totalCost: { units: "1", nanos: 500_000_000, currencyCode: "USD" } },
		],
	});
	assert.deepEqual(parsed, {
		dimensions: [],
		metrics: [{ name: "spend", value: 13.75, unit: "USD" }],
	});
});

test("Groq Prometheus scalar sums series samples", () => {
	assert.equal(
		parseGroqMetric({
			status: "success",
			data: { result: [{ value: [1_797_000_000, "1.5"] }, { value: [1_797_000_000, 2] }] },
		}),
		3.5,
	);
});

test("Hugging Face billing maps monthly spend limit and ZeroGPU quota", () => {
	const parsed = parseHuggingFaceUsage({
		usage: {
			inferenceProviders: {
				usedNanoUsd: 9_000_000_000,
				includedNanoUsd: 1_000_000_000,
				limitNanoUsd: 20_000_000_000,
			},
		},
	});
	assert.deepEqual(parsed, {
		dimensions: [{ name: "monthly", limit: 20, remaining: 12 }],
		metrics: [{ name: "spend", value: 8, unit: "USD" }],
	});
	assert.deepEqual(
		parseHuggingFaceGpuQuota({ base: 3600, current: 900, resetsAt: 1_797_000_000 }),
		{ name: "gpu", limit: 3600, remaining: 900, resetAt: 1_797_000_000_000 },
	);
});

test("OpenAI credit grants become a credit quota with the next grant expiry", () => {
	const now = Date.UTC(2026, 8, 23, 12, 0, 0);
	const future = Math.floor(Date.UTC(2026, 9, 1) / 1000);
	const parsed = parseOpenAICreditGrants(
		{
			total_granted: 100,
			total_used: 30,
			total_available: 70,
			grants: { data: [{ expires_at: future }] },
		},
		now,
	);
	assert.deepEqual(parsed?.dimensions, [
		{
			name: "credits",
			limit: 100,
			remaining: 70,
			resetAt: future * 1000,
		},
	]);
});

test("Moonshot balance becomes a provider metric", () => {
	const parsed = parseMoonshotBalance(
		{
			code: 0,
			scode: "0",
			status: true,
			data: { available_balance: 32.5, cash_balance: 30, voucher_balance: 2.5 },
		},
		"CNY",
	);
	assert.deepEqual(parsed, {
		dimensions: [],
		metrics: [{ name: "balance", value: 32.5, unit: "CNY" }],
	});
});

test("Kimi usage maps 5h, weekly, and monthly pools", () => {
	const parsed = parseKimiUsage({
		usages: {
			limit_5h: { used_ratio: 0.22, reset_time: "2026-09-23T18:00:00Z" },
			limit_7d: { used_ratio: 0.8, reset_time: "2026-09-28T00:00:00Z" },
			limit_month_total: { used_ratio: 0.5, reset_time: "2026-10-01T00:00:00Z" },
		},
	});

	assert.deepEqual(
		parsed?.dimensions.map((dimension) => [dimension.name, dimension.remaining]),
		[
			["5h", 78],
			["weekly", 20],
			["monthly", 50],
		],
	);
});

test("Kimi usage supports count-style fallback limits", () => {
	const parsed = parseKimiUsage({
		usage: { limit: 100, used: 25, resetTime: "2026-09-29T00:00:00Z" },
		limits: [
			{
				window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
				detail: { limit: 80, remaining: 20, resetAt: "2026-09-23T18:00:00Z" },
			},
		],
	});

	assert.deepEqual(
		parsed?.dimensions.map((dimension) => [dimension.name, dimension.remaining]),
		[
			["weekly", 75],
			["5h", 20],
		],
	);
});

test("MiniMax token-plan remains uses remaining percentages and count fallbacks", () => {
	const start = Date.parse("2026-09-23T12:00:00Z");
	const end = start + 5 * 60 * 60 * 1000;
	const weeklyEnd = Date.parse("2026-09-29T00:00:00Z");
	const parsed = parseMiniMaxUsage({
		base_resp: { status_code: 0 },
		data: {
			model_remains: [
				{
					model_name: "general",
					current_interval_total_count: 0,
					current_interval_usage_count: 0,
					current_interval_remaining_percent: 96,
					start_time: start,
					end_time: end,
					current_weekly_total_count: 1000,
					current_weekly_usage_count: 250,
					weekly_end_time: weeklyEnd,
				},
			],
		},
	});

	assert.deepEqual(parsed?.dimensions, [
		{ name: "5h", limit: 100, remaining: 96, resetAt: end },
		{ name: "weekly", limit: 1000, remaining: 250, resetAt: weeklyEnd },
	]);
});

test("Z.AI quota maps token, credit, and MCP limits", () => {
	const parsed = parseZaiQuota({
		success: true,
		code: 200,
		data: {
			limits: [
				{ type: "TOKENS_LIMIT", unit: 5, number: 300, percentage: 25 },
				{ type: "CREDIT_LIMIT", unit: 6, number: 1, percentage: 50 },
				{ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 10 },
			],
		},
	});

	assert.deepEqual(
		parsed?.dimensions.map((dimension) => [dimension.name, dimension.remaining]),
		[
			["5h", 75],
			["weekly", 50],
			["mcp", 90],
		],
	);
});

test("OpenCode Go usage becomes 5h, weekly, and monthly quota dimensions", () => {
	const parsed = parseOpenCodeGoUsage({
		usage: {
			rolling: { percent: 17, resetsAt: "2026-09-23T13:00:00Z" },
			weekly: { percent: 75, resetsAt: "2026-09-27T00:00:00Z" },
			monthly: { percent: 91, resetsAt: "2026-10-01T00:00:00Z" },
		},
	});

	assert.deepEqual(parsed?.dimensions, [
		{
			name: "5h",
			limit: 100,
			remaining: 83,
			resetAt: Date.parse("2026-09-23T13:00:00Z"),
		},
		{
			name: "weekly",
			limit: 100,
			remaining: 25,
			resetAt: Date.parse("2026-09-27T00:00:00Z"),
		},
		{
			name: "monthly",
			limit: 100,
			remaining: 9,
			resetAt: Date.parse("2026-10-01T00:00:00Z"),
		},
	]);
});

test("OpenRouter key limit prefers server-reported remaining quota", () => {
	const parsed = parseOpenRouterKey({
		data: {
			limit: 50,
			limit_remaining: 12.5,
			usage: 100,
			usage_weekly: 3,
			limit_reset: "weekly",
		},
	});

	assert.deepEqual(parsed?.dimensions, [
		{
			name: "weekly",
			limit: 50,
			remaining: 12.5,
		},
	]);
});

test("OpenRouter key limit falls back to reset-window usage", () => {
	const parsed = parseOpenRouterKey({
		data: {
			limit: 40,
			usage: 90,
			usage_monthly: 10,
			limit_reset: "monthly",
		},
	});
	assert.equal(parsed?.dimensions[0]?.remaining, 30);
});

test("xAI subscription billing maps weekly credit usage to remaining quota", () => {
	const parsed = parseXaiSubscriptionBilling(
		{
			config: {
				creditUsagePercent: 12.5,
				currentPeriod: {
					start: "2026-08-06T00:00:00Z",
					end: "2026-08-13T00:00:00Z",
				},
			},
		},
		Date.parse("2026-08-12T00:00:00Z"),
	);
	assert.deepEqual(parsed?.dimensions, [
		{
			name: "weekly",
			limit: 100,
			remaining: 87.5,
			resetAt: Date.parse("2026-08-13T00:00:00Z"),
		},
	]);
});

test("xAI subscription billing falls back to on-demand cap and usage", () => {
	const parsed = parseXaiSubscriptionBilling({
		config: {
			onDemandCap: { val: 1000 },
			onDemandUsed: { val: 250.5 },
		},
	});
	assert.equal(parsed?.dimensions[0]?.name, "quota");
	assert.equal(parsed?.dimensions[0]?.remaining, 74.95);
});

test("provider polling uses Pi-resolved Antigravity auth and thinking level", async () => {
	const model: PiModel = {
		id: "gemini-3.8-flash",
		provider: "antigravity",
		thinkingLevelMap: {
			medium: "gemini-3.8-flash-medium",
		},
	};
	let requestedUrl = "";
	let authorization = "";
	let body = "";
	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		requestedUrl = String(input);
		authorization = new Headers(init?.headers).get("authorization") ?? "";
		body = String(init?.body ?? "");
		return new Response(
			JSON.stringify({
				models: {
					"gemini-3.8-flash-medium": {
						quotaInfo: { remainingFraction: 0.55 },
					},
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	const ctx = contextFor(model, {
		async getApiKeyAndHeaders() {
			return {
				ok: true,
				apiKey: JSON.stringify({ token: "ag-token", projectId: "project-123" }),
			};
		},
	});
	ctx.thinkingLevel = "medium";

	const result = await fetchProviderQuota(
		ctx,
		{ provider: "antigravity", model: model.id },
		Date.UTC(2026, 8, 23, 12, 0, 0),
		fetchImpl,
	);

	assert.equal(
		requestedUrl,
		"https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
	);
	assert.equal(authorization, "Bearer ag-token");
	assert.deepEqual(JSON.parse(body), { project: "project-123" });
	assert.equal(result?.parsed.dimensions[0]?.remaining, 55);
});

test("provider polling uses Pi-resolved Command Code auth", async () => {
	const model: PiModel = {
		id: "meta/muse-spark-1.3-contributor",
		provider: "commandcode",
	};
	const requested: string[] = [];
	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		const url = String(input);
		requested.push(url);
		assert.equal(
			new Headers(init?.headers).get("authorization"),
			"Bearer cc-token",
		);
		if (url.endsWith("/alpha/whoami")) {
			return Response.json({ org: { login: "team", id: "org-123" } });
		}
		return Response.json({
			credits: { monthlyCredits: 50, purchasedCredits: 0, freeCredits: 0 },
			windowLimits: {
				fiveHour: { used: 10, cap: 100, resetAt: 1_797_000_000 },
				weekly: { used: 40, cap: 100, resetAt: 1_797_500_000 },
			},
		});
	};
	const ctx = contextFor(model, {
		async getApiKeyAndHeaders() {
			return {
				ok: true,
				apiKey: "cc-token",
				baseUrl: "https://api.commandcode.ai/provider/v1",
			};
		},
	});

	const result = await fetchProviderQuota(
		ctx,
		{ provider: "commandcode", model: model.id },
		Date.UTC(2026, 8, 23, 12, 0, 0),
		fetchImpl,
	);

	assert.deepEqual(requested, [
		"https://api.commandcode.ai/alpha/whoami",
		"https://api.commandcode.ai/alpha/billing/credits?orgId=org-123",
	]);
	assert.deepEqual(
		result?.parsed.dimensions.map((dimension) => dimension.remaining),
		[90, 60],
	);
});

test("provider polling uses Pi-resolved OpenCode Go API key", async () => {
	const model: PiModel = {
		id: "gpt-5.6-luna",
		provider: "opencode-go",
	};
	let requestedUrl = "";
	let authorization = "";
	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		requestedUrl = String(input);
		authorization = new Headers(init?.headers).get("authorization") ?? "";
		return Response.json({
			usage: {
				rolling: { percent: 12, resetsAt: "2026-09-23T15:00:00Z" },
				weekly: { percent: 40, resetsAt: "2026-09-29T00:00:00Z" },
			},
		});
	};
	const ctx = contextFor(model, {
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "oc-go-token" };
		},
	});

	const result = await fetchProviderQuota(
		ctx,
		{ provider: "opencode-go", model: model.id },
		Date.UTC(2026, 8, 23, 12, 0, 0),
		fetchImpl,
	);

	assert.equal(requestedUrl, "https://opencode.ai/zen/go/v1/usage");
	assert.equal(authorization, "Bearer oc-go-token");
	assert.deepEqual(
		result?.parsed.dimensions.map((dimension) => dimension.remaining),
		[88, 60],
	);
});

test("provider polling uses Pi-resolved Fireworks key and account slug", async () => {
	const model: PiModel = { id: "accounts/acme/models/test", provider: "fireworks" };
	let requestedUrl = "";
	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		requestedUrl = String(input);
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fw-token");
		return Response.json({
			lineItems: [{ totalCost: { units: "4", nanos: 0, currencyCode: "USD" } }],
		});
	};
	const ctx = contextFor(model, {
		async getApiKeyAndHeaders() {
			return {
				ok: true,
				apiKey: "fw-token",
				baseUrl: "https://api.fireworks.ai/inference",
				env: { FIREWORKS_ACCOUNT_SLUG: "acme" },
			};
		},
	});

	const result = await fetchProviderQuota(
		ctx,
		{ provider: model.provider, model: model.id },
		Date.UTC(2026, 8, 23, 12, 0, 0),
		fetchImpl,
	);

	assert.ok(
		/^https:\/\/api\.fireworks\.ai\/v1\/accounts\/acme\/billing\/summary\?/u.test(
			requestedUrl,
		),
	);
	assert.equal(result?.parsed.metrics?.[0]?.value, 4);
});

test("provider polling reads Groq five-minute request and token rates", async () => {
	const model: PiModel = { id: "llama-test", provider: "groq" };
	const requested: string[] = [];
	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		requested.push(String(input));
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer groq-token");
		return Response.json({ status: "success", data: { result: [{ value: [1, "2"] }] } });
	};
	const ctx = contextFor(model, {
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "groq-token", baseUrl: "https://api.groq.com/openai/v1" };
		},
	});

	const result = await fetchProviderQuota(
		ctx,
		{ provider: model.provider, model: model.id },
		Date.now(),
		fetchImpl,
	);

	assert.equal(requested.length, 3);
	assert.ok(requested.every((url) => url.startsWith("https://api.groq.com/v1/metrics/prometheus/api/v1/query?")));
	assert.deepEqual(result?.parsed.metrics, [
		{ name: "requests", value: 120, unit: "req/min" },
		{ name: "tokens", value: 240, unit: "tok/min" },
	]);
});

test("provider polling reads Hugging Face monthly limit and ZeroGPU quota", async () => {
	const model: PiModel = { id: "openai/test", provider: "huggingface" };
	const requested: string[] = [];
	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		const url = String(input);
		requested.push(url);
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer hf-token");
		if (url.includes("/billing/usage-v2")) {
			return Response.json({
				usage: {
					inferenceProviders: {
						usedNanoUsd: 5_000_000_000,
						includedNanoUsd: 0,
						limitNanoUsd: 10_000_000_000,
					},
				},
			});
		}
		return Response.json({ base: 100, current: 80 });
	};
	const ctx = contextFor(model, {
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "hf-token", baseUrl: "https://router.huggingface.co/v1" };
		},
	});

	const result = await fetchProviderQuota(
		ctx,
		{ provider: model.provider, model: model.id },
		Date.UTC(2026, 8, 23, 12, 0, 0),
		fetchImpl,
	);

	assert.equal(requested.length, 2);
	assert.ok(
		/^https:\/\/huggingface\.co\/api\/settings\/billing\/usage-v2\?/u.test(
			requested[0] ?? "",
		),
	);
	assert.equal(requested[1], "https://huggingface.co/api/spaces/zero-gpu/quota");
	assert.deepEqual(result?.parsed.dimensions.map((dimension) => dimension.remaining), [5, 80]);
});

test("provider polling treats OpenAI credit-grant access as best-effort", async () => {
	const model: PiModel = { id: "gpt-5.6-luna", provider: "openai" };
	let requestedUrl = "";
	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		requestedUrl = String(input);
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer openai-token");
		return Response.json({ total_granted: 20, total_used: 5, total_available: 15 });
	};
	const ctx = contextFor(model, {
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "openai-token", baseUrl: "https://api.openai.com/v1" };
		},
	});

	const result = await fetchProviderQuota(
		ctx,
		{ provider: model.provider, model: model.id },
		Date.now(),
		fetchImpl,
	);

	assert.equal(requestedUrl, "https://api.openai.com/v1/dashboard/billing/credit_grants");
	assert.equal(result?.parsed.dimensions[0]?.remaining, 15);
});

test("provider polling derives Kimi usage endpoint from Pi base URL", async () => {
	const model: PiModel = { id: "kimi-for-coding", provider: "kimi-coding" };
	let requestedUrl = "";
	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		requestedUrl = String(input);
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer kimi-token");
		return Response.json({ usages: { limit_5h: { used_ratio: 0.1 } } });
	};
	const ctx = contextFor(model, {
		async getApiKeyAndHeaders() {
			return {
				ok: true,
				apiKey: "kimi-token",
				baseUrl: "https://api.kimi.com/coding/v1",
			};
		},
	});

	const result = await fetchProviderQuota(
		ctx,
		{ provider: model.provider, model: model.id },
		Date.now(),
		fetchImpl,
	);

	assert.equal(requestedUrl, "https://api.kimi.com/coding/v1/usages");
	assert.equal(result?.parsed.dimensions[0]?.remaining, 90);
});

test("provider polling uses MiniMax token-plan endpoint then legacy fallback", async () => {
	const model: PiModel = { id: "MiniMax-M2.5", provider: "minimax-cn" };
	const requested: string[] = [];
	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		const url = String(input);
		requested.push(url);
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("authorization"), "Bearer minimax-token");
		assert.equal(headers.get("mm-api-source"), "pi-quota-status");
		if (url.endsWith("/v1/token_plan/remains")) return new Response("{}", { status: 404 });
		return Response.json({
			base_resp: { status_code: 0 },
			model_remains: [
				{
					current_interval_total_count: 1000,
					current_interval_usage_count: 400,
				},
			],
		});
	};
	const ctx = contextFor(model, {
		async getApiKeyAndHeaders() {
			return {
				ok: true,
				apiKey: "minimax-token",
				baseUrl: "https://api.minimaxi.com/anthropic",
			};
		},
	});

	const result = await fetchProviderQuota(
		ctx,
		{ provider: model.provider, model: model.id },
		Date.now(),
		fetchImpl,
	);

	assert.deepEqual(requested, [
		"https://api.minimaxi.com/v1/token_plan/remains",
		"https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
	]);
	assert.equal(result?.parsed.dimensions[0]?.remaining, 400);
});

test("provider polling derives Z.AI global and CN origins from Pi base URLs", async () => {
	for (const scenario of [
		{
			provider: "zai",
			baseUrl: "https://api.z.ai/api/paas/v4",
			expected: "https://api.z.ai/api/monitor/usage/quota/limit",
		},
		{
			provider: "zai-coding-cn",
			baseUrl: "https://open.bigmodel.cn/api/paas/v4",
			expected: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
		},
	] as const) {
		const model: PiModel = { id: "glm-5", provider: scenario.provider };
		let requestedUrl = "";
		const fetchImpl: typeof globalThis.fetch = async (input) => {
			requestedUrl = String(input);
			return Response.json({
				success: true,
				code: 200,
				data: { limits: [{ type: "TOKENS_LIMIT", unit: 5, number: 300, percentage: 40 }] },
			});
		};
		const ctx = contextFor(model, {
			async getApiKeyAndHeaders() {
				return { ok: true, apiKey: "zai-token", baseUrl: scenario.baseUrl };
			},
		});

		await fetchProviderQuota(
			ctx,
			{ provider: model.provider, model: model.id },
			Date.now(),
			fetchImpl,
		);
		assert.equal(requestedUrl, scenario.expected);
	}
});

test("provider polling uses Pi-resolved OpenRouter API key", async () => {
	const model: PiModel = {
		id: "openai/gpt-5.6-luna",
		provider: "openrouter",
	};
	let requestedUrl = "";
	let authorization = "";
	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		requestedUrl = String(input);
		authorization = new Headers(init?.headers).get("authorization") ?? "";
		return Response.json({
			data: { limit: 25, limit_remaining: 20, limit_reset: "monthly" },
		});
	};
	const ctx = contextFor(model, {
		async getApiKeyAndHeaders() {
			return {
				ok: true,
				apiKey: "or-token",
				baseUrl: "https://openrouter.ai/api/v1",
			};
		},
	});

	const result = await fetchProviderQuota(
		ctx,
		{ provider: "openrouter", model: model.id },
		Date.UTC(2026, 8, 23, 12, 0, 0),
		fetchImpl,
	);

	assert.equal(requestedUrl, "https://openrouter.ai/api/v1/key");
	assert.equal(authorization, "Bearer or-token");
	assert.equal(result?.parsed.dimensions[0]?.remaining, 20);
});

test("provider polling uses Pi xAI OAuth credential for subscription billing", async () => {
	const model: PiModel = { id: "grok-4.6", provider: "xai" };
	let requestedUrl = "";
	let authorization = "";
	let tokenAuth = "";
	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		requestedUrl = String(input);
		const headers = new Headers(init?.headers);
		authorization = headers.get("authorization") ?? "";
		tokenAuth = headers.get("x-xai-token-auth") ?? "";
		return Response.json({
			config: {
				creditUsagePercent: 25,
				billingPeriodStart: "2026-08-01T00:00:00Z",
				billingPeriodEnd: "2026-09-01T00:00:00Z",
			},
		});
	};
	const ctx = contextFor(model, {
		isUsingOAuth: () => true,
		async getApiKeyAndHeaders() {
			return {
				ok: true,
				apiKey: "oauth-test-value",
				baseUrl: "https://api.x.ai/v1",
			};
		},
	});

	const result = await fetchProviderQuota(
		ctx,
		{ provider: model.provider, model: model.id },
		Date.parse("2026-08-23T12:00:00Z"),
		fetchImpl,
	);

	assert.equal(
		requestedUrl,
		"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
	);
	assert.equal(authorization, "Bearer oauth-test-value");
	assert.equal(tokenAuth, "xai-grok-cli");
	assert.equal(result?.parsed.dimensions[0]?.name, "monthly");
	assert.equal(result?.parsed.dimensions[0]?.remaining, 75);
});

test("provider polling skips xAI subscription billing without OAuth", async () => {
	const model: PiModel = { id: "grok-4.6", provider: "xai" };
	let calls = 0;
	const ctx = contextFor(model, {
		isUsingOAuth: () => false,
		async getApiKeyAndHeaders() {
			return { ok: true, apiKey: "regular-test-value" };
		},
	});
	const result = await fetchProviderQuota(
		ctx,
		{ provider: model.provider, model: model.id },
		Date.now(),
		async () => {
			calls += 1;
			return Response.json({});
		},
	);
	assert.equal(result, undefined);
	assert.equal(calls, 0);
});

function contextFor(
	model: PiModel,
	modelRegistry: PiContext["modelRegistry"],
): PiContext {
	return {
		ui: {
			theme: { fg: (_color, text) => text },
			notify() {},
			setStatus() {},
		},
		model,
		modelRegistry: {
			find: () => model,
			...modelRegistry,
		},
		hasUI: true,
		mode: "tui",
	};
}
