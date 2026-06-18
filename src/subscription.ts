import type { PiContext } from "./pi-types.js";
import type {
	ModelRef,
	ParsedQuotaDimension,
	ParsedQuotaObservation,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 10_000;
const OPENAI_CODEX_PROVIDER = "openai-codex";
const ANTHROPIC_PROVIDER = "anthropic";
const OPENAI_CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

export async function fetchSubscriptionQuota(
	ctx: PiContext,
	ref: ModelRef,
	now = Date.now(),
): Promise<ParsedQuotaObservation | undefined> {
	if (
		ref.provider !== OPENAI_CODEX_PROVIDER &&
		ref.provider !== ANTHROPIC_PROVIDER
	)
		return undefined;
	const token = await ctx.modelRegistry.getApiKeyForProvider?.(ref.provider);
	if (!token) return undefined;
	if (ref.provider === OPENAI_CODEX_PROVIDER)
		return fetchOpenAICodexQuota(token, now);
	return fetchAnthropicQuota(token, now);
}

export async function fetchOpenAICodexQuota(
	token: string,
	now = Date.now(),
): Promise<ParsedQuotaObservation | undefined> {
	return fetchQuotaJson(
		OPENAI_CODEX_USAGE_URL,
		{ authorization: `Bearer ${token}` },
		"OpenAI Codex",
		(value) => parseOpenAICodexUsage(value, now),
	);
}

export async function fetchAnthropicQuota(
	token: string,
	now = Date.now(),
): Promise<ParsedQuotaObservation | undefined> {
	return fetchQuotaJson(
		ANTHROPIC_USAGE_URL,
		{
			authorization: `Bearer ${token}`,
			"anthropic-beta": ANTHROPIC_OAUTH_BETA,
		},
		"Anthropic",
		(value) => parseAnthropicUsage(value, now),
	);
}

async function fetchQuotaJson(
	url: string,
	headers: Record<string, string>,
	label: string,
	parse: (value: unknown) => ParsedQuotaObservation | undefined,
): Promise<ParsedQuotaObservation | undefined> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, { headers, signal: controller.signal });
		if (!response.ok)
			throw new Error(`${label} quota request failed: ${response.status}`);
		return parse(await response.json());
	} finally {
		clearTimeout(timeout);
	}
}

export function parseOpenAICodexUsage(
	value: unknown,
	now = Date.now(),
): ParsedQuotaObservation | undefined {
	const root = asRecord(value);
	const rateLimit = asRecord(root?.rate_limit) ?? asRecord(root?.rateLimit);
	const dimensions = [
		parseCodexWindow(
			"5h",
			asRecord(rateLimit?.primary_window) ?? asRecord(rateLimit?.primaryWindow),
			now,
		),
		parseCodexWindow(
			"weekly",
			asRecord(rateLimit?.secondary_window) ??
				asRecord(rateLimit?.secondaryWindow),
			now,
		),
		...parseAdditionalRateLimits(root, now),
	].filter((dimension): dimension is ParsedQuotaDimension =>
		Boolean(dimension),
	);
	if (dimensions.length === 0) return undefined;
	return { dimensions };
}

export function parseAnthropicUsage(
	value: unknown,
	now = Date.now(),
): ParsedQuotaObservation | undefined {
	const root = asRecord(value);
	const dimensions = [
		parseAnthropicWindow("5h", asRecord(root?.five_hour), now),
		parseAnthropicWindow("weekly", asRecord(root?.seven_day), now),
		parseAnthropicWindow(
			"weekly_sonnet",
			asRecord(root?.seven_day_sonnet),
			now,
		),
		parseAnthropicWindow("weekly_opus", asRecord(root?.seven_day_opus), now),
	].filter((dimension): dimension is ParsedQuotaDimension =>
		Boolean(dimension),
	);
	if (dimensions.length === 0) return undefined;
	return { dimensions };
}

function parseAdditionalRateLimits(
	root: Record<string, unknown> | undefined,
	now: number,
): Array<ParsedQuotaDimension | undefined> {
	const candidates = [
		root?.additional_rate_limits,
		root?.additionalRateLimits,
		asRecord(root?.rate_limit)?.additional_rate_limits,
		asRecord(root?.rateLimit)?.additionalRateLimits,
	];
	const list = candidates.find(Array.isArray);
	if (!Array.isArray(list)) return [];
	return list.map((item, index) => {
		const record = asRecord(item);
		const window =
			asRecord(record?.window) ??
			asRecord(record?.rate_limit) ??
			asRecord(record?.rateLimit) ??
			asRecord(record?.primary_window) ??
			asRecord(record?.primaryWindow) ??
			record;
		const name = stringValue(record?.id) ?? stringValue(record?.title);
		return parseCodexWindow(name ?? `extra-${index + 1}`, window, now);
	});
}

function parseCodexWindow(
	name: string,
	window: Record<string, unknown> | undefined,
	now: number,
): ParsedQuotaDimension | undefined {
	if (!window) return undefined;
	const usedPercent = normalizedUsedPercent(
		window.used_percent ?? window.usedPercent ?? window.used,
	);
	if (usedPercent === undefined) return undefined;
	return {
		name,
		limit: 100,
		remaining: clampPercent(100 - usedPercent),
		resetAt: parseResetAt(window, now),
	};
}

function parseAnthropicWindow(
	name: string,
	window: Record<string, unknown> | undefined,
	now: number,
): ParsedQuotaDimension | undefined {
	if (!window) return undefined;
	const usedPercent = normalizedUsedPercent(
		window.utilization ??
			window.used_percent ??
			window.usedPercent ??
			window.used,
	);
	if (usedPercent === undefined) return undefined;
	return {
		name,
		limit: 100,
		remaining: clampPercent(100 - usedPercent),
		resetAt: parseResetAt(window, now),
	};
}

function parseResetAt(
	window: Record<string, unknown>,
	now: number,
): number | undefined {
	const resetAt = timestampValue(
		window.reset_at ?? window.resetAt ?? window.resets_at ?? window.resetsAt,
	);
	if (resetAt !== undefined) return resetAt;
	const resetAfter = numberValue(
		window.reset_after_seconds ??
			window.resetAfterSeconds ??
			window.retry_after ??
			window.retryAfter,
	);
	return resetAfter === undefined ? undefined : now + resetAfter * 1000;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedUsedPercent(value: unknown): number | undefined {
	const parsed = numberValue(value);
	if (parsed === undefined) return undefined;
	return parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed;
}

function timestampValue(value: unknown): number | undefined {
	const numeric = numberValue(value);
	if (numeric !== undefined)
		return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsedDate = Date.parse(value);
	return Number.isFinite(parsedDate) ? parsedDate : undefined;
}

function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}
