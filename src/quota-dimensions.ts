import { calculatePercent } from "./format.js";

export interface QuotaDimensionLike {
	name: string;
	limit?: number;
	remaining?: number;
	resetAt?: number;
}

export interface ObservedQuotaDimensionLike extends QuotaDimensionLike {
	source?: string;
}

export function normalizedDimensionName(name: string): string {
	return name.toLowerCase().replace(/[-_]+/g, " ").trim();
}

export function dimensionPercentRemaining(
	dimension: QuotaDimensionLike | undefined,
): number | undefined {
	return calculatePercent(dimension?.remaining, dimension?.limit);
}

export function findDimensionByNames<T extends QuotaDimensionLike>(
	dimensions: T[],
	names: string[],
): T | undefined {
	const normalizedNames = new Set(names.map(normalizedDimensionName));
	return dimensions.find(
		(dimension) =>
			normalizedNames.has(normalizedDimensionName(dimension.name)) &&
			dimensionPercentRemaining(dimension) !== undefined,
	);
}

export function findCurrentDimensionByNames<
	T extends ObservedQuotaDimensionLike,
>(dimensions: T[], names: string[], now: number): T | undefined {
	return findDimensionByNames(
		dimensions.filter((dimension) => !dimensionExpired(dimension, now)),
		names,
	);
}

export function dimensionExpired(
	dimension: ObservedQuotaDimensionLike,
	now: number,
): boolean {
	return (
		dimension.resetAt !== undefined &&
		dimension.resetAt <= now &&
		dimension.source !== "fallback"
	);
}

export function mergeDimensionsByName<T extends QuotaDimensionLike>(
	base: T[],
	replacements: T[],
): T[] {
	const replacementsByName = new Map(
		replacements.map((dimension) => [
			normalizedDimensionName(dimension.name),
			dimension,
		]),
	);
	const seen = new Set<string>();
	const merged = base.map((dimension) => {
		const key = normalizedDimensionName(dimension.name);
		seen.add(key);
		return replacementsByName.get(key) ?? dimension;
	});
	for (const dimension of replacements) {
		const key = normalizedDimensionName(dimension.name);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(dimension);
	}
	return merged;
}
