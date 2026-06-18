import test from "node:test";
import assert from "node:assert/strict";
import {
	formatCompactDimensionLabel,
	formatCompactFooterText,
	formatCompactResetTime,
	formatFooterText,
	formatResetTime,
} from "../src/format.js";

test("reset display uses actual local time for same-day resets", () => {
	const now = new Date(2026, 5, 17, 12, 7, 0).getTime();
	const resetAt = new Date(2026, 5, 17, 16, 20, 0).getTime();

	assert.equal(formatResetTime(resetAt, now), "4:20 PM");
	assert.equal(
		formatFooterText(55, resetAt, now),
		"quota 55% left · reset 4:20 PM",
	);
});

test("reset display labels tomorrow without rounding hours", () => {
	const now = new Date(2026, 5, 17, 23, 55, 0).getTime();
	const resetAt = new Date(2026, 5, 18, 0, 20, 0).getTime();

	assert.equal(formatResetTime(resetAt, now), "tomorrow 12:20 AM");
});

test("compact reset display uses terse qualifiers", () => {
	const now = new Date(2026, 5, 17, 12, 7, 0).getTime();

	assert.equal(
		formatCompactResetTime(new Date(2026, 5, 17, 13, 57, 0).getTime(), now),
		"1:57PM",
	);
	assert.equal(
		formatCompactResetTime(new Date(2026, 5, 18, 1, 0, 0).getTime(), now),
		"1:00AM (tom)",
	);
	assert.equal(
		formatCompactResetTime(new Date(2026, 5, 28, 8, 57, 0).getTime(), now),
		"8:57AM (28/06)",
	);
	assert.equal(
		formatCompactResetTime(new Date(2027, 0, 2, 8, 57, 0).getTime(), now),
		"8:57AM (02/01/27)",
	);
});

test("compact footer renders multiple quota windows", () => {
	const now = new Date(2026, 5, 17, 12, 7, 0).getTime();
	assert.equal(formatCompactDimensionLabel("weekly_sonnet"), "Son");
	assert.equal(
		formatCompactFooterText(
			[
				{
					percentRemaining: 78.9,
					dimension: {
						name: "5h",
						limit: 100,
						remaining: 78.9,
						resetAt: new Date(2026, 5, 17, 13, 57, 0).getTime(),
						observedAt: now,
						source: "subscription",
					},
				},
				{
					percentRemaining: 30,
					dimension: {
						name: "weekly",
						limit: 100,
						remaining: 30,
						resetAt: new Date(2026, 5, 28, 8, 57, 0).getTime(),
						observedAt: now,
						source: "subscription",
					},
				},
			],
			now,
		),
		"5h 78% 1:57PM · Wk 30% 8:57AM (28/06)",
	);
});
