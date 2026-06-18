import type { FooterQuotaSegment, QuotaRow } from "./types.js";

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

export function formatResetTime(
	resetAt: number | undefined,
	now = Date.now(),
): string {
	if (resetAt === undefined) return "unknown";
	if (resetAt <= now) return "now";
	const resetDate = new Date(resetAt);
	const nowDate = new Date(now);
	const time = formatClockTime(resetDate);
	if (sameLocalDate(resetDate, nowDate)) return time;
	if (sameLocalDate(resetDate, addLocalDays(nowDate, 1)))
		return `tomorrow ${time}`;
	if (resetDate.getFullYear() === nowDate.getFullYear())
		return `${MONTHS[resetDate.getMonth()]} ${resetDate.getDate()} ${time}`;
	return `${MONTHS[resetDate.getMonth()]} ${resetDate.getDate()}, ${resetDate.getFullYear()} ${time}`;
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
	return `${percentText} · reset ${formatResetTime(resetAt, now)}`;
}

export function formatCompactFooterText(
	segments: FooterQuotaSegment[],
	now = Date.now(),
): string {
	return segments
		.map((segment) => formatCompactQuotaSegment(segment, now))
		.join(" · ");
}

export function formatCompactQuotaSegment(
	segment: FooterQuotaSegment,
	now = Date.now(),
): string {
	const parts = [
		formatCompactDimensionLabel(segment.dimension.name),
		`${Math.floor(clampPercent(segment.percentRemaining))}%`,
	];
	if (segment.dimension.resetAt !== undefined)
		parts.push(formatCompactResetTime(segment.dimension.resetAt, now));
	return parts.join(" ");
}

export function formatCompactResetTime(
	resetAt: number | undefined,
	now = Date.now(),
): string {
	if (resetAt === undefined) return "unknown";
	if (resetAt <= now) return "now";
	const resetDate = new Date(resetAt);
	const nowDate = new Date(now);
	const time = formatCompactClockTime(resetDate);
	if (sameLocalDate(resetDate, nowDate)) return time;
	if (sameLocalDate(resetDate, addLocalDays(nowDate, 1)))
		return `${time} (tom)`;
	const day = String(resetDate.getDate()).padStart(2, "0");
	const month = String(resetDate.getMonth() + 1).padStart(2, "0");
	if (resetDate.getFullYear() === nowDate.getFullYear())
		return `${time} (${day}/${month})`;
	return `${time} (${day}/${month}/${String(resetDate.getFullYear()).slice(-2)})`;
}

export function formatCompactDimensionLabel(name: string): string {
	const normalized = name.toLowerCase().replace(/[-_]+/g, " ").trim();
	switch (normalized) {
		case "5h":
		case "five hour":
			return "5h";
		case "weekly":
		case "week":
		case "seven day":
			return "Wk";
		case "weekly sonnet":
		case "seven day sonnet":
			return "Son";
		case "weekly opus":
		case "seven day opus":
			return "Opus";
		case "requests":
			return "Req";
		case "tokens":
			return "Tok";
		case "input tokens":
			return "In";
		case "output tokens":
			return "Out";
		case "messages":
			return "Msg";
		default:
			return compactFallbackLabel(name);
	}
}

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

function formatClockTime(date: Date): string {
	const suffix = date.getHours() >= 12 ? "PM" : "AM";
	const hour = date.getHours() % 12 || 12;
	return `${hour}:${String(date.getMinutes()).padStart(2, "0")} ${suffix}`;
}

function formatCompactClockTime(date: Date): string {
	const suffix = date.getHours() >= 12 ? "PM" : "AM";
	const hour = date.getHours() % 12 || 12;
	return `${hour}:${String(date.getMinutes()).padStart(2, "0")}${suffix}`;
}

function compactFallbackLabel(name: string): string {
	const label = name
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => part[0]?.toUpperCase() ?? "")
		.join("");
	return label || "Quota";
}

function sameLocalDate(a: Date, b: Date): boolean {
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

function addLocalDays(date: Date, days: number): Date {
	return new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate() + days,
		date.getHours(),
		date.getMinutes(),
		date.getSeconds(),
		date.getMilliseconds(),
	);
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
