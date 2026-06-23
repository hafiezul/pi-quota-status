import type {
	ParsedQuotaMetadata,
	ParsedQuotaObservation,
	PendingQuotaObservation,
	QuotaDimensionObservation,
	QuotaObservation,
} from "./types.js";
import {
	dimensionPercentRemaining,
	findCurrentDimensionByNames,
	findDimensionByNames,
	mergeDimensionsByName,
	normalizedDimensionName,
} from "./quota-dimensions.js";

export const OPENAI_CODEX_PROVIDER = "openai-codex";
export const CODEX_SHORT_WINDOW = "5h";
export const CODEX_WEEKLY_WINDOW = "weekly";

const NEAR_ZERO_PERCENT = 5;
const TRUSTED_PRIOR_PERCENT = 50;
const PENDING_CONFIRM_TOLERANCE_PERCENT = 2;
const RESET_WINDOW_SLOP_MS = 120_000;
const CODEX_SHORT_WINDOW_MS = 5 * 60 * 60 * 1000;

export interface CodexSubscriptionDropVerdict {
	reason: string;
	confirmable: boolean;
}

export function needsCodexCliReconciliation(
	parsed: ParsedQuotaObservation,
): boolean {
	const shortWindow = findDimensionByNames(parsed.dimensions, [
		CODEX_SHORT_WINDOW,
	]);
	const percentRemaining = dimensionPercentRemaining(shortWindow);
	return Boolean(
		percentRemaining !== undefined &&
			percentRemaining <= NEAR_ZERO_PERCENT &&
			isHealthyCodexMetadata(parsed.metadata),
	);
}

export function mergeCodexCliRateLimits(
	parsed: ParsedQuotaObservation,
	cliParsed: ParsedQuotaObservation | undefined,
): ParsedQuotaObservation | undefined {
	if (!cliParsed || cliParsed.dimensions.length === 0) return undefined;
	const cliShortWindow = findDimensionByNames(cliParsed.dimensions, [
		CODEX_SHORT_WINDOW,
	]);
	const cliShortRemaining = dimensionPercentRemaining(cliShortWindow);
	if (cliShortRemaining === undefined || cliShortRemaining <= NEAR_ZERO_PERCENT)
		return undefined;
	return {
		...parsed,
		dimensions: mergeDimensionsByName(parsed.dimensions, cliParsed.dimensions),
		metadata: {
			...parsed.metadata,
			...cliParsed.metadata,
			codexCliRpcFallback: true,
		},
	};
}

export function classifyCodexSubscriptionDrop(
	existing: QuotaObservation | undefined,
	observation: QuotaObservation,
	now: number,
): CodexSubscriptionDropVerdict | undefined {
	if (!isCodexSubscriptionObservation(observation)) return undefined;
	const next = findCurrentDimensionByNames(
		observation.dimensions,
		[CODEX_SHORT_WINDOW],
		now,
	);
	const nextPercent = dimensionPercentRemaining(next);
	if (nextPercent === undefined || nextPercent > NEAR_ZERO_PERCENT)
		return undefined;
	if (isHealthyCodexMetadata(observation.metadata)) {
		return {
			reason:
				"near-zero Codex 5h quota contradicted by allowed subscription metadata",
			confirmable: false,
		};
	}
	if (existing?.source !== "subscription") return undefined;
	const prior = findDimensionByNames(existing.dimensions, [CODEX_SHORT_WINDOW]);
	const priorPercent = dimensionPercentRemaining(prior);
	if (priorPercent === undefined || priorPercent < TRUSTED_PRIOR_PERCENT)
		return undefined;
	if (sameResetWindow(prior?.resetAt, next?.resetAt)) {
		return {
			reason: "high-to-low same-window Codex 5h quota drop",
			confirmable: true,
		};
	}
	if (resetWindowAdvancedRecently(prior?.resetAt, next?.resetAt, now)) {
		return {
			reason: "high-to-low Codex 5h quota drop after window rollover",
			confirmable: true,
		};
	}
	return undefined;
}

export function codexPendingObservationConfirms(
	pending: PendingQuotaObservation | undefined,
	observation: QuotaObservation,
	now: number,
): boolean {
	if (!pending) return false;
	if (
		isHealthyCodexMetadata(pending.observation.metadata) ||
		isHealthyCodexMetadata(observation.metadata)
	)
		return false;
	const pendingDimension = findCurrentDimensionByNames(
		pending.observation.dimensions,
		[CODEX_SHORT_WINDOW],
		now,
	);
	const nextDimension = findCurrentDimensionByNames(
		observation.dimensions,
		[CODEX_SHORT_WINDOW],
		now,
	);
	const pendingPercent = dimensionPercentRemaining(pendingDimension);
	const nextPercent = dimensionPercentRemaining(nextDimension);
	return Boolean(
		pendingPercent !== undefined &&
			nextPercent !== undefined &&
			pendingPercent <= NEAR_ZERO_PERCENT &&
			nextPercent <= NEAR_ZERO_PERCENT &&
			Math.abs(pendingPercent - nextPercent) <=
				PENDING_CONFIRM_TOLERANCE_PERCENT &&
			sameResetWindow(pendingDimension?.resetAt, nextDimension?.resetAt),
	);
}

export function shouldHideCodexHealthyStaleDimension(
	observation: QuotaObservation,
	dimension: QuotaDimensionObservation,
): boolean {
	if (!isCodexSubscriptionObservation(observation)) return false;
	if (!isHealthyCodexMetadata(observation.metadata)) return false;
	if (normalizedDimensionName(dimension.name) !== CODEX_SHORT_WINDOW)
		return false;
	const percent = dimensionPercentRemaining(dimension);
	return percent !== undefined && percent <= NEAR_ZERO_PERCENT;
}

export function isExplicitQuotaBlock(
	metadata: ParsedQuotaMetadata | undefined,
): boolean {
	return Boolean(
		metadata?.allowed === false ||
			metadata?.limitReached === true ||
			(metadata?.rateLimitReachedType !== undefined &&
				metadata.rateLimitReachedType !== null &&
				metadata.rateLimitReachedType !== ""),
	);
}

export function isHealthyCodexMetadata(
	metadata: ParsedQuotaMetadata | undefined,
): boolean {
	return Boolean(
		metadata?.allowed === true &&
			metadata?.limitReached === false &&
			(metadata.rateLimitReachedType === undefined ||
				metadata.rateLimitReachedType === null ||
				metadata.rateLimitReachedType === ""),
	);
}

export function sameResetWindow(
	left: number | undefined,
	right: number | undefined,
): boolean {
	if (left === undefined || right === undefined) return false;
	return Math.abs(left - right) <= RESET_WINDOW_SLOP_MS;
}

function resetWindowAdvancedRecently(
	left: number | undefined,
	right: number | undefined,
	now: number,
): boolean {
	if (left === undefined || right === undefined) return false;
	const justCrossedPriorReset =
		left <= now && now - left <= RESET_WINDOW_SLOP_MS;
	const nextResetIsOneShortWindowLater =
		Math.abs(right - (left + CODEX_SHORT_WINDOW_MS)) <= RESET_WINDOW_SLOP_MS;
	return justCrossedPriorReset && nextResetIsOneShortWindowLater;
}

function isCodexSubscriptionObservation(
	observation: QuotaObservation,
): boolean {
	return (
		observation.provider === OPENAI_CODEX_PROVIDER &&
		observation.source === "subscription"
	);
}
