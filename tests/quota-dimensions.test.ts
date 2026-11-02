import test from "node:test";
import assert from "node:assert/strict";
import { findCurrentDimensionByNames } from "../src/quota-dimensions.js";

test("current dimension lookup preserves order, expiration, and validity", () => {
	const expired = { name: "Five-Hour", limit: 10, remaining: 5, resetAt: 100 };
	const invalid = { name: "five_hour", limit: 0, remaining: 5 };
	const first = { name: " FIVE_HOUR ", limit: 10, remaining: 0 };
	const duplicate = { name: "five-hour", limit: 10, remaining: 8 };
	assert.equal(
		findCurrentDimensionByNames([expired, invalid, first, duplicate], ["five-hour"], 100),
		first,
	);
	assert.equal(findCurrentDimensionByNames([expired, invalid], ["five hour"], 100), undefined);
});

test("fallback dimensions remain current after reset", () => {
	const fallback = { name: "weekly", limit: 10, remaining: 4, resetAt: 99, source: "fallback" };
	const later = { name: "weekly", limit: 10, remaining: 7 };
	assert.equal(findCurrentDimensionByNames([fallback, later], ["WEEKLY"], 100), fallback);
});
