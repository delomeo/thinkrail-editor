import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSyncCaptured } from "@thinkrail/shared/spawn";
import { resolveServerCommand } from "../lsp";
import { type BootedHost, bootHost } from "./boot";

const booted: BootedHost[] = [];
const tmpDirs: string[] = [];

beforeEach(() => {
	const dir = mkdtempSync(join(tmpdir(), "thinkrail-lsp-route-"));
	tmpDirs.push(dir);
	process.env.THINKRAIL_DATA_DIR = dir;
});

afterEach(async () => {
	while (booted.length) await booted.pop()?.server.shutdown();
	while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

async function openLspSocket(port: number, language: string, root?: string): Promise<WebSocket> {
	const url = new URL(`ws://127.0.0.1:${port}/lsp`);
	url.searchParams.set("language", language);
	if (root !== undefined) url.searchParams.set("root", root);
	const socket = new WebSocket(url.toString());
	await new Promise<void>((resolve, reject) => {
		socket.addEventListener("open", () => resolve(), { once: true });
		socket.addEventListener("error", () => reject(new Error("/lsp refused the upgrade")), {
			once: true,
		});
	});
	return socket;
}

test("a language with no installed server is refused before the socket upgrades", async () => {
	const host = await bootHost({ port: 0, host: "127.0.0.1", portMode: "exact" });
	booted.push(host);
	const response = await fetch(`http://127.0.0.1:${host.port}/lsp?language=cobol`);
	expect(response.status).toBe(400);
});

interface LspFrame {
	readonly id?: number;
	readonly method?: string;
	readonly params?: {
		readonly uri?: string;
		readonly items?: unknown[];
		readonly diagnostics?: readonly {
			readonly severity?: number;
			readonly code?: string;
		}[];
	};
	readonly result?: unknown;
}

interface LspClient {
	readonly socket: WebSocket;
	readonly frames: LspFrame[];
	send(frame: unknown): void;
	until(match: (frame: LspFrame) => boolean, timeoutMs: number): Promise<LspFrame>;
}

/** A language client that speaks for itself: it answers the requests its server sends it. */
function speaking(socket: WebSocket): LspClient {
	const frames: LspFrame[] = [];
	socket.addEventListener("message", (event) => {
		const frame = JSON.parse(String(event.data)) as LspFrame;
		frames.push(frame);
		if (frame.id === undefined || frame.method === undefined) return;
		// `workspace/configuration` and `client/registerCapability` are requests, not notifications: a
		// client that ignores them leaves completion and hover waiting for an answer that never comes.
		const result =
			frame.method === "workspace/configuration"
				? (frame.params?.items ?? []).map(() => null)
				: null;
		socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
	});
	return {
		socket,
		frames,
		send: (frame) => socket.send(JSON.stringify(frame)),
		async until(match, timeoutMs) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				const found = frames.find(match);
				if (found !== undefined) return found;
				await Bun.sleep(50);
			}
			throw new Error(
				`no matching frame within ${timeoutMs}ms; saw ${frames.map((frame) => frame.method ?? `response#${frame.id}`).join(", ")}`,
			);
		},
	};
}

interface ProbeDoc {
	name: string;
	text: string;
}

interface Handshake {
	language: string;
	/** One document asked about twice: an incomplete member access for completion, a call for hover. */
	member: ProbeDoc & {
		line: number;
		character: number;
		label: string;
		hoverLine: number;
		hoverCharacter: number;
		hoverMentions: string;
	};
	broken: ProbeDoc;
	/** The same fixture asked about three more times: a call for its definition, a declaration for its
	 * references, and a member of the standard library this fixture does not contain. */
	jump: ProbeDoc & {
		callLine: number;
		callCharacter: number;
		declLine: number;
		declCharacter: number;
		libraryLine: number;
		libraryCharacter: number;
		/** The extension only a library source carries: a typeshed stub or a declaration file. */
		librarySuffix: string;
	};
}

const HANDSHAKES: Handshake[] = [
	{
		language: "python",
		member: {
			name: "member.py",
			text: "import os\nprint(os.getcwd())\nos.path.\n",
			line: 2,
			character: 8,
			label: "join",
			hoverLine: 1,
			hoverCharacter: 11,
			hoverMentions: "def getcwd() -> str",
		},
		broken: { name: "broken.py", text: 'value: int = "text"\n' },
		jump: {
			name: "jump.py",
			text: "import os\n\n\ndef target(value: int) -> int:\n    return os.getcwd() + value\n\n\nresult = target(1)\nprint(result)\n",
			callLine: 7,
			callCharacter: 10,
			declLine: 3,
			declCharacter: 5,
			libraryLine: 4,
			libraryCharacter: 16,
			librarySuffix: ".pyi",
		},
	},
	{
		language: "typescript",
		member: {
			name: "member.ts",
			text: 'const greet = (name: string) => name.toUpperCase();\ngreet("a");\nconsole.\n',
			line: 2,
			character: 8,
			label: "log",
			hoverLine: 1,
			hoverCharacter: 1,
			hoverMentions: "(name: string) => string",
		},
		broken: { name: "broken.ts", text: 'const value: number = "text";\n' },
		jump: {
			name: "jump.ts",
			text: 'console.log("start");\nfunction target(value: number): number {\n\treturn value;\n}\nexport const result = target(1);\n',
			callLine: 4,
			callCharacter: 23,
			declLine: 1,
			declCharacter: 12,
			libraryLine: 0,
			libraryCharacter: 9,
			librarySuffix: ".d.ts",
		},
	},
];

function resultOf(frame: LspFrame): Record<string, unknown> {
	return frame.result as Record<string, unknown>;
}

/** A response to one of this client's own requests: a server's own requests carry ids too, and answering
 * one is not answering ours. */
const responseTo = (id: number) => (frame: LspFrame) =>
	frame.id === id && frame.method === undefined;

/** Ask one thing of the server and wait for its answer. */
async function ask(
	client: LspClient,
	id: number,
	method: string,
	params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	client.send({ jsonrpc: "2.0", id, method, params });
	return resultOf(await client.until(responseTo(id), 30_000));
}

/** `Location`, `Location[]` and `LocationLink[]` all name a place; the assertions here only need to know
 * which file and which line. */
function locations(result: Record<string, unknown>): { uri: string; line: number }[] {
	const answer = Array.isArray(result) ? result : [result];
	return answer
		.filter((entry) => entry !== null)
		.map((entry) => {
			const link = entry as Record<string, unknown>;
			const uri = (link.targetUri ?? link.uri) as string;
			const range = (link.targetRange ?? link.range) as { start: { line: number } };
			return { uri, line: range.start.line };
		});
}

const positionOf = (line: number, character: number) => ({ line, character });
const at = (uri: string, line: number, character: number) => ({
	textDocument: { uri },
	position: positionOf(line, character),
});

/** Every language-server process the host spawned from this repository's installed server tree. */
function serverProcesses(command: string): number[] {
	const run = spawnSyncCaptured(["ps", "-eo", "pid=,args="]);
	return run.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.includes(command))
		.map((line) => Number.parseInt(line.split(/\s+/)[0] as string, 10))
		.filter(Number.isInteger);
}

const posix = test.skipIf(process.platform === "win32");

for (const handshake of HANDSHAKES) {
	posix(
		`/lsp carries a ${handshake.language} session from initialize to completion, hover, definition, references and diagnostics`,
		async () => {
			const server = resolveServerCommand(handshake.language);
			if (server === undefined) throw new Error(`no language server for ${handshake.language}`);
			const root = tmpDirs[0];
			if (root === undefined) throw new Error("missing fixture data directory");
			for (const document of [handshake.member, handshake.broken, handshake.jump]) {
				writeFileSync(join(root, document.name), document.text);
			}
			const before = serverProcesses(server.command);
			const host = await bootHost({ port: 0, host: "127.0.0.1", portMode: "exact" });
			booted.push(host);
			const client = speaking(await openLspSocket(host.port, handshake.language));
			const uriOf = (document: ProbeDoc) => `file://${join(root, document.name)}`;

			client.send({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					processId: null,
					clientInfo: { name: "thinkrail-lsp-route-test" },
					rootUri: `file://${root}`,
					capabilities: {
						workspace: { workspaceFolders: true, configuration: true },
						textDocument: {
							synchronization: { dynamicRegistration: true },
							publishDiagnostics: { relatedInformation: true },
							completion: { dynamicRegistration: true, completionItem: { snippetSupport: true } },
							hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
							definition: { dynamicRegistration: true, linkSupport: true },
							typeDefinition: { dynamicRegistration: true, linkSupport: true },
							references: { dynamicRegistration: true },
						},
					},
				},
			});
			const capabilities = resultOf(await client.until(responseTo(1), 30_000))
				.capabilities as Record<string, unknown>;
			expect(capabilities.completionProvider).toBeTruthy();
			expect(capabilities.hoverProvider).toBeTruthy();
			expect(capabilities.definitionProvider).toBeTruthy();
			expect(capabilities.referencesProvider).toBeTruthy();

			client.send({ jsonrpc: "2.0", method: "initialized", params: {} });
			for (const document of [handshake.member, handshake.broken, handshake.jump]) {
				client.send({
					jsonrpc: "2.0",
					method: "textDocument/didOpen",
					params: {
						textDocument: {
							uri: uriOf(document),
							languageId: handshake.language,
							version: 1,
							text: document.text,
						},
					},
				});
			}

			const diagnostics = await client.until(
				(frame) =>
					frame.method === "textDocument/publishDiagnostics" &&
					frame.params?.uri?.endsWith(handshake.broken.name) === true &&
					(frame.params.diagnostics ?? []).some((entry) => entry.severity === 1),
				30_000,
			);
			// The handshake answers before the server pushes documents about them.
			const answered = client.frames.findIndex(responseTo(1));
			const firstDiagnostic = client.frames.findIndex(
				(frame) => frame.method === "textDocument/publishDiagnostics",
			);
			expect(firstDiagnostic).toBeGreaterThan(answered);
			expect(diagnostics.params?.diagnostics?.some((entry) => entry.severity === 1)).toBe(true);

			client.send({
				jsonrpc: "2.0",
				id: 2,
				method: "textDocument/completion",
				params: {
					textDocument: { uri: uriOf(handshake.member) },
					position: { line: handshake.member.line, character: handshake.member.character },
					context: { triggerKind: 2, triggerCharacter: "." },
				},
			});
			const completion = resultOf(await client.until(responseTo(2), 30_000));
			const items = (completion.items ?? completion) as { label?: string }[];
			expect(Array.isArray(items)).toBe(true);
			expect(items.map((item) => item.label)).toContain(handshake.member.label);

			client.send({
				jsonrpc: "2.0",
				id: 3,
				method: "textDocument/hover",
				params: {
					textDocument: { uri: uriOf(handshake.member) },
					position: {
						line: handshake.member.hoverLine,
						character: handshake.member.hoverCharacter,
					},
				},
			});
			const contents = resultOf(await client.until(responseTo(3), 30_000)).contents as {
				value?: string;
			};
			expect(contents.value ?? "").toContain(handshake.member.hoverMentions);

			const jumpUri = uriOf(handshake.jump);
			const definition = locations(
				await ask(
					client,
					4,
					"textDocument/definition",
					at(jumpUri, handshake.jump.callLine, handshake.jump.callCharacter),
				),
			);
			expect(
				definition.some(
					(target) => target.uri === jumpUri && target.line === handshake.jump.declLine,
				),
			).toBe(true);

			const references = locations(
				await ask(client, 5, "textDocument/references", {
					...at(jumpUri, handshake.jump.declLine, handshake.jump.declCharacter),
					context: { includeDeclaration: true },
				}),
			);
			expect(references.filter((target) => target.uri === jumpUri).length).toBeGreaterThanOrEqual(
				2,
			);

			const library = locations(
				await ask(
					client,
					6,
					"textDocument/definition",
					at(jumpUri, handshake.jump.libraryLine, handshake.jump.libraryCharacter),
				),
			);
			// A standard library name resolves to a source outside this fixture — the file a user wants to
			// read, and the one only the host's own read can give them.
			expect(library.length).toBeGreaterThan(0);
			expect(library[0]?.uri.endsWith(handshake.jump.librarySuffix)).toBe(true);
			expect(library[0]?.uri.startsWith(`file://${root}`)).toBe(false);

			// One child per connection: the session the socket opened is the child the ps lists.
			expect(serverProcesses(server.command).length).toBe(before.length + 1);

			client.socket.close();
			const goneDeadline = Date.now() + 15_000;
			while (Date.now() < goneDeadline && serverProcesses(server.command).length > before.length) {
				await Bun.sleep(100);
			}
			expect(serverProcesses(server.command)).toEqual(before);
		},
		60_000,
	);
}

const PYTHON = Bun.which("python3") ?? Bun.which("python") ?? undefined;
const PROBE = "import fake_venv_pkg\n\nVALUE = fake_venv_pkg.VALUE\n";

/** A `.venv` a real interpreter can actually run, with one package installed into it. */
function writeProjectVenv(root: string): string {
	if (PYTHON === undefined) throw new Error("no python interpreter on PATH");
	const version = spawnSyncCaptured([
		PYTHON,
		"-c",
		"import sys; print('{}.{}'.format(*sys.version_info[:2]))",
	]).stdout.trim();
	const sitePackages = join(root, ".venv", "lib", version, "site-packages");
	mkdirSync(join(sitePackages, "fake_venv_pkg"), { recursive: true });
	mkdirSync(join(root, ".venv", "bin"), { recursive: true });
	symlinkSync(PYTHON, join(root, ".venv", "bin", "python"));
	writeFileSync(join(root, ".venv", "pyvenv.cfg"), `home = ${dirname(PYTHON)}\n`);
	writeFileSync(join(sitePackages, "fake_venv_pkg", "__init__.py"), "VALUE: int = 1\n");
	writeFileSync(join(root, "probe.py"), PROBE);
	return join(sitePackages, "fake_venv_pkg", "__init__.py");
}

/** A python session on a socket that names the workspace it belongs to, with these documents open. */
async function openPythonSession(
	client: LspClient,
	root: string,
	documents: Record<string, string>,
): Promise<void> {
	client.send({
		jsonrpc: "2.0",
		id: 1,
		method: "initialize",
		params: {
			processId: null,
			clientInfo: { name: "thinkrail-lsp-route-test" },
			rootUri: `file://${root}`,
			rootPath: root,
			workspaceFolders: [{ uri: `file://${root}`, name: basename(root) }],
			capabilities: {
				workspace: { workspaceFolders: true, configuration: true },
				textDocument: {
					publishDiagnostics: {},
					definition: { linkSupport: true },
					completion: {},
				},
			},
		},
	});
	await client.until(responseTo(1), 30_000);
	client.send({ jsonrpc: "2.0", method: "initialized", params: {} });
	for (const [name, text] of Object.entries(documents)) {
		client.send({
			jsonrpc: "2.0",
			method: "textDocument/didOpen",
			params: {
				textDocument: {
					uri: `file://${join(root, name)}`,
					languageId: "python",
					version: 1,
					text,
				},
			},
		});
	}
}

const diagnosticsFor = (client: LspClient, name: string) =>
	client.frames.filter(
		(frame) =>
			frame.method === "textDocument/publishDiagnostics" &&
			frame.params?.uri?.endsWith(name) === true,
	);

/** The host answered its client's configuration requests itself: a request left holding an answer is a
 * feature reply that never arrives. */
const askedTheClient = (client: LspClient) =>
	client.frames.some((frame) => frame.method === "workspace/configuration");

const withVenv = test.skipIf(process.platform === "win32" || PYTHON === undefined);

withVenv(
	"/lsp resolves an installed package out of the .venv of the workspace its socket names",
	async () => {
		const root = tmpDirs[0];
		if (root === undefined) throw new Error("missing fixture data directory");
		const installed = writeProjectVenv(root);
		const host = await bootHost({ port: 0, host: "127.0.0.1", portMode: "exact" });
		booted.push(host);
		const client = speaking(await openLspSocket(host.port, "python", root));
		await openPythonSession(client, root, { "probe.py": PROBE });

		const definition = locations(
			await ask(client, 2, "textDocument/definition", at(`file://${join(root, "probe.py")}`, 0, 7)),
		);
		expect(definition.some((target) => target.uri === `file://${installed}`)).toBe(true);
		expect(diagnosticsFor(client, "probe.py").length).toBeGreaterThan(0);
		expect(
			diagnosticsFor(client, "probe.py").flatMap((frame) => frame.params?.diagnostics ?? []),
		).toEqual([]);
		expect(askedTheClient(client)).toBe(false);

		client.socket.close();
	},
	60_000,
);

posix(
	"/lsp keeps resolving the standard library for a workspace that has no environment of its own",
	async () => {
		const root = tmpDirs[0];
		if (root === undefined) throw new Error("missing fixture data directory");
		const stdlib = "import os\n\nprint(os.getcwd())\n";
		writeFileSync(join(root, "stdlib.py"), stdlib);
		const host = await bootHost({ port: 0, host: "127.0.0.1", portMode: "exact" });
		booted.push(host);
		const client = speaking(await openLspSocket(host.port, "python", root));
		await openPythonSession(client, root, { "stdlib.py": stdlib });

		const library = locations(
			await ask(
				client,
				2,
				"textDocument/definition",
				at(`file://${join(root, "stdlib.py")}`, 2, 9),
			),
		);
		expect(
			library.some(
				(target) => target.uri.endsWith(".pyi") && !target.uri.startsWith(`file://${root}`),
			),
		).toBe(true);
		expect(
			diagnosticsFor(client, "stdlib.py").flatMap((frame) => frame.params?.diagnostics ?? []),
		).toEqual([]);
		expect(askedTheClient(client)).toBe(false);

		client.socket.close();
	},
	60_000,
);
