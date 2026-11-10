import { appendFileSync, readFileSync } from "node:fs";

// Installed after Pi's HTTP dispatcher so every extension request stays offline.
export function installFixtureFetch() {
	globalThis.fetch = async (input, init = {}) => {
		const fixture = JSON.parse(readFileSync(process.env.PI_QUOTA_TEST_CASE, "utf8"));
		const { mode } = JSON.parse(readFileSync(process.env.PI_QUOTA_TEST_CONTROL, "utf8"));
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		const method = init.method ?? "GET";
		const index = fixture.routes.findIndex((route) => {
			if (url.origin + url.pathname !== route.url) return false;
			if (route.queryContains && !url.searchParams.get("query")?.includes(route.queryContains))
				return false;
			return Object.entries(route.query ?? {}).every(
				([key, value]) =>
					url.searchParams.get(key) === value ||
					(mode === "invalid-shape" && key === "orgId" && !url.searchParams.has(key)),
			);
		});
		const route = fixture.routes[index];
		const headers = new Headers(init.headers);
		const valid =
			route &&
			method === (route.method ?? "GET") &&
			headers.get("authorization") === "Bearer fixture-token" &&
			Object.entries(route.headers ?? {}).every(([key, value]) => headers.get(key) === value) &&
			(!route.requestBody ||
				JSON.stringify(JSON.parse(init.body)) === JSON.stringify(route.requestBody));
		appendFileSync(
			process.env.PI_QUOTA_TEST_REQUESTS,
			`${JSON.stringify({ url: url.origin + url.pathname, method, mode, matched: Boolean(valid) })}\n`,
		);
		if (!valid)
			throw new Error(`Unexpected fixture request: ${method} ${url.origin}${url.pathname}`);
		if (mode === "network-error") throw new TypeError("Synthetic network failure");
		if (mode.startsWith("http-"))
			return Response.json({}, { status: Number(mode.slice(5)), headers: { "retry-after": "60" } });
		if (mode === "invalid-json")
			return new Response("{", { headers: { "content-type": "application/json" } });
		if (mode === "invalid-shape") return Response.json({ unexpected: "shape" });
		if (mode === "overflow")
			return Response.json({ status: "success", data: { result: [{ value: [1, "1e308"] }] } });
		if (mode === "fallback" && index < fixture.routes.length - 1)
			return Response.json({}, { status: 404 });
		if (mode === "optional-unavailable" && index === 1) return Response.json({}, { status: 503 });
		return Response.json(route.body);
	};
}
