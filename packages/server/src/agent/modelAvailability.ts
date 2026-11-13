import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

const CHATGPT_SIGN_IN_BASE_URL = "https://api.openai.com/v1";
const CHATGPT_ALLOWLIST_PROVIDER = "openai-codex";

export type ModelAvailabilityRuntime = Pick<
	ModelRuntime,
	"getAvailableSnapshot" | "getModels" | "isUsingOAuth"
>;

export function accountAvailableModels(runtime: ModelAvailabilityRuntime): readonly Model<Api>[] {
	const snapshot = runtime.getAvailableSnapshot();
	const chatgpt = chatgptAllowlist(runtime);
	if (!chatgpt) return snapshot;
	return snapshot.filter(
		(model) =>
			model.provider !== "openai" ||
			model.baseUrl !== CHATGPT_SIGN_IN_BASE_URL ||
			chatgpt.has(model.id),
	);
}

function chatgptAllowlist(runtime: ModelAvailabilityRuntime): ReadonlySet<string> | undefined {
	if (!runtime.isUsingOAuth("openai")) return undefined;
	const ids = new Set(runtime.getModels(CHATGPT_ALLOWLIST_PROVIDER).map((model) => model.id));
	return ids.size > 0 ? ids : undefined;
}
