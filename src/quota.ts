import type {
	AdapterConfig,
	FixedWindowFallbackConfig,
	FooterQuotaSelection,
	FooterQuotaSegment,
	ModelRef,
	ObservationSource,
	ParsedQuotaObservation,
	QuotaDimensionObservation,
	QuotaObservation,
	QuotaRow,
	QuotaState,
	QuotaStatusConfig,
	SelectedQuota,
} from "./types.js";
import type { PiModel } from "./pi-types.js";
import {
	calculatePercent,
	formatFreshness,
	formatPercent,
	formatResetTime,
} from "./format.js";
import { modelKey, parseModelKey, selectAdapter } from "./match.js";

export function getModelRef(model: PiModel | undefined): ModelRef | undefined {
	if (!model?.provider || !model.id) return undefined;
	return { provider: model.provider, model: model.id };
}

export function observationFromParsed(
	ref: ModelRef,
	adapter: AdapterConfig,
	parsed: ParsedQuotaObservation,
	source: ObservationSource,
	status: number,
	now = Date.now(),
	existing?: QuotaObservation,
): QuotaObservation {
	const dimensions = parsed.dimensions.map((dimension) => {
		const prior = existing?.dimensions.find(
			(candidate) => candidate.name === dimension.name,
		);
		return {
			name: dimension.name,
			limit: dimension.limit ?? prior?.limit,
			remaining: dimension.remaining ?? prior?.remaining,
			resetAt: dimension.resetAt ?? parsed.resetAt ?? prior?.resetAt,
			observedAt: now,
			source,
		};
	});
	return {
		provider: ref.provider,
		model: ref.model,
		adapter: adapter.name ?? adapter.type,
		source,
		status,
		observedAt: now,
		updatedAt: now,
		dimensions,
	};
}

export function upsertObservation(
	state: QuotaState,
	observation: QuotaObservation,
): QuotaState {
	state.observations[modelKey(observation.provider, observation.model)] =
		observation;
	return state;
}

export function ensureFallbackObservation(
	state: QuotaState,
	config: QuotaStatusConfig,
	ref: ModelRef,
	now = Date.now(),
): QuotaObservation | undefined {
	const adapter = selectAdapter(config, ref.provider, ref.model);
	if (!adapter?.fallback || adapter.fallback.enabled === false)
		return undefined;
	const key = modelKey(ref.provider, ref.model);
	const current = state.observations[key];
	const observation = buildFallbackObservation(ref, adapter, current, now);
	if (observation) state.observations[key] = observation;
	return observation;
}

export function consumeFallbackQuota(
	state: QuotaState,
	config: QuotaStatusConfig,
	ref: ModelRef,
	now = Date.now(),
): QuotaObservation | undefined {
	const adapter = selectAdapter(config, ref.provider, ref.model);
	const fallback = adapter?.fallback;
	if (!adapter || !fallback || fallback.enabled === false) return undefined;
	const consume = fallback.consume ?? { unit: "turns", amount: 1 };
	if (consume.unit && consume.unit !== "turns")
		return ensureFallbackObservation(state, config, ref, now);
	const amount = positive(consume.amount, 1);
	const key = modelKey(ref.provider, ref.model);
	const current = state.observations[key];
	const observation = buildFallbackObservation(ref, adapter, current, now);
	if (!observation) return undefined;
	const dimension = observation.dimensions[0];
	if (dimension)
		dimension.remaining = Math.max(
			0,
			(dimension.remaining ?? fallback.limit) - amount,
		);
	observation.observedAt = now;
	observation.updatedAt = now;
	state.observations[key] = observation;
	return observation;
}

export function selectQuotaForModel(
	state: QuotaState,
	config: QuotaStatusConfig,
	ref: ModelRef,
	now = Date.now(),
): SelectedQuota | undefined {
	const observation = selectableObservationForModel(state, config, ref, now);
	if (!observation) return undefined;
	const dimension = selectDimensionForObservation(observation, now);
	if (!dimension) return undefined;
	const percent = calculatePercent(dimension.remaining, dimension.limit);
	if (percent === undefined) return undefined;
	return { observation, dimension, percentRemaining: percent };
}

export function selectFooterQuotaForModel(
	state: QuotaState,
	config: QuotaStatusConfig,
	ref: ModelRef,
	now = Date.now(),
): FooterQuotaSelection | undefined {
	const observation = selectableObservationForModel(state, config, ref, now);
	if (!observation) return undefined;
	const dimensions = selectFooterDimensionsForObservation(
		observation,
		ref,
		now,
	);
	const segments = dimensions
		.map((dimension): FooterQuotaSegment | undefined => {
			const percentRemaining = calculatePercent(
				dimension.remaining,
				dimension.limit,
			);
			return percentRemaining === undefined
				? undefined
				: { dimension, percentRemaining };
		})
		.filter((segment): segment is FooterQuotaSegment => Boolean(segment));
	if (segments.length === 0) return undefined;
	return {
		observation,
		segments,
		percentRemaining: Math.min(
			...segments.map((segment) => segment.percentRemaining),
		),
	};
}

export function selectMostConstrainedDimension(
	dimensions: QuotaDimensionObservation[],
	now = Date.now(),
): QuotaDimensionObservation | undefined {
	let best: QuotaDimensionObservation | undefined;
	let bestPercent = Number.POSITIVE_INFINITY;
	for (const dimension of dimensions) {
		if (dimensionExpired(dimension, now)) continue;
		const percent = calculatePercent(dimension.remaining, dimension.limit);
		if (percent === undefined) continue;
		if (percent < bestPercent) {
			best = dimension;
			bestPercent = percent;
		}
	}
	return best;
}

function selectDimensionForObservation(
	observation: QuotaObservation,
	now: number,
): QuotaDimensionObservation | undefined {
	if (observation.source !== "subscription")
		return selectMostConstrainedDimension(observation.dimensions, now);
	return selectSubscriptionDimension(observation.dimensions, now);
}

function selectFooterDimensionsForObservation(
	observation: QuotaObservation,
	ref: ModelRef,
	now: number,
): QuotaDimensionObservation[] {
	if (observation.source !== "subscription") {
		const selected = selectMostConstrainedDimension(
			observation.dimensions,
			now,
		);
		return selected ? [selected] : [];
	}
	if (ref.provider === "openai-codex")
		return compactDimensionsByName(
			observation.dimensions,
			["5h", "weekly"],
			now,
		);
	if (ref.provider === "anthropic") {
		const shortWindow = findDimensionByNames(
			observation.dimensions,
			["5h"],
			now,
		);
		const weekly = selectAnthropicWeeklyDimension(
			observation.dimensions,
			ref.model,
			now,
		);
		return uniqueDimensions([shortWindow, weekly]);
	}
	const selected = selectSubscriptionDimension(observation.dimensions, now);
	return selected ? [selected] : [];
}

function selectSubscriptionDimension(
	dimensions: QuotaDimensionObservation[],
	now: number,
): QuotaDimensionObservation | undefined {
	const mostConstrained = selectMostConstrainedDimension(dimensions, now);
	if (!mostConstrained) return undefined;
	const constrainedPercent = calculatePercent(
		mostConstrained.remaining,
		mostConstrained.limit,
	);
	if (constrainedPercent !== undefined && constrainedPercent <= 0)
		return mostConstrained;
	return (
		selectMostConstrainedDimension(
			dimensions.filter((dimension) => !isLongSubscriptionWindow(dimension)),
			now,
		) ?? mostConstrained
	);
}

function isLongSubscriptionWindow(
	dimension: QuotaDimensionObservation,
): boolean {
	const name = normalizedDimensionName(dimension.name);
	return /\b(week|weekly|month|monthly|year|yearly|annual|seven day)\b/.test(
		name,
	);
}

function compactDimensionsByName(
	dimensions: QuotaDimensionObservation[],
	names: string[],
	now: number,
): QuotaDimensionObservation[] {
	return names
		.map((name) => findDimensionByNames(dimensions, [name], now))
		.filter((dimension): dimension is QuotaDimensionObservation =>
			Boolean(dimension),
		);
}

function selectAnthropicWeeklyDimension(
	dimensions: QuotaDimensionObservation[],
	model: string,
	now: number,
): QuotaDimensionObservation | undefined {
	const candidates = [
		findDimensionByNames(dimensions, ["weekly", "seven_day"], now),
		...anthropicModelWeeklyNames(model).map((name) =>
			findDimensionByNames(dimensions, [name], now),
		),
	].filter((dimension): dimension is QuotaDimensionObservation =>
		Boolean(dimension),
	);
	if (candidates.length > 0)
		return selectMostConstrainedDimension(candidates, now);
	return selectMostConstrainedDimension(
		dimensions.filter((dimension) => isLongSubscriptionWindow(dimension)),
		now,
	);
}

function anthropicModelWeeklyNames(model: string): string[] {
	const normalized = model.toLowerCase();
	if (normalized.includes("opus")) return ["weekly_opus", "seven_day_opus"];
	if (normalized.includes("sonnet"))
		return ["weekly_sonnet", "seven_day_sonnet"];
	return [];
}

function findDimensionByNames(
	dimensions: QuotaDimensionObservation[],
	names: string[],
	now: number,
): QuotaDimensionObservation | undefined {
	const normalizedNames = new Set(names.map(normalizedDimensionName));
	return dimensions.find(
		(dimension) =>
			normalizedNames.has(normalizedDimensionName(dimension.name)) &&
			!dimensionExpired(dimension, now) &&
			calculatePercent(dimension.remaining, dimension.limit) !== undefined,
	);
}

function uniqueDimensions(
	dimensions: Array<QuotaDimensionObservation | undefined>,
): QuotaDimensionObservation[] {
	const seen = new Set<QuotaDimensionObservation>();
	const result: QuotaDimensionObservation[] = [];
	for (const dimension of dimensions) {
		if (!dimension || seen.has(dimension)) continue;
		seen.add(dimension);
		result.push(dimension);
	}
	return result;
}

function normalizedDimensionName(name: string): string {
	return name.toLowerCase().replace(/[-_]+/g, " ").trim();
}

function dimensionExpired(
	dimension: QuotaDimensionObservation,
	now: number,
): boolean {
	return (
		dimension.resetAt !== undefined &&
		dimension.resetAt <= now &&
		dimension.source !== "fallback"
	);
}

export function buildQuotaRows(
	config: QuotaStatusConfig,
	state: QuotaState,
	models: PiModel[] = [],
	now = Date.now(),
	includeModel?: (ref: ModelRef) => boolean,
): QuotaRow[] {
	const keys = new Set<string>();
	for (const key of Object.keys(state.observations)) keys.add(key);
	for (const model of models) {
		const ref = { provider: model.provider, model: model.id };
		if (
			(!includeModel || includeModel(ref)) &&
			selectAdapter(config, model.provider, model.id)
		)
			keys.add(modelKey(model.provider, model.id));
	}
	const rows: QuotaRow[] = [];
	for (const key of [...keys].sort()) {
		const ref = parseModelKey(key);
		if (!ref) continue;
		if (includeModel && !includeModel(ref)) continue;
		const selected = selectQuotaForModel(state, config, ref, now);
		if (!selected) continue;
		rows.push({
			provider: ref.provider,
			model: ref.model,
			percent: formatPercent(selected.percentRemaining),
			reset:
				selected.dimension.resetAt === undefined
					? "unknown"
					: formatResetTime(selected.dimension.resetAt, now),
			source: selected.observation.source,
			dimension: selected.dimension.name,
			freshness: formatFreshness(selected.dimension.observedAt, now),
		});
	}
	return rows;
}

function selectableObservationForModel(
	state: QuotaState,
	config: QuotaStatusConfig,
	ref: ModelRef,
	now: number,
): QuotaObservation | undefined {
	const key = modelKey(ref.provider, ref.model);
	const stateObservation = state.observations[key];
	const adapter = selectAdapter(config, ref.provider, ref.model);
	return stateObservation?.source === "fallback"
		? buildFallbackObservation(ref, adapter, stateObservation, now)
		: freshHeaderObservation(stateObservation, now);
}

function freshHeaderObservation(
	observation: QuotaObservation | undefined,
	now: number,
): QuotaObservation | undefined {
	if (!observation || observation.source === "fallback") return undefined;
	const dimensions = observation.dimensions.filter(
		(dimension) => dimension.resetAt === undefined || dimension.resetAt > now,
	);
	if (dimensions.length === 0) return undefined;
	return { ...observation, dimensions };
}

function buildFallbackObservation(
	ref: ModelRef,
	adapter: AdapterConfig | undefined,
	existing: QuotaObservation | undefined,
	now: number,
): QuotaObservation | undefined {
	const fallback = adapter?.fallback;
	if (!fallback || fallback.enabled === false) return undefined;
	if (!Number.isFinite(fallback.limit) || fallback.limit <= 0) return undefined;
	if (!Number.isFinite(fallback.windowSeconds) || fallback.windowSeconds <= 0)
		return undefined;
	const dimensionName = fallback.dimension ?? "requests";
	const previous =
		existing?.source === "fallback"
			? existing.dimensions.find(
					(dimension) => dimension.name === dimensionName,
				)
			: undefined;
	const resetAt = computeCurrentResetAt(fallback, previous?.resetAt, now);
	const isSameWindow = previous?.resetAt === resetAt;
	const remaining = isSameWindow
		? clampRemaining(previous?.remaining, fallback.limit)
		: fallback.limit;
	const observedAt = isSameWindow ? (previous?.observedAt ?? now) : now;
	return {
		provider: ref.provider,
		model: ref.model,
		adapter: adapter.name ?? adapter.type,
		source: "fallback",
		status: existing?.status,
		observedAt,
		updatedAt: now,
		dimensions: [
			{
				name: dimensionName,
				limit: fallback.limit,
				remaining,
				resetAt,
				observedAt,
				source: "fallback",
			},
		],
	};
}

function computeCurrentResetAt(
	fallback: FixedWindowFallbackConfig,
	previousResetAt: number | undefined,
	now: number,
): number {
	const windowMs = fallback.windowSeconds * 1000;
	let resetAt =
		previousResetAt ??
		parseConfiguredResetAt(fallback.resetAt) ??
		Math.floor(now / windowMs) * windowMs + windowMs;
	while (resetAt <= now) resetAt += windowMs;
	return resetAt;
}

function parseConfiguredResetAt(
	value: string | number | undefined,
): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isFinite(value)) {
		return value > 1_000_000_000_000 ? value : value * 1000;
	}
	if (typeof value === "string") {
		const numeric = Number(value);
		if (Number.isFinite(numeric))
			return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function clampRemaining(value: number | undefined, limit: number): number {
	if (value === undefined || !Number.isFinite(value)) return limit;
	return Math.max(0, Math.min(limit, value));
}

function positive(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: fallback;
}
