import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexCliRateLimitsResult } from "../src/codex-rpc.js";

const now = Date.UTC(2026, 0, 1, 0, 0, 0);

test("Codex CLI RPC rate limits parse session and weekly windows", () => {
	const parsed = parseCodexCliRateLimitsResult(
		{
			rateLimits: {
				primary: {
					usedPercent: 9,
					windowDurationMins: 300,
					resetsAt: 1_767_217_391,
				},
				secondary: {
					usedPercent: 36,
					windowDurationMins: 10_080,
					resetsAt: 1_767_805_246,
				},
				planType: "plus",
				rateLimitReachedType: null,
			},
		},
		now,
	);

	assert.deepEqual(
		parsed?.dimensions.map((dimension) => ({
			name: dimension.name,
			remaining: dimension.remaining,
			resetAt: dimension.resetAt,
		})),
		[
			{ name: "5h", remaining: 91, resetAt: 1_767_217_391_000 },
			{ name: "weekly", remaining: 64, resetAt: 1_767_805_246_000 },
		],
	);
	assert.equal(parsed?.metadata?.rateLimitReachedType, null);
});

test("Codex CLI RPC rate limits normalize swapped window roles", () => {
	const parsed = parseCodexCliRateLimitsResult(
		{
			result: {
				rateLimits: {
					primary: {
						usedPercent: 35,
						windowDurationMins: 10_080,
						resetsAt: 1_767_805_246,
					},
					secondary: {
						usedPercent: 9,
						windowDurationMins: 300,
						resetsAt: 1_767_217_391,
					},
				},
			},
		},
		now,
	);

	assert.deepEqual(
		parsed?.dimensions.map((dimension) => dimension.name),
		["5h", "weekly"],
	);
	assert.equal(parsed?.dimensions[0]?.remaining, 91);
	assert.equal(parsed?.dimensions[1]?.remaining, 65);
});
