import type {
	AdapterConfig,
	HeaderFieldMapping,
	HeaderNames,
	ParsedQuotaObservation,
} from "./types.js";

const DEFAULT_RETRY_HEADERS = ["retry-after", "x-retry-after"];

const ANTHROPIC_MAPPINGS: HeaderFieldMapping[] = [
	{
		dimension: "requests",
		limit: "anthropic-ratelimit-requests-limit",
		remaining: "anthropic-ratelimit-requests-remaining",
		reset: "anthropic-ratelimit-requests-reset",
		retryAfter: DEFAULT_RETRY_HEADERS,
	},
	{
		dimension: "tokens",
		limit: "anthropic-ratelimit-tokens-limit",
		remaining: "anthropic-ratelimit-tokens-remaining",
		reset: "anthropic-ratelimit-tokens-reset",
		retryAfter: DEFAULT_RETRY_HEADERS,
	},
	{
		dimension: "input_tokens",
		limit: "anthropic-ratelimit-input-tokens-limit",
		remaining: "anthropic-ratelimit-input-tokens-remaining",
		reset: "anthropic-ratelimit-input-tokens-reset",
		retryAfter: DEFAULT_RETRY_HEADERS,
	},
	{
		dimension: "output_tokens",
		limit: "anthropic-ratelimit-output-tokens-limit",
		remaining: "anthropic-ratelimit-output-tokens-remaining",
		reset: "anthropic-ratelimit-output-tokens-reset",
		retryAfter: DEFAULT_RETRY_HEADERS,
	},
	{
		dimension: "messages",
		limit: [
			"anthropic-ratelimit-messages-limit",
			"anthropic-ratelimit-message-limit",
		],
		remaining: [
			"anthropic-ratelimit-messages-remaining",
			"anthropic-ratelimit-message-remaining",
		],
		reset: [
			"anthropic-ratelimit-messages-reset",
			"anthropic-ratelimit-message-reset",
		],
		retryAfter: DEFAULT_RETRY_HEADERS,
	},
];

const GENERIC_MAPPINGS: HeaderFieldMapping[] = [
	{
		dimension: "requests",
		limit: [
			"x-ratelimit-limit-requests",
			"x-rate-limit-limit",
			"ratelimit-limit",
		],
		remaining: [
			"x-ratelimit-remaining-requests",
			"x-rate-limit-remaining",
			"ratelimit-remaining",
		],
		reset: [
			"x-ratelimit-reset-requests",
			"x-rate-limit-reset",
			"ratelimit-reset",
		],
		retryAfter: DEFAULT_RETRY_HEADERS,
	},
	{
		dimension: "tokens",
		limit: "x-ratelimit-limit-tokens",
		remaining: "x-ratelimit-remaining-tokens",
		reset: "x-ratelimit-reset-tokens",
		retryAfter: DEFAULT_RETRY_HEADERS,
	},
];

export function normalizeHeaders(
	headers: Record<string, string>,
): Record<string, string> {
	const normalized: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		normalized[name.toLowerCase()] = String(value).trim();
	}
	return normalized;
}

export function getAdapterMappings(
	adapter: AdapterConfig,
): HeaderFieldMapping[] {
	const configured = [
		...(Array.isArray(adapter.dimensions) ? adapter.dimensions : []),
		...normalizeHeaderMappings(adapter.headers),
	];
	if (configured.length > 0) return configured;
	return adapter.type === "anthropic" ? ANTHROPIC_MAPPINGS : GENERIC_MAPPINGS;
}

export function parseQuotaHeaders(
	headers: Record<string, string>,
	adapter: AdapterConfig,
	now = Date.now(),
	status = 200,
): ParsedQuotaObservation | undefined {
	const normalized = normalizeHeaders(headers);
	const mappings = getAdapterMappings(adapter);
	const dimensions = mappings
		.map((mapping) => parseDimension(normalized, mapping, now))
		.filter(
			(dimension) =>
				dimension.limit !== undefined ||
				dimension.remaining !== undefined ||
				dimension.resetAt !== undefined,
		);
	const retryAt = parseRetryAfterFromMappings(normalized, mappings, now);

	if (status === 429) {
		if (dimensions.length === 0) {
			const resetAt =
				retryAt ??
				parseRetryAfterFromNames(normalized, DEFAULT_RETRY_HEADERS, now);
			return {
				resetAt,
				dimensions: [
					{
						name: "requests",
						limit: 1,
						remaining: 0,
						resetAt,
					},
				],
			};
		}
		const rateLimited = dimensions.map((dimension) => ({
			...dimension,
			limit: dimension.limit ?? 1,
			remaining: 0,
			resetAt: dimension.resetAt ?? retryAt,
		}));
		return { resetAt: retryAt, dimensions: rateLimited };
	}

	const valid = dimensions.filter(
		(dimension) =>
			dimension.limit !== undefined && dimension.remaining !== undefined,
	);
	if (valid.length === 0) return undefined;
	return { resetAt: retryAt, dimensions: valid };
}

export function parseNumberHeader(
	value: string | undefined,
): number | undefined {
	if (!value) return undefined;
	const match = value.match(/-?\d+(?:\.\d+)?/);
	if (!match) return undefined;
	const parsed = Number(match[0]);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseResetTime(
	value: string | undefined,
	now = Date.now(),
): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const duration = parseDurationMs(trimmed);
	if (duration !== undefined) return now + duration;
	const numeric = Number(trimmed);
	if (Number.isFinite(numeric)) {
		if (numeric > 1_000_000_000_000) return numeric;
		if (numeric > 1_000_000_000) return numeric * 1000;
		return now + numeric * 1000;
	}
	const parsedDate = Date.parse(trimmed);
	return Number.isFinite(parsedDate) ? parsedDate : undefined;
}

export function parseDurationMs(value: string): number | undefined {
	const compact = value.trim().toLowerCase();
	if (!compact) return undefined;
	let index = 0;
	let total = 0;
	const matcher = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
	let match: RegExpExecArray | null;
	while ((match = matcher.exec(compact)) !== null) {
		if (match.index !== index) return undefined;
		index = matcher.lastIndex;
		const amount = Number(match[1]);
		const unit = match[2];
		if (!Number.isFinite(amount)) return undefined;
		total += amount * durationUnitMs(unit);
	}
	return index === compact.length && index > 0 ? total : undefined;
}

function durationUnitMs(unit: string | undefined): number {
	switch (unit) {
		case "ms":
			return 1;
		case "s":
			return 1000;
		case "m":
			return 60_000;
		case "h":
			return 3_600_000;
		case "d":
			return 86_400_000;
		default:
			return 0;
	}
}

function parseDimension(
	headers: Record<string, string>,
	mapping: HeaderFieldMapping,
	now: number,
) {
	const retryNames =
		mapping.retryAfter ?? mapping["retry-after"] ?? DEFAULT_RETRY_HEADERS;
	return {
		name: mapping.dimension ?? "requests",
		limit: parseNumberHeader(getFirstHeader(headers, mapping.limit)),
		remaining: parseNumberHeader(getFirstHeader(headers, mapping.remaining)),
		resetAt:
			parseResetTime(getFirstHeader(headers, mapping.reset), now) ??
			parseRetryAfterFromNames(headers, retryNames, now),
	};
}

function parseRetryAfterFromMappings(
	headers: Record<string, string>,
	mappings: HeaderFieldMapping[],
	now: number,
): number | undefined {
	for (const mapping of mappings) {
		const value = parseRetryAfterFromNames(
			headers,
			mapping.retryAfter ?? mapping["retry-after"] ?? DEFAULT_RETRY_HEADERS,
			now,
		);
		if (value !== undefined) return value;
	}
	return parseRetryAfterFromNames(headers, DEFAULT_RETRY_HEADERS, now);
}

function parseRetryAfterFromNames(
	headers: Record<string, string>,
	names: HeaderNames | undefined,
	now: number,
): number | undefined {
	return parseResetTime(getFirstHeader(headers, names), now);
}

function getFirstHeader(
	headers: Record<string, string>,
	names: HeaderNames | undefined,
): string | undefined {
	if (!names) return undefined;
	const list = Array.isArray(names) ? names : [names];
	for (const name of list) {
		const value = headers[name.toLowerCase()];
		if (value !== undefined && value !== "") return value;
	}
	return undefined;
}

function normalizeHeaderMappings(
	headers: AdapterConfig["headers"],
): HeaderFieldMapping[] {
	if (!headers) return [];
	return Array.isArray(headers) ? headers : [headers];
}
