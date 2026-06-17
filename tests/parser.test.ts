import test from "node:test";
import assert from "node:assert/strict";
import {
	parseDurationMs,
	parseQuotaHeaders,
	parseResetTime,
} from "../src/adapters.js";
import type { AdapterConfig } from "../src/types.js";

const now = Date.UTC(2026, 0, 1, 0, 0, 0);

test("parses compact durations", () => {
	assert.equal(parseDurationMs("500ms"), 500);
	assert.equal(parseDurationMs("1h30m"), 5_400_000);
	assert.equal(parseDurationMs("6m0s"), 360_000);
	assert.equal(parseDurationMs("not a duration"), undefined);
});

test("parses reset timestamps, epoch seconds, and retry-after seconds", () => {
	assert.equal(parseResetTime("60", now), now + 60_000);
	assert.equal(parseResetTime("1700000000", now), 1_700_000_000_000);
	assert.equal(
		parseResetTime("2026-01-01T03:00:00Z", now),
		Date.UTC(2026, 0, 1, 3, 0, 0),
	);
});

test("generic adapter parses multiple dimensions", () => {
	const adapter: AdapterConfig = {
		type: "generic",
		dimensions: [
			{
				dimension: "requests",
				limit: "x-ratelimit-limit-requests",
				remaining: "x-ratelimit-remaining-requests",
				reset: "x-ratelimit-reset-requests",
			},
			{
				dimension: "tokens",
				limit: "x-ratelimit-limit-tokens",
				remaining: "x-ratelimit-remaining-tokens",
				reset: "x-ratelimit-reset-tokens",
			},
		],
	};
	const parsed = parseQuotaHeaders(
		{
			"x-ratelimit-limit-requests": "100",
			"x-ratelimit-remaining-requests": "72",
			"x-ratelimit-reset-requests": "3h",
			"x-ratelimit-limit-tokens": "1000",
			"x-ratelimit-remaining-tokens": "80",
			"x-ratelimit-reset-tokens": "1h",
		},
		adapter,
		now,
	);
	assert.equal(parsed?.dimensions.length, 2);
	assert.equal(
		parsed?.dimensions.find((dimension) => dimension.name === "tokens")
			?.remaining,
		80,
	);
});

test("anthropic adapter parses public-style rate-limit headers", () => {
	const parsed = parseQuotaHeaders(
		{
			"anthropic-ratelimit-requests-limit": "4000",
			"anthropic-ratelimit-requests-remaining": "3999",
			"anthropic-ratelimit-requests-reset": "2026-01-01T00:05:00Z",
		},
		{ type: "anthropic" },
		now,
	);
	assert.equal(parsed?.dimensions[0]?.name, "requests");
	assert.equal(parsed?.dimensions[0]?.limit, 4000);
	assert.equal(parsed?.dimensions[0]?.resetAt, Date.UTC(2026, 0, 1, 0, 5, 0));
});

test("429 retry-after becomes zero remaining", () => {
	const parsed = parseQuotaHeaders(
		{ "retry-after": "120" },
		{ type: "generic" },
		now,
		429,
	);
	assert.equal(parsed?.dimensions[0]?.remaining, 0);
	assert.equal(parsed?.dimensions[0]?.limit, 1);
	assert.equal(parsed?.dimensions[0]?.resetAt, now + 120_000);
});
