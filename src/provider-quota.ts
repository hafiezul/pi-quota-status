import { clampPercent } from "./format.js";
import {
	asRecord,
	numberValue,
	stringValue,
	timestampValue,
} from "./parse-utils.js";
import type { PiContext, PiModel, PiProviderHeaders } from "./pi-types.js";
import type {
	ModelRef,
	ParsedQuotaDimension,
	ParsedQuotaObservation,
} from "./types.js";

const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com",
] as const;
const ANTIGRAVITY_USER_AGENT =
	"antigravity/cli/1.1.23 (aidev_client; os_type=linux; arch=amd64; cl=974125021; auth_method=consumer)";
const COMMAND_CODE_API_BASE = "https://api.commandcode.ai";
const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const FIREWORKS_API_ORIGIN = "https://api.fireworks.ai";
const HUGGINGFACE_ORIGIN = "https://huggingface.co";
const MINIMAX_GLOBAL_ORIGIN = "https://api.minimax.io";
const MINIMAX_CN_ORIGIN = "https://api.minimaxi.com";
const OPENAI_CREDIT_GRANTS_URL =
	"https://api.openai.com/v1/dashboard/billing/credit_grants";
const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const XAI_BILLING_URL =
	"https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const REQUEST_TIMEOUT_MS = 10_000;

type ProviderCredentialKind = "oauth" | "other";

interface ProviderQuotaAuth {
	apiKey?: string;
	headers: Record<string, string>;
	baseUrl?: string;
	env: Record<string, string>;
}

interface ProviderQuotaPollArgs {
	ref: ModelRef;
	model?: PiModel;
	thinkingLevel?: string;
	auth: ProviderQuotaAuth;
	credentialKind: ProviderCredentialKind;
	now: number;
	fetchImpl: typeof globalThis.fetch;
}

interface ProviderQuotaPoller {
	name: string;
	poll(args: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined>;
}

export interface ProviderQuotaFetchResult {
	poller: string;
	parsed: ParsedQuotaObservation;
}

const PROVIDER_QUOTA_POLLERS: Record<string, ProviderQuotaPoller> = {
	antigravity: {
		name: "antigravity",
		poll: fetchAntigravityQuota,
	},
	commandcode: {
		name: "commandcode",
		poll: fetchCommandCodeQuota,
	},
	deepseek: {
		name: "deepseek",
		poll: fetchDeepSeekQuota,
	},
	fireworks: {
		name: "fireworks",
		poll: fetchFireworksQuota,
	},
	groq: {
		name: "groq",
		poll: fetchGroqUsage,
	},
	huggingface: {
		name: "huggingface",
		poll: fetchHuggingFaceQuota,
	},
	moonshotai: {
		name: "moonshot",
		poll: fetchMoonshotQuota,
	},
	"moonshotai-cn": {
		name: "moonshot",
		poll: fetchMoonshotQuota,
	},
	"kimi-coding": {
		name: "kimi",
		poll: fetchKimiQuota,
	},
	minimax: {
		name: "minimax",
		poll: fetchMiniMaxQuota,
	},
	"minimax-cn": {
		name: "minimax",
		poll: fetchMiniMaxQuota,
	},
	"opencode-go": {
		name: "opencode-go",
		poll: fetchOpenCodeGoQuota,
	},
	openai: {
		name: "openai",
		poll: fetchOpenAIQuota,
	},
	openrouter: {
		name: "openrouter",
		poll: fetchOpenRouterQuota,
	},
	xai: {
		name: "xai",
		poll: fetchXaiQuota,
	},
	zai: {
		name: "zai",
		poll: fetchZaiQuota,
	},
	"zai-coding-cn": {
		name: "zai",
		poll: fetchZaiQuota,
	},
};

export function getProviderQuotaPollerName(provider: string): string | undefined {
	return PROVIDER_QUOTA_POLLERS[provider.trim().toLowerCase()]?.name;
}

export async function fetchProviderQuota(
	ctx: PiContext,
	ref: ModelRef,
	now = Date.now(),
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProviderQuotaFetchResult | undefined> {
	const poller = PROVIDER_QUOTA_POLLERS[ref.provider.trim().toLowerCase()];
	if (!poller) return undefined;
	const model = resolveModel(ctx, ref);
	const credentialKind = providerCredentialKind(ctx, model);
	const auth = await resolveProviderQuotaAuth(ctx, ref, model);
	if (!auth) return undefined;
	const parsed = await poller.poll({
		ref,
		model,
		thinkingLevel: ctx.thinkingLevel,
		auth,
		credentialKind,
		now,
		fetchImpl,
	});
	return parsed ? { poller: poller.name, parsed } : undefined;
}

async function resolveProviderQuotaAuth(
	ctx: PiContext,
	ref: ModelRef,
	model: PiModel | undefined,
): Promise<ProviderQuotaAuth | undefined> {
	if (model && ctx.modelRegistry.getApiKeyAndHeaders) {
		const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (resolved.ok) {
			return {
				apiKey: resolved.apiKey,
				headers: providerHeaders(resolved.headers),
				baseUrl: resolved.baseUrl,
				env: resolved.env ?? {},
			};
		}
	}
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider?.(ref.provider);
	return apiKey
		? {
				apiKey,
				headers: {},
				env: {},
			}
		: undefined;
}

function providerHeaders(
	headers: PiProviderHeaders | undefined,
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (value !== null) result[name] = value;
	}
	return result;
}

function resolveModel(ctx: PiContext, ref: ModelRef): PiModel | undefined {
	if (ctx.model?.provider === ref.provider && ctx.model.id === ref.model)
		return ctx.model;
	return ctx.modelRegistry.find?.(ref.provider, ref.model);
}

function providerCredentialKind(
	ctx: PiContext,
	model: PiModel | undefined,
): ProviderCredentialKind {
	if (!model) return "other";
	try {
		return ctx.modelRegistry.isUsingOAuth?.(model) ? "oauth" : "other";
	} catch {
		return "other";
	}
}

async function fetchAntigravityQuota({
	ref,
	model,
	thinkingLevel,
	auth,
	fetchImpl,
}: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined> {
	const credentials = parseAntigravityCredentials(auth.apiKey);
	if (!credentials) return undefined;
	const runtimeModel = resolveRuntimeModel(model, ref.model, thinkingLevel);
	const body = JSON.stringify({ project: credentials.projectId });
	for (const endpoint of antigravityEndpoints(auth)) {
		try {
			const response = await fetchWithTimeout(
				fetchImpl,
				`${endpoint}/v1internal:fetchAvailableModels`,
				{
					method: "POST",
					headers: {
						...auth.headers,
						Authorization: `Bearer ${credentials.token}`,
						"Content-Type": "application/json",
						Accept: "application/json",
						"User-Agent":
							auth.env.ANTIGRAVITY_USER_AGENT ?? ANTIGRAVITY_USER_AGENT,
					},
					body,
				},
			);
			if (!response.ok) continue;
			const parsed = parseAntigravityModels(
				await response.json(),
				ref.model,
				runtimeModel,
			);
			if (parsed) return parsed;
		} catch {
			continue;
		}
	}
	return undefined;
}

function parseAntigravityCredentials(
	value: string | undefined,
): { token: string; projectId: string } | undefined {
	if (!value) return undefined;
	try {
		const parsed = asRecord(JSON.parse(value));
		const token = stringValue(parsed?.token);
		const projectId = stringValue(parsed?.projectId);
		return token && projectId ? { token, projectId } : undefined;
	} catch {
		return undefined;
	}
}

function resolveRuntimeModel(
	model: PiModel | undefined,
	fallbackModel: string,
	thinkingLevel: string | undefined,
): string {
	if (!thinkingLevel) return fallbackModel;
	const mapped = model?.thinkingLevelMap?.[thinkingLevel];
	return typeof mapped === "string" && mapped.trim() ? mapped : fallbackModel;
}

function antigravityEndpoints(auth: ProviderQuotaAuth): string[] {
	const configured =
		auth.env.ANTIGRAVITY_BASE_URL ??
		antigravityBaseUrlFromResolvedAuth(auth.baseUrl);
	return configured
		? [configured.replace(/\/$/, "")]
		: [...ANTIGRAVITY_ENDPOINTS];
}

function antigravityBaseUrlFromResolvedAuth(
	baseUrl: string | undefined,
): string | undefined {
	if (!baseUrl) return undefined;
	try {
		const url = new URL(baseUrl);
		return /cloudcode-pa\./i.test(url.hostname) ? url.origin : undefined;
	} catch {
		return undefined;
	}
}

export function parseAntigravityModels(
	value: unknown,
	requestedModel: string,
	runtimeModel = requestedModel,
): ParsedQuotaObservation | undefined {
	const models = asRecord(asRecord(value)?.models);
	if (!models) return undefined;
	const exact = parseAntigravityModelQuota(models[runtimeModel]);
	if (exact) return { dimensions: [exact] };
	const requested = parseAntigravityModelQuota(models[requestedModel]);
	if (requested) return { dimensions: [requested] };
	const prefixed = Object.entries(models)
		.filter(([id]) => id.startsWith(`${requestedModel}-`))
		.map(([, info]) => parseAntigravityModelQuota(info))
		.filter(
			(dimension): dimension is ParsedQuotaDimension => dimension !== undefined,
		);
	if (prefixed.length === 0) return undefined;
	const dimension = prefixed.reduce((best, candidate) =>
		(candidate.remaining ?? 100) < (best.remaining ?? 100) ? candidate : best,
	);
	return { dimensions: [dimension] };
}

function parseAntigravityModelQuota(
	value: unknown,
): ParsedQuotaDimension | undefined {
	const quota = asRecord(asRecord(value)?.quotaInfo);
	const fraction = numberValue(quota?.remainingFraction);
	if (fraction === undefined) return undefined;
	const remaining = Math.round(clampPercent(fraction * 100) * 10) / 10;
	return {
		name: "quota",
		limit: 100,
		remaining,
		resetAt: timestampValue(quota?.resetTime),
	};
}

async function fetchCommandCodeQuota({
	auth,
	fetchImpl,
}: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined> {
	const token = auth.apiKey ?? bearerToken(auth.headers);
	if (!token) return undefined;
	const baseUrl = commandCodeApiBase(auth);
	const headers = {
		...auth.headers,
		accept: "application/json",
		Authorization: `Bearer ${token}`,
	};
	const whoami = await fetchCommandCodeJson(
		fetchImpl,
		`${baseUrl}/alpha/whoami`,
		headers,
	);
	const orgId = stringValue(asRecord(asRecord(whoami)?.org)?.id);
	const creditsUrl = new URL(`${baseUrl}/alpha/billing/credits`);
	if (orgId) creditsUrl.searchParams.set("orgId", orgId);
	const credits = await fetchCommandCodeJson(
		fetchImpl,
		creditsUrl.toString(),
		headers,
	);
	return parseCommandCodeCredits(credits);
}

function commandCodeApiBase(auth: ProviderQuotaAuth): string {
	const configured =
		auth.env.COMMAND_CODE_API_BASE ?? auth.env.COMMANDCODE_API_BASE;
	if (configured) return configured.replace(/\/$/, "");
	if (auth.baseUrl) {
		try {
			const url = new URL(auth.baseUrl);
			if (/commandcode\.ai$/i.test(url.hostname)) return url.origin;
		} catch {
			// Fall through to the provider default.
		}
	}
	return COMMAND_CODE_API_BASE;
}

function bearerToken(headers: Record<string, string>): string | undefined {
	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() !== "authorization") continue;
		const match = /^Bearer\s+(.+)$/i.exec(value.trim());
		if (match?.[1]) return match[1];
	}
	return undefined;
}

async function fetchCommandCodeJson(
	fetchImpl: typeof globalThis.fetch,
	url: string,
	headers: Record<string, string>,
): Promise<unknown> {
	const response = await fetchWithTimeout(fetchImpl, url, {
		method: "GET",
		headers,
	});
	if (!response.ok)
		throw new Error(`Command Code quota request failed: ${response.status}`);
	return response.json();
}

export function parseCommandCodeCredits(
	value: unknown,
): ParsedQuotaObservation | undefined {
	const root = asRecord(value);
	const nestedCredits = asRecord(root?.credits);
	const limits =
		asRecord(root?.windowLimits) ?? asRecord(nestedCredits?.windowLimits);
	if (!limits) return undefined;
	const dimensions = [
		parseCommandCodeWindow("5h", asRecord(limits.fiveHour)),
		parseCommandCodeWindow("weekly", asRecord(limits.weekly)),
	].filter(
		(dimension): dimension is ParsedQuotaDimension => dimension !== undefined,
	);
	return dimensions.length > 0 ? { dimensions } : undefined;
}

async function fetchDeepSeekQuota({
	auth,
	fetchImpl,
}: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined> {
	const token = auth.apiKey ?? bearerToken(auth.headers);
	if (!token) return undefined;
	const response = await fetchWithTimeout(fetchImpl, DEEPSEEK_BALANCE_URL, {
		method: "GET",
		headers: {
			...auth.headers,
			accept: "application/json",
			Authorization: `Bearer ${token}`,
		},
	});
	if (!response.ok)
		throw new Error(`DeepSeek balance request failed: ${response.status}`);
	return parseDeepSeekBalance(await response.json());
}

export function parseDeepSeekBalance(
	value: unknown,
): ParsedQuotaObservation | undefined {
	const root = asRecord(value);
	const balances = Array.isArray(root?.balance_infos)
		? root.balance_infos
				.map((entry) => asRecord(entry))
				.filter((entry): entry is Record<string, unknown> => Boolean(entry))
		: [];
	if (balances.length === 0) return undefined;
	const parsed = balances
		.map((entry) => ({
			currency: stringValue(entry.currency)?.toUpperCase(),
			balance: numberValue(entry.total_balance),
		}))
		.filter(
			(entry): entry is { currency: string; balance: number } =>
				Boolean(entry.currency) && entry.balance !== undefined && entry.balance >= 0,
		);
	if (parsed.length === 0) return undefined;
	const selected =
		parsed.find((entry) => entry.currency === "USD" && entry.balance > 0) ??
		parsed.find((entry) => entry.balance > 0) ??
		parsed.find((entry) => entry.currency === "USD") ??
		parsed[0];
	if (!selected) return undefined;
	return {
		dimensions: [],
		metrics: [{ name: "balance", value: selected.balance, unit: selected.currency }],
	};
}

async function fetchFireworksQuota({
	auth,
	now,
	fetchImpl,
}: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined> {
	const token = auth.apiKey ?? bearerToken(auth.headers);
	if (!token) return undefined;
	const headers = {
		...auth.headers,
		accept: "application/json",
		Authorization: `Bearer ${token}`,
	};
	const configuredSlug = cleanFireworksAccountSlug(auth.env.FIREWORKS_ACCOUNT_SLUG);
	const accountSlug =
		configuredSlug ?? (await discoverFireworksAccount(fetchImpl, headers));
	if (!accountSlug) return undefined;
	const start = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
	const end = new Date(now).toISOString();
	const url = new URL(
		`${FIREWORKS_API_ORIGIN}/v1/accounts/${accountSlug}/billing/summary`,
	);
	url.searchParams.set("startTime", start);
	url.searchParams.set("endTime", end);
	const response = await fetchWithTimeout(fetchImpl, url.toString(), {
		method: "GET",
		headers,
	});
	if (!response.ok) return undefined;
	return parseFireworksSummary(await response.json());
}

async function discoverFireworksAccount(
	fetchImpl: typeof globalThis.fetch,
	headers: Record<string, string>,
): Promise<string | undefined> {
	const slugs = new Set<string>();
	let pageToken: string | undefined;
	for (let page = 0; page < 20; page += 1) {
		const url = new URL(`${FIREWORKS_API_ORIGIN}/v1/accounts`);
		if (pageToken) url.searchParams.set("pageToken", pageToken);
		const response = await fetchWithTimeout(fetchImpl, url.toString(), {
			method: "GET",
			headers,
		});
		if (!response.ok) return undefined;
		const root = asRecord(await response.json());
		for (const raw of Array.isArray(root?.accounts) ? root.accounts : []) {
			const account = asRecord(raw);
			const candidate =
				stringValue(account?.accountId) ??
				stringValue(account?.id) ??
				stringValue(account?.name);
			const slug = cleanFireworksAccountSlug(candidate?.split("/").at(-1));
			if (slug) slugs.add(slug);
		}
		pageToken = stringValue(root?.nextPageToken);
		if (!pageToken) break;
	}
	return slugs.size === 1 ? [...slugs][0] : undefined;
}

function cleanFireworksAccountSlug(value: string | undefined): string | undefined {
	const slug = value?.trim();
	return slug && /^[A-Za-z0-9._-]+$/u.test(slug) ? slug : undefined;
}

export function parseFireworksSummary(
	value: unknown,
): ParsedQuotaObservation | undefined {
	const root = asRecord(value);
	const lineItems = Array.isArray(root?.lineItems) ? root.lineItems : [];
	let currency: string | undefined;
	let total = 0;
	let found = false;
	for (const raw of lineItems) {
		const cost = asRecord(asRecord(raw)?.totalCost);
		const code = stringValue(cost?.currencyCode)?.trim().toUpperCase();
		const units = numberValue(cost?.units);
		const nanos = numberValue(cost?.nanos);
		if (!code || units === undefined || nanos === undefined) continue;
		currency ??= code;
		if (code !== currency) continue;
		total += units + nanos / 1_000_000_000;
		found = true;
	}
	if (!found || !currency || !Number.isFinite(total)) return undefined;
	return {
		dimensions: [],
		metrics: [{ name: "spend", value: Math.max(0, total), unit: currency }],
	};
}

async function fetchGroqUsage({
	auth,
	fetchImpl,
}: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined> {
	const token = auth.apiKey ?? bearerToken(auth.headers);
	if (!token) return undefined;
	const base = groqMetricsBase(auth);
	const headers = {
		...auth.headers,
		accept: "application/json",
		Authorization: `Bearer ${token}`,
	};
	const requests = await fetchGroqMetric(
		fetchImpl,
		base,
		headers,
		"sum(model_project_id_status_code:requests:rate5m)",
	);
	const inputTokens = await fetchGroqMetric(
		fetchImpl,
		base,
		headers,
		"sum(model_project_id:tokens_in:rate5m)",
	);
	const outputTokens = await fetchGroqMetric(
		fetchImpl,
		base,
		headers,
		"sum(model_project_id:tokens_out:rate5m)",
	);
	if (requests === undefined && inputTokens === undefined && outputTokens === undefined)
		return undefined;
	const metrics = [];
	if (requests !== undefined)
		metrics.push({ name: "requests", value: requests * 60, unit: "req/min" });
	if (inputTokens !== undefined || outputTokens !== undefined) {
		metrics.push({
			name: "tokens",
			value: (inputTokens ?? 0) * 60 + (outputTokens ?? 0) * 60,
			unit: "tok/min",
		});
	}
	return metrics.length > 0 ? { dimensions: [], metrics } : undefined;
}

function groqMetricsBase(auth: ProviderQuotaAuth): string {
	const configured = auth.env.GROQ_API_URL;
	if (configured) {
		try {
			const url = new URL(configured);
			if (url.protocol === "https:") return `${url.origin}${url.pathname.replace(/\/$/u, "")}`;
		} catch {
			// Fall through to Pi's provider host.
		}
	}
	if (auth.baseUrl) {
		try {
			const url = new URL(auth.baseUrl);
			if (url.hostname.toLowerCase() === "api.groq.com") return `${url.origin}/v1`;
		} catch {
			// Fall through to the provider default.
		}
	}
	return "https://api.groq.com/v1";
}

async function fetchGroqMetric(
	fetchImpl: typeof globalThis.fetch,
	base: string,
	headers: Record<string, string>,
	query: string,
): Promise<number | undefined> {
	const url = new URL(`${base}/metrics/prometheus/api/v1/query`);
	url.searchParams.set("query", query);
	const response = await fetchWithTimeout(fetchImpl, url.toString(), {
		method: "GET",
		headers,
	});
	if (!response.ok) return undefined;
	return parseGroqMetric(await response.json());
}

export function parseGroqMetric(value: unknown): number | undefined {
	const root = asRecord(value);
	const data = asRecord(root?.data);
	if (root?.status !== "success" || !Array.isArray(data?.result)) return undefined;
	let total = 0;
	for (const raw of data.result) {
		const values = asRecord(raw)?.value;
		if (!Array.isArray(values) || values.length !== 2) return undefined;
		const sample = numberValue(values[1]);
		if (sample === undefined || sample < 0) return undefined;
		total += sample;
	}
	return Number.isFinite(total) ? total : undefined;
}

async function fetchHuggingFaceQuota({
	auth,
	now,
	fetchImpl,
}: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined> {
	const token = auth.apiKey ?? bearerToken(auth.headers);
	if (!token) return undefined;
	const date = new Date(now);
	const start = Math.floor(
		Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000,
	);
	const end = Math.floor(now / 1000);
	const usageUrl = new URL(`${HUGGINGFACE_ORIGIN}/api/settings/billing/usage-v2`);
	usageUrl.searchParams.set("startDate", String(start));
	usageUrl.searchParams.set("endDate", String(end));
	const headers = {
		...auth.headers,
		accept: "application/json",
		Authorization: `Bearer ${token}`,
		"User-Agent": "pi-quota-status",
	};
	const response = await fetchWithTimeout(fetchImpl, usageUrl.toString(), {
		method: "GET",
		headers,
	});
	if (!response.ok) return undefined;
	const parsed = parseHuggingFaceUsage(await response.json());
	if (!parsed) return undefined;
	try {
		const gpuResponse = await fetchWithTimeout(
			fetchImpl,
			`${HUGGINGFACE_ORIGIN}/api/spaces/zero-gpu/quota`,
			{ method: "GET", headers },
		);
		if (gpuResponse.ok) {
			const gpu = parseHuggingFaceGpuQuota(await gpuResponse.json());
			if (gpu) parsed.dimensions.push(gpu);
		}
	} catch {
		// ZeroGPU is optional and must not hide billing usage.
	}
	return parsed;
}

export function parseHuggingFaceUsage(
	value: unknown,
): ParsedQuotaObservation | undefined {
	const inference = asRecord(asRecord(asRecord(value)?.usage)?.inferenceProviders);
	const grossNano = numberValue(inference?.usedNanoUsd);
	const includedNano = numberValue(inference?.includedNanoUsd);
	if (grossNano === undefined || includedNano === undefined) return undefined;
	const billable = Math.max(0, grossNano - includedNano) / 1_000_000_000;
	const limitNano = numberValue(inference?.limitNanoUsd);
	const limit = limitNano !== undefined ? limitNano / 1_000_000_000 : 0;
	return {
		dimensions:
			limit > 0
				? [
						{
							name: "monthly",
							limit,
							remaining: Math.max(0, limit - billable),
						},
					]
				: [],
		metrics: [{ name: "spend", value: billable, unit: "USD" }],
	};
}

export function parseHuggingFaceGpuQuota(
	value: unknown,
): ParsedQuotaDimension | undefined {
	const root = asRecord(value);
	const limit = numberValue(root?.base);
	const remaining = numberValue(root?.current);
	if (limit === undefined || limit <= 0 || remaining === undefined) return undefined;
	return {
		name: "gpu",
		limit,
		remaining: Math.max(0, Math.min(limit, remaining)),
		resetAt: timestampValue(root?.resetsAt),
	};
}

async function fetchOpenAIQuota({
	auth,
	now,
	fetchImpl,
}: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined> {
	const token = auth.apiKey ?? bearerToken(auth.headers);
	if (!token) return undefined;
	const response = await fetchWithTimeout(fetchImpl, OPENAI_CREDIT_GRANTS_URL, {
		method: "GET",
		headers: {
			...auth.headers,
			accept: "application/json",
			Authorization: `Bearer ${token}`,
		},
	});
	if (!response.ok) return undefined;
	return parseOpenAICreditGrants(await response.json(), now);
}

export function parseOpenAICreditGrants(
	value: unknown,
	now = Date.now(),
): ParsedQuotaObservation | undefined {
	const root = asRecord(value);
	const totalGranted = numberValue(root?.total_granted);
	const totalAvailable = numberValue(root?.total_available);
	if (totalGranted === undefined || totalAvailable === undefined) return undefined;
	const grants = asRecord(root?.grants);
	const expiries = (Array.isArray(grants?.data) ? grants.data : [])
		.map((raw) => timestampValue(asRecord(raw)?.expires_at))
		.filter((expiry): expiry is number => expiry !== undefined && expiry > now);
	const resetAt = expiries.length > 0 ? Math.min(...expiries) : undefined;
	if (totalGranted > 0) {
		return {
			dimensions: [
				{
					name: "credits",
					limit: totalGranted,
					remaining: Math.max(0, Math.min(totalGranted, totalAvailable)),
					resetAt,
				},
			],
		};
	}
	return totalAvailable >= 0
		? {
				dimensions: [],
				metrics: [{ name: "balance", value: totalAvailable, unit: "USD" }],
			}
		: undefined;
}

async function fetchMoonshotQuota({
	ref,
	auth,
	fetchImpl,
}: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined> {
	const token = auth.apiKey ?? bearerToken(auth.headers);
	if (!token) return undefined;
	const origin = moonshotOrigin(ref.provider, auth.baseUrl);
	const response = await fetchWithTimeout(fetchImpl, `${origin}/v1/users/me/balance`, {
		method: "GET",
		headers: {
			...auth.headers,
			accept: "application/json",
			Authorization: `Bearer ${token}`,
		},
	});
	if (!response.ok)
		throw new Error(`Moonshot balance request failed: ${response.status}`);
	return parseMoonshotBalance(await response.json(), origin.endsWith(".cn") ? "CNY" : "USD");
}

function moonshotOrigin(provider: string, baseUrl: string | undefined): string {
	if (baseUrl) {
		try {
			const url = new URL(baseUrl);
			if (["api.moonshot.ai", "api.moonshot.cn"].includes(url.hostname.toLowerCase()))
				return url.origin;
		} catch {
			// Fall through to the provider-specific default.
		}
	}
	return provider.toLowerCase().endsWith("-cn")
		? "https://api.moonshot.cn"
		: "https://api.moonshot.ai";
}

export function parseMoonshotBalance(
	value: unknown,
	currency = "USD",
): ParsedQuotaObservation | undefined {
	const root = asRecord(value);
	const data = asRecord(root?.data);
	const code = numberValue(root?.code);
	const status = root?.status;
	const balance = numberValue(data?.available_balance);
	if (code !== 0 || status !== true || balance === undefined) return undefined;
	return {
		dimensions: [],
		metrics: [
			{ name: "balance", value: Math.max(0, balance), unit: currency.toUpperCase() },
		],
	};
}

async function fetchKimiQuota({
	auth,
	fetchImpl,
}: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined> {
	const token = auth.apiKey ?? bearerToken(auth.headers);
	if (!token) return undefined;
	const endpoint = kimiUsageEndpoint(auth.baseUrl);
	const response = await fetchWithTimeout(fetchImpl, endpoint, {
		method: "GET",
		headers: {
			...auth.headers,
			accept: "application/json",
			Authorization: `Bearer ${token}`,
		},
	});
	if (!response.ok)
		throw new Error(`Kimi quota request failed: ${response.status}`);
	return parseKimiUsage(await response.json());
}

function kimiUsageEndpoint(baseUrl: string | undefined): string {
	const fallback = "https://api.kimi.com/coding/v1/usages";
	if (!baseUrl) return fallback;
	try {
		const url = new URL(baseUrl);
		if (!/\.kimi\.(?:com|ai)$/i.test(url.hostname)) return fallback;
		const path = url.pathname.replace(/\/+$/u, "");
		if (path.endsWith("/coding/v1")) return `${url.origin}${path}/usages`;
		if (path.endsWith("/coding")) return `${url.origin}${path}/v1/usages`;
		return `${url.origin}${path}/coding/v1/usages`;
	} catch {
		return fallback;
	}
}

export function parseKimiUsage(value: unknown): ParsedQuotaObservation | undefined {
	const root = asRecord(value);
	const pools = asRecord(root?.usages);
	const dimensions: ParsedQuotaDimension[] = [];
	for (const [key, name] of [
		["limit_5h", "5h"],
		["limit_7d", "weekly"],
		["limit_month_total", "monthly"],
	] as const) {
		const pool = asRecord(pools?.[key]);
		const ratio = numberValue(pool?.used_ratio);
		if (ratio === undefined || ratio < 0) continue;
		dimensions.push({
			name,
			limit: 100,
			remaining: 100 - clampPercent(Math.min(1, ratio) * 100),
			resetAt: timestampValue(pool?.reset_time),
		});
	}
	const weekly = parseKimiCountDimension("weekly", asRecord(root?.usage));
	if (!dimensions.some((dimension) => dimension.name === "weekly") && weekly)
		dimensions.push(weekly);
	const limits = Array.isArray(root?.limits) ? root.limits : [];
	for (const raw of limits) {
		const limit = asRecord(raw);
		const detail = asRecord(limit?.detail);
		const window = asRecord(limit?.window);
		const minutes = kimiWindowMinutes(window);
		const name = minutes === 300 ? "5h" : minutes === 10080 ? "weekly" : "quota";
		if (dimensions.some((dimension) => dimension.name === name)) continue;
		const dimension = parseKimiCountDimension(name, detail);
		if (dimension) dimensions.push(dimension);
	}
	return dimensions.length > 0 ? { dimensions } : undefined;
}

async function fetchMiniMaxQuota({
	ref,
	auth,
	fetchImpl,
}: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined> {
	const token = auth.apiKey ?? bearerToken(auth.headers);
	if (!token) return undefined;
	const origin = miniMaxOrigin(ref.provider, auth.baseUrl);
	const headers = {
		...auth.headers,
		accept: "application/json",
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		"MM-API-Source": "pi-quota-status",
	};
	for (const path of [
		"/v1/token_plan/remains",
		"/v1/api/openplatform/coding_plan/remains",
	]) {
		try {
			const response = await fetchWithTimeout(fetchImpl, `${origin}${path}`, {
				method: "GET",
				headers,
			});
			if (!response.ok) continue;
			const parsed = parseMiniMaxUsage(await response.json());
			if (parsed) return parsed;
		} catch {
			continue;
		}
	}
	return undefined;
}

function miniMaxOrigin(provider: string, baseUrl: string | undefined): string {
	if (baseUrl) {
		try {
			const url = new URL(baseUrl);
			if (["api.minimax.io", "api.minimaxi.com"].includes(url.hostname.toLowerCase()))
				return url.origin;
		} catch {
			// Fall through to the provider-specific default.
		}
	}
	return provider.toLowerCase() === "minimax-cn"
		? MINIMAX_CN_ORIGIN
		: MINIMAX_GLOBAL_ORIGIN;
}

export function parseMiniMaxUsage(
	value: unknown,
): ParsedQuotaObservation | undefined {
	const root = asRecord(value);
	const data = asRecord(root?.data) ?? root;
	const baseResponse = asRecord(data?.base_resp) ?? asRecord(root?.base_resp);
	const statusCode = numberValue(baseResponse?.status_code);
	if (statusCode !== undefined && statusCode !== 0) return undefined;
	const modelRemains = Array.isArray(data?.model_remains)
		? data.model_remains
		: [];
	const dimensions: ParsedQuotaDimension[] = [];
	for (const raw of modelRemains) {
		const remains = asRecord(raw);
		if (!remains) continue;
		const interval = parseMiniMaxWindow({
			name: miniMaxWindowName(
				timestampValue(remains.start_time),
				timestampValue(remains.end_time),
			),
			total: numberValue(remains.current_interval_total_count),
			remaining: numberValue(remains.current_interval_usage_count),
			remainingPercent: numberValue(remains.current_interval_remaining_percent),
			resetAt: timestampValue(remains.end_time),
		});
		mergeMostConstrainedDimension(dimensions, interval);
		const weekly = parseMiniMaxWindow({
			name: "weekly",
			total: numberValue(remains.current_weekly_total_count),
			remaining: numberValue(remains.current_weekly_usage_count),
			remainingPercent: numberValue(remains.current_weekly_remaining_percent),
			resetAt: timestampValue(remains.weekly_end_time),
		});
		mergeMostConstrainedDimension(dimensions, weekly);
	}
	return dimensions.length > 0 ? { dimensions } : undefined;
}

function parseMiniMaxWindow({
	name,
	total,
	remaining,
	remainingPercent,
	resetAt,
}: {
	name: string;
	total: number | undefined;
	remaining: number | undefined;
	remainingPercent: number | undefined;
	resetAt: number | undefined;
}): ParsedQuotaDimension | undefined {
	if (remainingPercent !== undefined) {
		return {
			name,
			limit: 100,
			remaining: clampPercent(remainingPercent),
			resetAt,
		};
	}
	if (total === undefined || total <= 0 || remaining === undefined) return undefined;
	return {
		name,
		limit: total,
		remaining: Math.max(0, Math.min(total, remaining)),
		resetAt,
	};
}

function miniMaxWindowName(startAt: number | undefined, endAt: number | undefined): string {
	if (startAt === undefined || endAt === undefined || endAt <= startAt) return "quota";
	const minutes = Math.round((endAt - startAt) / 60_000);
	if (minutes === 300) return "5h";
	if (minutes === 10080) return "weekly";
	if (minutes >= 40_000 && minutes <= 46_000) return "monthly";
	return "quota";
}

function mergeMostConstrainedDimension(
	dimensions: ParsedQuotaDimension[],
	candidate: ParsedQuotaDimension | undefined,
): void {
	if (!candidate) return;
	const existingIndex = dimensions.findIndex(
		(dimension) => dimension.name === candidate.name,
	);
	if (existingIndex < 0) {
		dimensions.push(candidate);
		return;
	}
	const existing = dimensions[existingIndex];
	if (!existing) return;
	const existingPercent = quotaRemainingPercent(existing);
	const candidatePercent = quotaRemainingPercent(candidate);
	if (
		candidatePercent !== undefined &&
		(existingPercent === undefined || candidatePercent < existingPercent)
	) {
		dimensions[existingIndex] = candidate;
	}
}

function quotaRemainingPercent(
	dimension: ParsedQuotaDimension,
): number | undefined {
	if (
		dimension.limit === undefined ||
		dimension.limit <= 0 ||
		dimension.remaining === undefined
	)
		return undefined;
	return clampPercent((dimension.remaining / dimension.limit) * 100);
}

function parseKimiCountDimension(
	name: string,
	detail: Record<string, unknown> | undefined,
): ParsedQuotaDimension | undefined {
	const limit = numberValue(detail?.limit);
	const remainingValue = numberValue(detail?.remaining);
	const used = numberValue(detail?.used);
	if (limit === undefined || limit <= 0) return undefined;
	const remaining =
		remainingValue !== undefined
			? remainingValue
			: used !== undefined
				? limit - used
				: undefined;
	if (remaining === undefined) return undefined;
	return {
		name,
		limit,
		remaining: Math.max(0, Math.min(limit, remaining)),
		resetAt: timestampValue(
			detail?.resetTime ?? detail?.resetAt ?? detail?.reset_time ?? detail?.reset_at,
		),
	};
}

function kimiWindowMinutes(
	window: Record<string, unknown> | undefined,
): number | undefined {
	const duration = numberValue(window?.duration);
	const unit = stringValue(window?.timeUnit);
	if (duration === undefined || duration <= 0 || !unit) return undefined;
	const multiplier =
		unit === "TIME_UNIT_MINUTE"
			? 1
			: unit === "TIME_UNIT_HOUR"
				? 60
				: unit === "TIME_UNIT_DAY"
					? 1440
					: undefined;
	return multiplier === undefined ? undefined : duration * multiplier;
}

async function fetchZaiQuota({
	ref,
	auth,
	fetchImpl,
}: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined> {
	const token = auth.apiKey ?? bearerToken(auth.headers);
	if (!token) return undefined;
	const origin = zaiOrigin(ref.provider, auth.baseUrl);
	const response = await fetchWithTimeout(
		fetchImpl,
		`${origin}/api/monitor/usage/quota/limit`,
		{
			method: "GET",
			headers: {
				...auth.headers,
				accept: "application/json",
				Authorization: `Bearer ${token}`,
			},
		},
	);
	if (!response.ok) throw new Error(`Z.AI quota request failed: ${response.status}`);
	return parseZaiQuota(await response.json());
}

function zaiOrigin(provider: string, baseUrl: string | undefined): string {
	if (baseUrl) {
		try {
			const url = new URL(baseUrl);
			if (["api.z.ai", "open.bigmodel.cn"].includes(url.hostname.toLowerCase()))
				return url.origin;
		} catch {
			// Fall through to the provider-specific default.
		}
	}
	return provider.toLowerCase() === "zai-coding-cn"
		? "https://open.bigmodel.cn"
		: "https://api.z.ai";
}

export function parseZaiQuota(value: unknown): ParsedQuotaObservation | undefined {
	const root = asRecord(value);
	const data = asRecord(root?.data);
	if (root?.success !== true || numberValue(root?.code) !== 200) return undefined;
	const limits = Array.isArray(data?.limits) ? data.limits : [];
	const dimensions = limits
		.map((raw) => parseZaiLimit(asRecord(raw)))
		.filter(
			(dimension): dimension is ParsedQuotaDimension => dimension !== undefined,
		)
		.sort((a, b) => quotaWindowRank(a.name) - quotaWindowRank(b.name));
	return dimensions.length > 0 ? { dimensions } : undefined;
}

function parseZaiLimit(
	limit: Record<string, unknown> | undefined,
): ParsedQuotaDimension | undefined {
	const type = stringValue(limit?.type);
	if (!type || !["TOKENS_LIMIT", "CREDIT_LIMIT", "TIME_LIMIT"].includes(type))
		return undefined;
	const unit = numberValue(limit?.unit);
	const number = numberValue(limit?.number);
	const windowMinutes = zaiWindowMinutes(unit, number, type);
	const cap = numberValue(limit?.usage);
	const current = numberValue(limit?.currentValue);
	const absoluteRemaining = numberValue(limit?.remaining);
	let usedPercent = numberValue(limit?.percentage);
	if (cap !== undefined && cap > 0) {
		const used =
			absoluteRemaining !== undefined
				? Math.max(cap - absoluteRemaining, current ?? 0)
				: current;
		if (used !== undefined) usedPercent = (Math.max(0, Math.min(cap, used)) / cap) * 100;
	}
	if (usedPercent === undefined) return undefined;
	const name =
		type === "TIME_LIMIT"
			? "mcp"
			: windowMinutes === 300
				? "5h"
				: windowMinutes === 10080
					? "weekly"
					: windowMinutes === 43200
						? "monthly"
						: "quota";
	return {
		name,
		limit: 100,
		remaining: 100 - clampPercent(usedPercent),
		resetAt: timestampValue(limit?.nextResetTime),
	};
}

function zaiWindowMinutes(
	unit: number | undefined,
	amount: number | undefined,
	type: string,
): number | undefined {
	if (amount === undefined || amount <= 0) return undefined;
	if (type === "TIME_LIMIT" && unit === 5 && amount === 1) return 43200;
	const multiplier =
		unit === 1 ? 1440 : unit === 3 ? 60 : unit === 5 ? 1 : unit === 6 ? 10080 : undefined;
	return multiplier === undefined ? undefined : amount * multiplier;
}

function quotaWindowRank(name: string): number {
	return name === "5h" ? 0 : name === "weekly" ? 1 : name === "monthly" ? 2 : 3;
}

async function fetchOpenCodeGoQuota({
	auth,
	fetchImpl,
}: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined> {
	const token = auth.apiKey ?? bearerToken(auth.headers);
	if (!token) return undefined;
	const response = await fetchWithTimeout(fetchImpl, OPENCODE_GO_USAGE_URL, {
		method: "GET",
		headers: {
			...auth.headers,
			accept: "application/json",
			Authorization: `Bearer ${token}`,
			"User-Agent": "pi-quota-status",
		},
	});
	if (!response.ok)
		throw new Error(`OpenCode Go quota request failed: ${response.status}`);
	return parseOpenCodeGoUsage(await response.json());
}

export function parseOpenCodeGoUsage(
	value: unknown,
): ParsedQuotaObservation | undefined {
	const usage = asRecord(asRecord(value)?.usage);
	const rolling = parseOpenCodeGoWindow("5h", asRecord(usage?.rolling));
	if (!rolling) return undefined;
	const dimensions = [
		rolling,
		parseOpenCodeGoWindow("weekly", asRecord(usage?.weekly)),
		parseOpenCodeGoWindow("monthly", asRecord(usage?.monthly)),
	].filter(
		(dimension): dimension is ParsedQuotaDimension => dimension !== undefined,
	);
	return { dimensions };
}

async function fetchOpenRouterQuota({
	auth,
	fetchImpl,
}: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined> {
	const token = auth.apiKey ?? bearerToken(auth.headers);
	if (!token) return undefined;
	const baseUrl = openRouterApiBase(auth);
	const response = await fetchWithTimeout(fetchImpl, `${baseUrl}/key`, {
		method: "GET",
		headers: {
			...auth.headers,
			accept: "application/json",
			Authorization: `Bearer ${token}`,
			"X-Title": "pi-quota-status",
		},
	});
	if (!response.ok)
		throw new Error(`OpenRouter quota request failed: ${response.status}`);
	return parseOpenRouterKey(await response.json());
}

function openRouterApiBase(auth: ProviderQuotaAuth): string {
	if (!auth.baseUrl) return OPENROUTER_API_BASE;
	try {
		const url = new URL(auth.baseUrl);
		if (url.hostname.toLowerCase() !== "openrouter.ai") return OPENROUTER_API_BASE;
		return `${url.origin}/api/v1`;
	} catch {
		return OPENROUTER_API_BASE;
	}
}

export function parseOpenRouterKey(
	value: unknown,
): ParsedQuotaObservation | undefined {
	const data = asRecord(asRecord(value)?.data);
	const limit = numberValue(data?.limit);
	if (limit === undefined || limit <= 0) return undefined;
	const limitRemaining = numberValue(data?.limit_remaining);
	const usage = numberValue(data?.usage);
	const reset = stringValue(data?.limit_reset)?.toLowerCase();
	const windowUsage =
		reset === "daily"
			? numberValue(data?.usage_daily)
			: reset === "weekly"
				? numberValue(data?.usage_weekly)
				: reset === "monthly"
					? numberValue(data?.usage_monthly)
					: undefined;
	const remaining =
		limitRemaining !== undefined
			? Math.max(0, Math.min(limit, limitRemaining))
			: windowUsage !== undefined
				? Math.max(0, limit - windowUsage)
				: usage !== undefined
					? Math.max(0, limit - usage)
					: undefined;
	if (remaining === undefined) return undefined;
	return {
		dimensions: [
			{
				name: reset && ["daily", "weekly", "monthly"].includes(reset) ? reset : "quota",
				limit,
				remaining,
			},
		],
	};
}

async function fetchXaiQuota({
	auth,
	credentialKind,
	now,
	fetchImpl,
}: ProviderQuotaPollArgs): Promise<ParsedQuotaObservation | undefined> {
	if (credentialKind !== "oauth") return undefined;
	const token = auth.apiKey ?? bearerToken(auth.headers);
	if (!token) return undefined;
	const response = await fetchWithTimeout(fetchImpl, XAI_BILLING_URL, {
		method: "GET",
		headers: {
			...auth.headers,
			accept: "application/json",
			Authorization: `Bearer ${token}`,
			"x-xai-token-auth": "xai-grok-cli",
			"User-Agent": "pi-quota-status",
		},
	});
	if (!response.ok) return undefined;
	return parseXaiSubscriptionBilling(await response.json(), now);
}

export function parseXaiSubscriptionBilling(
	value: unknown,
	now = Date.now(),
): ParsedQuotaObservation | undefined {
	const config = asRecord(asRecord(value)?.config);
	if (!config) return undefined;
	let usedPercent = numberValue(config.creditUsagePercent);
	if (usedPercent === undefined) {
		const cap = numberValue(asRecord(config.onDemandCap)?.val);
		const used = numberValue(asRecord(config.onDemandUsed)?.val);
		if (cap !== undefined && cap > 0 && used !== undefined)
			usedPercent = (used / cap) * 100;
	}
	if (usedPercent === undefined) return undefined;
	const currentPeriod = asRecord(config.currentPeriod);
	const currentPeriodEnd = timestampValue(currentPeriod?.end);
	const resetAt =
		currentPeriodEnd ?? timestampValue(config.billingPeriodEnd);
	const startAt =
		currentPeriodEnd !== undefined
			? timestampValue(currentPeriod?.start)
			: timestampValue(config.billingPeriodStart);
	const windowMinutes =
		startAt !== undefined &&
		resetAt !== undefined &&
		resetAt > startAt &&
		startAt <= now
			? Math.floor((resetAt - startAt) / 60_000)
			: undefined;
	return {
		dimensions: [
			{
				name: xaiWindowName(windowMinutes),
				limit: 100,
				remaining: 100 - clampPercent(usedPercent),
				resetAt,
			},
		],
	};
}

function xaiWindowName(windowMinutes: number | undefined): string {
	const day = 24 * 60;
	if (
		windowMinutes !== undefined &&
		windowMinutes >= 4 * day &&
		windowMinutes <= 12 * day
	)
		return "weekly";
	if (
		windowMinutes !== undefined &&
		windowMinutes >= 20 * day &&
		windowMinutes <= 45 * day
	)
		return "monthly";
	return "quota";
}

function parseOpenCodeGoWindow(
	name: string,
	value: Record<string, unknown> | undefined,
): ParsedQuotaDimension | undefined {
	const usedPercent = numberValue(value?.percent);
	if (usedPercent === undefined) return undefined;
	return {
		name,
		limit: 100,
		remaining: 100 - clampPercent(usedPercent),
		resetAt: timestampValue(value?.resetsAt ?? value?.resetAt),
	};
}

function parseCommandCodeWindow(
	name: string,
	value: Record<string, unknown> | undefined,
): ParsedQuotaDimension | undefined {
	const used = numberValue(value?.used);
	const cap = numberValue(value?.cap);
	if (used === undefined || cap === undefined || used < 0 || cap <= 0)
		return undefined;
	return {
		name,
		limit: cap,
		remaining: Math.max(0, Math.min(cap, cap - used)),
		resetAt: timestampValue(value?.resetAt),
	};
}

async function fetchWithTimeout(
	fetchImpl: typeof globalThis.fetch,
	input: string,
	init: RequestInit,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetchImpl(input, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}
