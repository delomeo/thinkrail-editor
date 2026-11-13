import {
	createAgentSessionServices,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { logger } from "../log";
import { accountAvailableModels, type ModelAvailabilityRuntime } from "./modelAvailability";

const log = logger("agent");

export interface PiRuntimeGeneration {
	readonly id: number;
	readonly runtime: ModelRuntime;
	readonly providerStatusIds: ReadonlySet<string>;
	readonly additionalExtensionPaths: readonly string[];
}

export type PiRuntimeGenerationInitializer = (runtime: ModelRuntime) => void | Promise<void>;

export const piLoginOptions: NonNullable<Parameters<ModelRuntime["login"]>[3]> = {
	getDeviceId: () => SettingsManager.create(process.cwd()).getOrCreateDeviceId(),
};

let nextGenerationId = 1;
let activeGeneration: Promise<PiRuntimeGeneration> | null = null;
let configuredExtensionPaths: readonly string[] = [];
let runtimeFactory: (additionalExtensionPaths: readonly string[]) => Promise<ModelRuntime> =
	createRuntimeWithExtensions;
let generationInitializer: PiRuntimeGenerationInitializer = () => {};

function captureProviderIds(runtime: ModelRuntime): ReadonlySet<string> {
	return new Set((runtime.getProviders?.() ?? []).map((provider) => provider.id));
}

export function configurePiRuntime(rt: ModelRuntime | null): void {
	configuredExtensionPaths = [];
	if (!rt) {
		activeGeneration = null;
		return;
	}
	activeGeneration = Promise.resolve({
		id: nextGenerationId++,
		runtime: rt,
		providerStatusIds: captureProviderIds(rt),
		additionalExtensionPaths: [],
	});
}

export function configurePiRuntimeFactory(
	factory?: (additionalExtensionPaths: readonly string[]) => Promise<ModelRuntime>,
): void {
	runtimeFactory = factory
		? async (additionalExtensionPaths) => {
				const runtime = await factory(additionalExtensionPaths);
				await generationInitializer(runtime);
				return runtime;
			}
		: createRuntimeWithExtensions;
}

export function configurePiRuntimeGenerationInitializer(
	initializer?: PiRuntimeGenerationInitializer,
): void {
	if (activeGeneration) throw new Error("PI runtime already initialized");
	generationInitializer = initializer ?? (() => {});
}

async function createRuntimeOfflineByDefault(): Promise<ModelRuntime> {
	const prior = process.env.PI_OFFLINE;
	process.env.PI_OFFLINE = "1";
	try {
		return await ModelRuntime.create({ allowModelNetwork: false });
	} finally {
		if (prior === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = prior;
	}
}

async function advanceExtensionCacheGeneration(): Promise<void> {
	const agentDir = getAgentDir();
	const loader = new DefaultResourceLoader({
		cwd: agentDir,
		agentDir,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await loader.reload();
	await loader.reload();
}

async function createRuntimeWithExtensions(
	additionalExtensionPaths: readonly string[],
): Promise<ModelRuntime> {
	await advanceExtensionCacheGeneration();
	const runtime = await createRuntimeOfflineByDefault();
	await generationInitializer(runtime);
	const priorJitiRebuild = process.env.JITI_REBUILD_FS_CACHE;
	const priorJitiTryNative = process.env.JITI_TRY_NATIVE;
	process.env.JITI_REBUILD_FS_CACHE = "1";
	process.env.JITI_TRY_NATIVE = "false";
	let services: Awaited<ReturnType<typeof createAgentSessionServices>>;
	try {
		services = await createAgentSessionServices({
			cwd: getAgentDir(),
			modelRuntime: runtime,
			resourceLoaderOptions: {
				noExtensions: true,
				additionalExtensionPaths: [...additionalExtensionPaths],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
	} finally {
		if (priorJitiRebuild === undefined) delete process.env.JITI_REBUILD_FS_CACHE;
		else process.env.JITI_REBUILD_FS_CACHE = priorJitiRebuild;
		if (priorJitiTryNative === undefined) delete process.env.JITI_TRY_NATIVE;
		else process.env.JITI_TRY_NATIVE = priorJitiTryNative;
	}
	const extensionErrors = services.resourceLoader.getExtensions().errors;
	if (
		extensionErrors.length > 0 ||
		services.diagnostics.some((diagnostic) => diagnostic.type === "error")
	) {
		throw new Error("PI runtime extension loading failed");
	}
	return runtime;
}

async function createGeneration(paths: readonly string[]): Promise<PiRuntimeGeneration> {
	const additionalExtensionPaths = [...new Set(paths)];
	const runtime = await runtimeFactory(additionalExtensionPaths);
	return {
		id: nextGenerationId++,
		runtime,
		providerStatusIds: captureProviderIds(runtime),
		additionalExtensionPaths,
	};
}

export function getPiRuntimeGeneration(): Promise<PiRuntimeGeneration> {
	if (!activeGeneration) {
		const created = createGeneration(configuredExtensionPaths);
		activeGeneration = created;
		created.catch(() => {
			if (activeGeneration === created) activeGeneration = null;
		});
	}
	return activeGeneration;
}

export async function getPiRuntime(): Promise<ModelRuntime> {
	return (await getPiRuntimeGeneration()).runtime;
}

export type AvailableModelsRuntime = ModelAvailabilityRuntime;

export function settledAvailableModels(
	runtime: AvailableModelsRuntime,
): ReturnType<ModelRuntime["getAvailableSnapshot"]> {
	return accountAvailableModels(runtime);
}

export type CatalogRefreshRuntime = Pick<ModelRuntime, "refresh">;

export interface CatalogRefreshOutcome {
	completed: boolean;
}

const inflightCatalogRefresh = new WeakMap<
	CatalogRefreshRuntime,
	{ task: Promise<void>; force: boolean }
>();

const CATALOG_REFRESH_TIMEOUT_MS = 15_000;

export function refreshCatalogs(
	runtime: CatalogRefreshRuntime,
	{ force = false }: { force?: boolean } = {},
): Promise<CatalogRefreshOutcome> {
	if (process.env.PI_OFFLINE) return Promise.resolve({ completed: true });
	const existing = inflightCatalogRefresh.get(runtime);
	if (existing && (existing.force || !force)) return withDeadline(existing.task);
	const started = existing
		? existing.task.then(() => runCatalogRefresh(runtime, force))
		: runCatalogRefresh(runtime, force);
	const task: Promise<void> = started.finally(() => {
		if (inflightCatalogRefresh.get(runtime)?.task === task) {
			inflightCatalogRefresh.delete(runtime);
		}
	});
	inflightCatalogRefresh.set(runtime, { task, force });
	return withDeadline(task);
}

function withDeadline(task: Promise<void>): Promise<CatalogRefreshOutcome> {
	return new Promise<CatalogRefreshOutcome>((resolve) => {
		const timer = setTimeout(() => {
			log.warn(
				`model catalog refresh exceeded ${CATALOG_REFRESH_TIMEOUT_MS}ms; serving cached catalogs`,
			);
			resolve({ completed: false });
		}, CATALOG_REFRESH_TIMEOUT_MS);
		timer.unref?.();
		void task.then(() => {
			clearTimeout(timer);
			resolve({ completed: true });
		});
	});
}

function runCatalogRefresh(runtime: CatalogRefreshRuntime, force: boolean): Promise<void> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CATALOG_REFRESH_TIMEOUT_MS);
	timer.unref?.();
	return runtime
		.refresh({ allowNetwork: true, force, signal: controller.signal })
		.then((result) => {
			if (result.aborted) {
				log.warn(
					`model catalog refresh timed out after ${CATALOG_REFRESH_TIMEOUT_MS}ms; serving cached catalogs`,
				);
			} else if (result.errors.size > 0) {
				log.warn(`model catalog refresh: ${result.errors.size} provider(s) failed`);
			}
		})
		.catch(() => {
			log.warn("model catalog refresh failed");
		})
		.finally(() => clearTimeout(timer));
}

export function refreshCatalogsDetached(runtime: CatalogRefreshRuntime): void {
	void refreshCatalogs(runtime);
}
