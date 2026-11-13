import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parse } from "jsonc-parser";
import { logger } from "../log";

const log = logger("lsp");

/** The directory names a project keeps its Python environment in. */
const ENVIRONMENT_NAMES = [".venv", "venv", "env", ".conda"];

/** Conda distributions put a named environment under `~/<distribution>/envs/<name>`. */
const NAMED_ENVIRONMENT_ROOTS = [
	".virtualenvs",
	"miniconda3/envs",
	"anaconda3/envs",
	"miniforge3/envs",
];

const CONFIG_FILE = "pyrightconfig.json";

export interface PythonEnvironment {
	/** The interpreter to ask for search paths: absolute, or the bare name used when nothing was found. */
	readonly pythonPath: string;
	/** pyright's own spelling: the directory that holds the environment and the environment's own name. */
	readonly venvPath: string | undefined;
	readonly venvName: string | undefined;
	/** The `site-packages` directories of the environment found: the third-party sources it installed. */
	readonly sitePackagesPaths: readonly string[];
}

function stat(path: string): ReturnType<typeof statSync> | undefined {
	try {
		return statSync(path);
	} catch {
		return undefined;
	}
}

function isDirectory(path: string): boolean {
	return stat(path)?.isDirectory() === true;
}

function isFile(path: string): boolean {
	return stat(path)?.isFile() === true;
}

function readdir(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

/** An environment directory that names no interpreter holds no environment. `python3.12` alone, which is
 * what `uv` writes beside its own `python` symlink, counts. */
function interpreterOf(envRoot: string): string | undefined {
	for (const bin of ["bin", "Scripts"]) {
		const dir = join(envRoot, bin);
		const name = readdir(dir).find(
			(candidate) => /^python(\d+\.\d+)?(\.exe)?$/.test(candidate) && isFile(join(dir, candidate)),
		);
		if (name !== undefined) return join(dir, name);
	}
	return undefined;
}

const noEnvironment = (pythonPath: string): PythonEnvironment => ({
	pythonPath,
	venvPath: undefined,
	venvName: undefined,
	sitePackagesPaths: [],
});

/** `<env>/lib/python3.11/site-packages`, its `lib64` twin, and the Windows `<env>/Lib/site-packages`. */
function sitePackagesOf(envRoot: string): string[] {
	const found: string[] = [];
	for (const libs of ["lib", "lib64", "Lib"]) {
		const path = join(envRoot, libs);
		if (!isDirectory(path)) continue;
		if (isDirectory(join(path, "site-packages"))) {
			found.push(join(path, "site-packages"));
			continue;
		}
		for (const entry of readdir(path)) {
			const sitePackages = join(path, entry, "site-packages");
			if (isDirectory(sitePackages)) found.push(sitePackages);
		}
	}
	return found;
}

/** An interpreter lives in `<env>/bin` or `<env>/Scripts`, and the environment is the directory above. */
function environmentOf(pythonPath: string): PythonEnvironment | undefined {
	const bin = basename(dirname(pythonPath));
	if (bin !== "bin" && bin !== "Scripts") return undefined;
	const envRoot = dirname(dirname(pythonPath));
	return {
		pythonPath,
		venvPath: dirname(envRoot),
		venvName: basename(envRoot),
		sitePackagesPaths: sitePackagesOf(envRoot),
	};
}

function environmentAt(dir: string): PythonEnvironment | undefined {
	const interpreter = interpreterOf(dir);
	return interpreter === undefined ? undefined : environmentOf(interpreter);
}

/** A project's own `pyrightconfig.json` is asked first, and it is JSONC: which is why this uses the
 * parser that reads comments instead of `JSON.parse`. */
function environmentFromConfig(root: string): PythonEnvironment | undefined {
	let config: unknown;
	try {
		config = parse(readFileSync(join(root, CONFIG_FILE), "utf8"));
	} catch {
		return undefined;
	}
	if (typeof config !== "object" || config === null) return undefined;
	const { pythonPath, venvPath, venv } = config as {
		pythonPath?: unknown;
		venvPath?: unknown;
		venv?: unknown;
	};
	if (typeof pythonPath === "string") {
		const interpreter = resolve(root, pythonPath);
		if (isFile(interpreter)) return environmentOf(interpreter) ?? noEnvironment(interpreter);
	}
	if (typeof venv === "string") {
		const envRoot = resolve(root, typeof venvPath === "string" ? join(venvPath, venv) : venv);
		const environment = environmentAt(envRoot);
		if (environment !== undefined) return environment;
	}
	return undefined;
}

/** The home the user's own account names, not the one a launcher started this process with: the same order
 * the Central adapter reads it in. */
function userHome(): string {
	const named = process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME;
	return named === undefined || named === "" ? homedir() : named;
}

/** Environments a tool made under the user's home for this project's name: `virtualenv`, `conda create -n`. */
function namedEnvironments(projectName: string): string[] {
	const found: string[] = [];
	for (const relativeRoot of NAMED_ENVIRONMENT_ROOTS) {
		const root = join(userHome(), relativeRoot);
		for (const entry of readdir(root)) {
			if (
				entry === projectName ||
				entry.startsWith(`${projectName}-`) ||
				entry.startsWith(`${projectName}_`)
			) {
				found.push(join(root, entry));
			}
		}
	}
	return found;
}

/** Every place this workspace's own environment could be, in the order it is most likely to be meant. */
function environmentSearch(root: string): string[] {
	const search: string[] = [];
	// A `.venv` one level above a checkout is still that checkout's environment.
	for (const dir of [root, dirname(root)]) {
		for (const name of ENVIRONMENT_NAMES) search.push(join(dir, name));
	}
	const activated = [process.env.VIRTUAL_ENV, process.env.CONDA_PREFIX];
	for (const dir of activated) {
		if (dir !== undefined && dir !== "") search.push(dir);
	}
	search.push(...namedEnvironments(basename(root)));
	return search;
}

/**
 * The Python environment a workspace's libraries are installed into, so a language server resolves `cv2`
 * from that environment instead of from the interpreter this process happens to run under. Nothing here
 * runs the interpreter: every answer is a directory the host can see.
 */
export function resolvePythonEnvironment(workspaceRoot: string): PythonEnvironment {
	const root = resolve(workspaceRoot);
	const configured = environmentFromConfig(root);
	const environment =
		configured ??
		environmentSearch(root)
			.map(environmentAt)
			.find((candidate): candidate is PythonEnvironment => candidate !== undefined) ??
		noEnvironment(Bun.which("python3") ?? Bun.which("python") ?? "python3");
	log.info(
		`resolved python environment: pythonPath=${environment.pythonPath} sitePackages=${
			environment.sitePackagesPaths.join(", ") || "none"
		}`,
	);
	return environment;
}
