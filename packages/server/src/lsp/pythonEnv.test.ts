import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePythonEnvironment } from ".";

const SITE_PACKAGES = join("lib", "python3.11", "site-packages");

const roots: string[] = [];
const saved = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	VIRTUAL_ENV: process.env.VIRTUAL_ENV,
	CONDA_PREFIX: process.env.CONDA_PREFIX,
};

beforeEach(() => {
	// An environment activated on the machine running this suite is not the workspace's own.
	delete process.env.VIRTUAL_ENV;
	delete process.env.CONDA_PREFIX;
});

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	for (const [name, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "thinkrail-python-env-"));
	roots.push(root);
	return root;
}

/** A workspace root with an empty parent of its own, so nothing outside it can be mistaken for its environment. */
function privateRoot(): string {
	const parent = makeRoot();
	const root = join(parent, "project");
	mkdirSync(root);
	return root;
}

function writeAt(root: string, path: string, content = ""): void {
	const target = join(root, path);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, content);
}

/** A POSIX virtualenv or conda environment: an interpreter, and one installed package. */
function writeEnvironment(root: string, name: string): string {
	writeAt(root, join(name, "bin", "python"), "#!/bin/sh\n");
	writeAt(root, join(name, SITE_PACKAGES, "fake_venv_pkg", "__init__.py"), "VALUE = 1\n");
	return name;
}

function homeAs(): string {
	const home = makeRoot();
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	return home;
}

test("a project's own .venv is the environment its imports resolve from, before a venv beside it", () => {
	const root = makeRoot();
	writeEnvironment(root, ".venv");
	writeEnvironment(root, "venv");
	writeAt(root, join("src", "app.py"), "import fake_venv_pkg\n");

	const environment = resolvePythonEnvironment(root);

	expect(environment.pythonPath).toBe(join(root, ".venv", "bin", "python"));
	expect(environment.venvPath).toBe(root);
	expect(environment.venvName).toBe(".venv");
	expect(environment.sitePackagesPaths).toEqual([join(root, ".venv", SITE_PACKAGES)]);
});

test("an environment one directory above a checkout is that checkout's environment", () => {
	const parent = makeRoot();
	writeEnvironment(parent, ".venv");
	const root = join(parent, "checkout");
	mkdirSync(root);

	const environment = resolvePythonEnvironment(root);

	expect(environment.pythonPath).toBe(join(parent, ".venv", "bin", "python"));
	expect(environment.venvName).toBe(".venv");
});

test("pyrightconfig.json is the project's own answer, and it is read as JSONC", () => {
	const root = makeRoot();
	writeEnvironment(root, ".venv");
	writeEnvironment(root, "toolenv");
	writeAt(
		root,
		"pyrightconfig.json",
		`{\n\t// the environment this project actually uses\n\t"venvPath": ".",\n\t"venv": "toolenv"\n}\n`,
	);

	const environment = resolvePythonEnvironment(root);

	expect(environment.pythonPath).toBe(join(root, "toolenv", "bin", "python"));
	expect(environment.venvName).toBe("toolenv");
});

test("a pyrightconfig.json that names an interpreter is asked about that interpreter", () => {
	const root = makeRoot();
	writeEnvironment(root, ".venv");
	writeAt(root, join("pyrightconfig.json"), JSON.stringify({ pythonPath: ".venv/bin/python" }));

	const environment = resolvePythonEnvironment(root);

	expect(environment.pythonPath).toBe(join(root, ".venv", "bin", "python"));
	expect(environment.venvName).toBe(".venv");
});

test("an environment this process was started inside is used when the workspace holds none", () => {
	const activated = makeRoot();
	writeEnvironment(activated, "condaenv");
	const root = privateRoot();
	writeAt(root, join("src", "app.py"), "import fake_venv_pkg\n");
	const interpreter = join(activated, "condaenv", "bin", "python");

	process.env.VIRTUAL_ENV = join(activated, "condaenv");
	expect(resolvePythonEnvironment(root).pythonPath).toBe(interpreter);

	delete process.env.VIRTUAL_ENV;
	process.env.CONDA_PREFIX = join(activated, "condaenv");
	expect(resolvePythonEnvironment(root).pythonPath).toBe(interpreter);
});

test("an environment a tool made under the user's home for this project's name is found", () => {
	const home = homeAs();
	const project = "gyro-ev-aided-deblur";
	writeEnvironment(home, join(".virtualenvs", project));
	writeEnvironment(home, join("miniconda3", "envs", `${project}-copy`));
	const root = join(home, "Coding", "tests", project);
	mkdirSync(root, { recursive: true });

	// `~/.virtualenvs` is searched first, and a name prefix is the same environment.
	expect(resolvePythonEnvironment(root).pythonPath).toBe(
		join(home, ".virtualenvs", project, "bin", "python"),
	);
});

test("an environment with the Windows spelling is read the same way", () => {
	const root = makeRoot();
	const name = ".venv";
	writeAt(root, join(name, "Scripts", "python.exe"));
	writeAt(root, join(name, "Lib", "site-packages", "fake_venv_pkg", "__init__.py"));

	const environment = resolvePythonEnvironment(root);

	expect(environment.pythonPath).toBe(join(root, name, "Scripts", "python.exe"));
	expect(environment.sitePackagesPaths).toEqual([join(root, name, "Lib", "site-packages")]);
});

test("an environment whose only interpreter is version-named is still found", () => {
	const root = makeRoot();
	const name = ".venv";
	writeAt(root, join(name, "bin", "python3.12"));
	writeAt(root, join(name, "lib", "python3.12", "site-packages", "fake_venv_pkg", "__init__.py"));

	const environment = resolvePythonEnvironment(root);

	expect(environment.pythonPath).toBe(join(root, name, "bin", "python3.12"));
	expect(environment.sitePackagesPaths).toEqual([
		join(root, name, "lib", "python3.12", "site-packages"),
	]);
});

test("with no environment anywhere, the answer is the interpreter this host's PATH names", () => {
	homeAs();
	const root = privateRoot();
	writeAt(root, "app.py", "import sys\n");

	const environment = resolvePythonEnvironment(root);

	expect(environment.pythonPath).toBe(Bun.which("python3") ?? Bun.which("python") ?? "python3");
	expect(environment.venvPath).toBeUndefined();
	expect(environment.venvName).toBeUndefined();
	expect(environment.sitePackagesPaths).toEqual([]);
});
