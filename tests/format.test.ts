import test from "node:test";
import assert from "node:assert/strict";
import { formatFooterText, formatResetTime } from "../src/format.js";

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
