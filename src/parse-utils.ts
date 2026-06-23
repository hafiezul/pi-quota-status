export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

export function booleanValue(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (normalized === "true") return true;
	if (normalized === "false") return false;
	return undefined;
}

export function firstDefined(...values: unknown[]): unknown {
	return values.find((value) => value !== undefined);
}

export function numberValue(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizedUsedPercent(value: unknown): number | undefined {
	const parsed = numberValue(value);
	if (parsed === undefined) return undefined;
	return parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed;
}

export function nullableStringValue(value: unknown): string | null | undefined {
	if (value === null) return null;
	return stringValue(value);
}

export function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed ? trimmed : undefined;
}

export function timestampValue(value: unknown): number | undefined {
	const numeric = numberValue(value);
	if (numeric !== undefined)
		return numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsedDate = Date.parse(value);
	return Number.isFinite(parsedDate) ? parsedDate : undefined;
}
