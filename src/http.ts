export const QUOTA_HTTP_TIMEOUT_MS = 10_000;

export interface QuotaRequestInit {
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
}

export interface QuotaJsonResponse {
	ok: boolean;
	status: number;
	json?: unknown;
}

export async function fetchQuotaJsonWithTimeout(
	fetchImpl: typeof globalThis.fetch,
	input: string,
	init: QuotaRequestInit,
): Promise<QuotaJsonResponse> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), QUOTA_HTTP_TIMEOUT_MS);
	try {
		const response = await fetchImpl(input, { ...init, signal: controller.signal });
		const { ok, status } = response;
		if (!ok) {
			await response.arrayBuffer();
			return { ok, status };
		}
		return { ok, status, json: await response.json() };
	} finally {
		clearTimeout(timer);
	}
}
