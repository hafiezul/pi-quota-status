import type { QuotaRow } from "./types.js";

export function clampPercent(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(100, value));
}

export function calculatePercent(
	remaining: number | undefined,
	limit: number | undefined,
): number | undefined {
	if (remaining === undefined || limit === undefined || limit <= 0)
		return undefined;
	return clampPercent((remaining / limit) * 100);
}

export function formatPercent(percent: number | undefined): string {
	if (percent === undefined || Number.isNaN(percent)) return "unknown";
	return `${Math.floor(clampPercent(percent))}%`;
}

export function formatCountdown(
	resetAt: number | undefined,
	now = Date.now(),
): string {
	if (resetAt === undefined) return "unknown";
	const ms = resetAt - now;
	if (ms <= 0) return "now";
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (ms < minute) return "<1m";
	if (ms < hour) return `${Math.ceil(ms / minute)}m`;
	if (ms < 48 * hour) return `${Math.ceil(ms / hour)}h`;
	return `${Math.ceil(ms / day)}d`;
}

export function formatFreshness(
	observedAt: number | undefined,
	now = Date.now(),
): string {
	if (observedAt === undefined) return "unknown";
	const ms = Math.max(0, now - observedAt);
	const minute = 60_000;
	const hour = 60 * minute;
	const day = 24 * hour;
	if (ms < minute) return "now";
	if (ms < hour) return `${Math.floor(ms / minute)}m ago`;
	if (ms < day) return `${Math.floor(ms / hour)}h ago`;
	return `${Math.floor(ms / day)}d ago`;
}

export function formatFooterText(
	percent: number,
	resetAt: number | undefined,
	now = Date.now(),
	label = "quota",
): string {
	const percentText = `${label} ${Math.floor(clampPercent(percent))}% left`;
	if (resetAt === undefined) return percentText;
	return `${percentText} · reset ${formatCountdown(resetAt, now)}`;
}

function pad(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - value.length));
}

export function formatRowsAsTable(rows: QuotaRow[]): string {
	if (rows.length === 0) return "No tracked quota data yet.";
	const headers = [
		"provider/model",
		"remaining",
		"reset",
		"source",
		"dimension",
		"freshness",
	];
	const values = rows.map((row) => [
		`${row.provider}/${row.model}`,
		row.percent,
		row.reset,
		row.source,
		row.dimension,
		row.freshness,
	]);
	const widths = headers.map((header, index) =>
		Math.max(header.length, ...values.map((row) => row[index]?.length ?? 0)),
	);
	const headerLine = headers
		.map((header, index) => pad(header, widths[index] ?? header.length))
		.join("  ");
	const divider = widths.map((width) => "-".repeat(width)).join("  ");
	const body = values.map((row) =>
		row
			.map((value, index) => pad(value, widths[index] ?? value.length))
			.join("  "),
	);
	return [headerLine, divider, ...body].join("\n");
}
