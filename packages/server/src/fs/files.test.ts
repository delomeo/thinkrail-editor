import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { readDir, readFile, resolveWorktreeFile, workspaceRelativePath } from "./files";

let dataDir: string;
let root: string;
const savedDataDir = process.env.THINKRAIL_DATA_DIR;

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "trpi-fs-test-"));
	process.env.THINKRAIL_DATA_DIR = dataDir;
	root = join(dataDir, "worktree");
	mkdirSync(join(root, "src", "auth"), { recursive: true });
	writeFileSync(join(root, "src", "auth", "login.ts"), "export {};\n");
	writeFileSync(
		join(dataDir, "workspaces.json"),
		JSON.stringify([{ id: "w1", projectId: "p1", name: "w1", worktreePath: root, createdAt: 1 }]),
	);
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
	if (savedDataDir === undefined) delete process.env.THINKRAIL_DATA_DIR;
	else process.env.THINKRAIL_DATA_DIR = savedDataDir;
});

test("readDir reports worktree-relative paths with forward slashes on every platform", () => {
	expect(readDir("w1", ".").map((node) => node.path)).toEqual(["src"]);
	expect(readDir("w1", "src").map((node) => node.path)).toEqual(["src/auth"]);
	expect(readDir("w1", "src/auth").map((node) => node.path)).toEqual(["src/auth/login.ts"]);
});

test("workspaceRelativePath names a contained path worktree-relative with / separators", () => {
	expect(workspaceRelativePath(root, join(root, "src", "auth", "login.ts"))).toBe(
		"src/auth/login.ts",
	);
	expect(workspaceRelativePath(root, join("src", "auth", "login.ts"))).toBe("src/auth/login.ts");
	expect(workspaceRelativePath(root, "./src/../src/auth")).toBe("src/auth");
	expect(workspaceRelativePath(`${root}${sep}.`, "src")).toBe("src");
	expect(workspaceRelativePath(root, "..env")).toBe("..env");
	expect(workspaceRelativePath(root, ".")).toBe("");
});

test("workspaceRelativePath rejects a path outside the worktree", () => {
	expect(workspaceRelativePath(root, "../worktree-sibling/a.ts")).toBeNull();
	expect(workspaceRelativePath(root, join(dataDir, "elsewhere"))).toBeNull();
});

test("a library file a language server resolved outside the worktree is readable by absolute path", () => {
	const stubs = join(
		dataDir,
		"host-install",
		"node_modules",
		"pyright",
		"typeshed-fallback",
		"stdlib",
	);
	mkdirSync(stubs, { recursive: true });
	writeFileSync(join(stubs, "os.pyi"), "def getcwd() -> str: ...\n");
	const venv = join(dataDir, "venv", "lib", "site-packages", "requests", "api.py");
	mkdirSync(join(dataDir, "venv", "lib", "site-packages", "requests"), { recursive: true });
	writeFileSync(venv, "def get(url: str): ...\n");

	expect(readFile("w1", join(stubs, "os.pyi")).content).toContain("def getcwd");
	expect(readFile("w1", venv).meta.text).toBe(true);
	expect(resolveWorktreeFile("w1", join(stubs, "os.pyi"))).toBe(join(stubs, "os.pyi"));
});

test("a named conda or virtualenv environment a resolver found is readable, and so is the standard library of the interpreter it was pointed at", () => {
	const conda = join(
		dataDir,
		"miniconda3",
		"envs",
		"gyro",
		"lib",
		"python3.12",
		"site-packages",
		"cv2",
	);
	const ownStdlib = join(dataDir, ".venvs", "gyro", "lib", "python3.12", "copy.py");
	const distPackages = join(dataDir, "usr", "lib", "python3", "dist-packages", "numpy");
	mkdirSync(conda, { recursive: true });
	mkdirSync(dirname(ownStdlib), { recursive: true });
	mkdirSync(distPackages, { recursive: true });
	writeFileSync(join(conda, "__init__.pyi"), "def imshow(name: str) -> None: ...\n");
	writeFileSync(ownStdlib, "def deepcopy(x: object): ...\n");
	writeFileSync(join(distPackages, "__init__.py"), 'version = "2"\n');

	expect(readFile("w1", join(conda, "__init__.pyi")).content).toContain("imshow");
	expect(readFile("w1", ownStdlib).meta.text).toBe(true);
	expect(readFile("w1", join(distPackages, "__init__.py")).meta.text).toBe(true);
});

test("an absolute path outside the worktree that is not library code is refused", () => {
	writeFileSync(join(dataDir, "elsewhere.txt"), "not a dependency\n");
	expect(() => readFile("w1", join(dataDir, "elsewhere.txt"))).toThrow("Path escapes the worktree");
	expect(() => readFile("w1", "../elsewhere.txt")).toThrow("Path escapes the worktree");
	expect(() => readFile("w1", join(dataDir, ".git", "node_modules", "x.ts"))).toThrow(
		"Path escapes the worktree",
	);
	expect(() =>
		readFile("w1", join(dataDir, "miniconda3", "envs", "gyro", "pkgs", "numpy.py")),
	).toThrow("Path escapes the worktree");
	expect(() => readFile("w1", join(dataDir, "notes", "lib", "python3", "prose.py"))).toThrow(
		"Path escapes the worktree",
	);
});
