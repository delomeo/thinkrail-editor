import { afterEach, beforeEach, expect, test } from "bun:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PI_DEFAULT_MODEL_PER_PROVIDER, preferredDefaultModel } from "./modelDefaults";
import { settledAvailableModels } from "./piRuntime";

let priorOffline: string | undefined;

beforeEach(() => {
	priorOffline = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
});

afterEach(() => {
	if (priorOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = priorOffline;
});

async function runtimeWith(
	credentials: Record<string, Parameters<InMemoryCredentialStore["modify"]>[1]>,
): Promise<ModelRuntime> {
	const store = new InMemoryCredentialStore();
	for (const [providerId, credential] of Object.entries(credentials))
		await store.modify(providerId, credential);
	const runtime = await ModelRuntime.create({
		credentials: store,
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

function modelIds(runtime: ModelRuntime, provider: string): string[] {
	return settledAvailableModels(runtime)
		.filter((model) => model.provider === provider)
		.map((model) => model.id);
}

test("Sign in with ChatGPT offers only the models the ChatGPT backend serves", async () => {
	const runtime = await runtimeWith({
		openai: async () => ({
			type: "oauth",
			access: "chatgpt-access",
			refresh: "chatgpt-refresh",
			expires: Date.now() + 86_400_000,
		}),
	});
	const chatgpt = runtime.getModels("openai-codex").map((model) => model.id);
	const offered = modelIds(runtime, "openai");
	expect(offered.length).toBeGreaterThan(0);
	expect(offered).not.toContain("gpt-4");
	expect(offered.every((id) => chatgpt.includes(id))).toBe(true);
	expect(preferredDefaultModel(settledAvailableModels(runtime))?.id).toBe(
		PI_DEFAULT_MODEL_PER_PROVIDER["openai-codex"],
	);
});

test("an OpenAI API key keeps the full OpenAI catalog", async () => {
	const runtime = await runtimeWith({
		openai: async () => ({ type: "api_key", key: "sk-test" }),
	});
	expect(modelIds(runtime, "openai")).toContain("gpt-4");
});
