import { join } from "node:path";
import { homedir } from "node:os";

export interface QuotaStatusPaths {
	dataDir: string;
	configFile: string;
	stateFile: string;
}

export function getQuotaStatusPaths(): QuotaStatusPaths {
	const dataDir =
		process.env.PI_QUOTA_STATUS_DIR ??
		join(homedir(), ".pi", "agent", "pi-quota-status");
	return {
		dataDir,
		configFile: join(dataDir, "config.json"),
		stateFile: join(dataDir, "state.json"),
	};
}
