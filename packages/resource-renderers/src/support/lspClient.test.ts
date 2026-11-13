import { afterEach, expect, test } from "bun:test";
import {
	documentRootUri,
	ensureModelsForLocations,
	type LspDiagnostic,
	type LspDocument,
	type LspModelStore,
	type LspRange,
	type LspWorkspaceRoot,
	lspSocketUrl,
	openLspDocument,
	toTargets,
} from "./lspClient";

const originalWindow = globalThis.window;
const originalWebSocket = globalThis.WebSocket;

const URI = "file:///workspace/src/app.ts";
const ROOT: LspWorkspaceRoot = {
	path: "/home/user/gyro ev aided",
	uri: "file:///home/user/gyro%20ev%20aided",
};

function at(href: string): void {
	globalThis.window = { location: { href } } as unknown as Window & typeof globalThis;
}

interface Frame {
	jsonrpc: string;
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
}

let sockets: FakeSocket[] = [];

/** A socket that speaks both ways: everything this client writes is recorded, and `receive`/`answer` put
 * on the wire what a language server would. */
class FakeSocket {
	readonly url: string;
	readonly sent: Frame[] = [];
	readyState = 1;
	closed = 0;
	onopen: (() => void) | undefined;
	onerror: (() => void) | undefined;
	onclose: (() => void) | undefined;
	onmessage: ((event: { data: unknown }) => void) | undefined;
	private readonly answered = new Set<number>();
	constructor(url: string) {
		this.url = url;
		sockets.push(this);
	}
	send(content: string): void {
		this.sent.push(JSON.parse(content) as Frame);
	}
	close(): void {
		this.closed += 1;
		this.readyState = 3;
	}
	receive(frame: Frame): void {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
	/** Answer the newest still-unanswered request this client sent for `method`. */
	answer(method: string, result: unknown): void {
		const request = [...this.sent]
			.reverse()
			.find(
				(frame) =>
					frame.method === method && frame.id !== undefined && !this.answered.has(frame.id),
			);
		if (request?.id === undefined) throw new Error(`no unanswered ${method} request was sent`);
		this.answered.add(request.id);
		this.receive({ jsonrpc: "2.0", id: request.id, result });
	}
	answersTo(id: number): Frame[] {
		return this.sent.filter((frame) => frame.id === id);
	}
	paramsOf(method: string): unknown {
		const frame = [...this.sent].reverse().find((candidate) => candidate.method === method);
		return frame?.params;
	}
	countOf(method: string): number {
		return this.sent.filter((frame) => frame.method === method).length;
	}
	methods(): string[] {
		return this.sent.map((frame) => frame.method ?? `response#${frame.id}`);
	}
}

/** A handshake that never completed. */
class ConnectingSocket extends FakeSocket {
	override readyState = 0;
}

/** The members `lspClient` reads of a model, with the one behavior it depends on: `type()` is an edit. */
class FakeModel {
	readonly uri = { toString: () => URI };
	private text = "console.log(1);\n";
	private version = 1;
	private listeners: (() => void)[] = [];
	languageId = "typescript";
	disposed = false;
	getLanguageId(): string {
		return this.languageId;
	}
	getValue(): string {
		return this.text;
	}
	getVersionId(): number {
		return this.version;
	}
	isDisposed(): boolean {
		return this.disposed;
	}
	onDidChangeContent(listener: () => void): { dispose(): void } {
		this.listeners.push(listener);
		return {
			dispose: () => {
				this.listeners = this.listeners.filter((candidate) => candidate !== listener);
			},
		};
	}
	type(text: string): void {
		this.text = text;
		this.version += 1;
		for (const listener of this.listeners) listener();
	}
}

function opened(): FakeSocket {
	const socket = sockets[0];
	if (socket === undefined) throw new Error("no socket was opened");
	return socket;
}

async function sent(method: string, timeoutMs = 3000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (opened().methods().includes(method)) return;
		await Bun.sleep(10);
	}
	throw new Error(`${method} was never sent; saw ${opened().methods().join(", ")}`);
}

/** Open the document, which is what every case below then depends on. */
async function handshake(
	model: FakeModel,
	workspaceRoot: LspWorkspaceRoot | undefined = undefined,
): Promise<{ socket: FakeSocket; document: LspDocument }> {
	const document = openLspDocument({ model, onDiagnostics: () => undefined, workspaceRoot });
	const socket = opened();
	socket.onopen?.();
	await sent("initialize");
	socket.answer("initialize", { capabilities: { completionProvider: {} } });
	await sent("initialized");
	await sent("textDocument/didOpen");
	return { socket, document };
}

afterEach(() => {
	globalThis.window = originalWindow;
	globalThis.WebSocket = originalWebSocket;
	sockets = [];
});

test("the socket is the page's own host, with the language as its query", () => {
	at("http://127.0.0.1:24269/files/x");
	expect(lspSocketUrl("python", undefined, undefined)).toBe(
		"ws://127.0.0.1:24269/lsp?language=python",
	);
});

test("a secure page reaches a secure host", () => {
	at("https://example.test/");
	expect(lspSocketUrl("typescript", undefined, undefined)).toBe(
		"wss://example.test/lsp?language=typescript",
	);
});

test("a named host is used as given", () => {
	at("http://127.0.0.1:24269/");
	expect(lspSocketUrl("python", "ws://127.0.0.1:3001/lsp", undefined)).toBe(
		"ws://127.0.0.1:3001/lsp?language=python",
	);
});

test("the project directory the host names travels as this host's own query", () => {
	at("http://127.0.0.1:24269/");
	const url = new URL(lspSocketUrl("python", undefined, ROOT));
	expect(url.searchParams.get("root")).toBe("/home/user/gyro ev aided");
});

test("the root a server is told about is the document's own directory", () => {
	expect(documentRootUri(URI)).toBe("file:///workspace/src");
	expect(documentRootUri("file:///app.ts")).toBe("file://");
});

test("the handshake is initialize, then initialized, then didOpen with the document itself", async () => {
	at("http://127.0.0.1:24269/");
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	const model = new FakeModel();
	const { document } = await handshake(model);

	expect(opened().methods()).toEqual(["initialize", "initialized", "textDocument/didOpen"]);
	const initialize = opened().paramsOf("initialize") as { rootUri: string; capabilities: unknown };
	expect(initialize.rootUri).toBe("file:///workspace/src");
	expect(initialize.capabilities).toMatchObject({
		textDocument: { completion: { completionItem: { snippetSupport: true } } },
	});
	expect(opened().paramsOf("textDocument/didOpen")).toEqual({
		textDocument: { uri: URI, languageId: "typescript", version: 1, text: "console.log(1);\n" },
	});
	document.dispose();
});

test("a host that names its workspace root is the project the server analyzes", async () => {
	at("http://127.0.0.1:24269/");
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	const model = new FakeModel();
	const { socket, document } = await handshake(model, ROOT);

	expect(new URL(socket.url).searchParams.get("root")).toBe(ROOT.path);
	const initialize = opened().paramsOf("initialize") as Record<string, unknown>;
	expect(initialize.rootUri).toBe(ROOT.uri);
	expect(initialize.rootPath).toBe(ROOT.path);
	expect(initialize.workspaceFolders).toEqual([{ uri: ROOT.uri, name: "gyro ev aided" }]);
	expect(initialize.capabilities).toMatchObject({
		workspace: { configuration: true, workspaceFolders: true },
	});
	document.dispose();
});

test("every edit of the model is a full-text didChange with the model's own version", async () => {
	at("http://127.0.0.1:24269/");
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	const model = new FakeModel();
	const { document } = await handshake(model);

	model.type("console.log(2);\n");
	expect(opened().paramsOf("textDocument/didChange")).toEqual({
		textDocument: { uri: URI, version: 2 },
		contentChanges: [{ text: "console.log(2);\n" }],
	});
	document.dispose();
});

test("diagnostics for this document are handed back; another document's are not", async () => {
	at("http://127.0.0.1:24269/");
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	const received: LspDiagnostic[][] = [];
	openLspDocument({
		model: new FakeModel(),
		onDiagnostics: (diagnostics) => received.push(diagnostics),
	});
	const socket = opened();
	socket.onopen?.();
	await sent("initialize");
	socket.answer("initialize", { capabilities: {} });
	await sent("textDocument/didOpen");

	const diagnostic: LspDiagnostic = {
		range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
		message: "Expected 2 arguments, but got 1.",
		severity: 1,
		code: 2554,
		source: "ts",
	};
	socket.receive({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: { uri: URI, diagnostics: [diagnostic] },
	});
	socket.receive({
		jsonrpc: "2.0",
		method: "textDocument/publishDiagnostics",
		params: { uri: "file:///workspace/src/other.ts", diagnostics: [] },
	});
	expect(received).toEqual([[diagnostic]]);
});

test("a feature request waits for the handshake, and both completion answer shapes normalize", async () => {
	at("http://127.0.0.1:24269/");
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	const model = new FakeModel();
	const document = openLspDocument({ model, onDiagnostics: () => undefined });
	const socket = opened();
	socket.onopen?.();
	await sent("initialize");

	const early = document.complete({ line: 0, character: 7 });
	socket.answer("initialize", { capabilities: {} });
	await sent("textDocument/completion");
	expect(socket.paramsOf("textDocument/completion")).toEqual({
		textDocument: { uri: URI },
		position: { line: 0, character: 7 },
	});
	socket.answer("textDocument/completion", {
		isIncomplete: false,
		items: [{ label: "log", kind: 2, detail: "(method) Console.log(...)" }],
	});
	expect((await early)?.map((item) => item.label)).toEqual(["log"]);
	expect((await early)?.[0]?.kind).toBe(2);

	const bare = document.complete({ line: 0, character: 7 });
	await sent("textDocument/completion");
	socket.answer("textDocument/completion", [{ label: "dir" }]);
	expect((await bare)?.map((item) => item.label)).toEqual(["dir"]);

	const ask = document.hover({ line: 0, character: 7 });
	await sent("textDocument/hover");
	expect(socket.paramsOf("textDocument/hover")).toEqual({
		textDocument: { uri: URI },
		position: { line: 0, character: 7 },
	});
	socket.answer("textDocument/hover", {
		contents: {
			kind: "markdown",
			value: "```typescript\nconst log: (...data: any[]) => void\n```",
		},
	});
	expect((await ask)?.contents).toEqual({
		kind: "markdown",
		value: "```typescript\nconst log: (...data: any[]) => void\n```",
	});
	document.dispose();
});

/** Unanswered, and the feature reply never comes: this is a hung completion, not a slow one. */
test("the requests a server sends its client are answered", async () => {
	at("http://127.0.0.1:24269/");
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	const model = new FakeModel();
	const { socket, document } = await handshake(model);
	socket.receive({
		jsonrpc: "2.0",
		id: 91,
		method: "workspace/configuration",
		params: { items: [{ scopeUri: URI, section: "ts" }] },
	});
	expect(socket.answersTo(91).map((frame) => frame.result)).toEqual([[null]]);
	socket.receive({ jsonrpc: "2.0", id: 92, method: "window/workDoneProgress/create", params: {} });
	expect(socket.answersTo(92).map((frame) => frame.result)).toEqual([null]);
	document.dispose();
});

test("a disposed document stops syncing and answers nothing more, and its socket closes", async () => {
	at("http://127.0.0.1:24269/");
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	const model = new FakeModel();
	const document = openLspDocument({ model, onDiagnostics: () => undefined });
	const socket = opened();
	socket.onopen?.();
	await sent("initialize");
	socket.answer("initialize", { capabilities: {} });
	await sent("textDocument/didOpen");

	model.type("console.log(2);\n");
	expect(socket.countOf("textDocument/didChange")).toBe(1);

	document.dispose();
	expect(socket.closed).toBe(1);
	model.type("console.log(3);\n");
	expect(socket.countOf("textDocument/didChange")).toBe(1);
	expect(await document.complete({ line: 0, character: 1 })).toBeUndefined();
});

test("a disposed connection ends a socket that is still connecting", () => {
	at("http://127.0.0.1:24269/");
	globalThis.WebSocket = ConnectingSocket as unknown as typeof WebSocket;

	openLspDocument({ model: new FakeModel(), onDiagnostics: () => undefined }).dispose();
	openLspDocument({ model: new FakeModel(), onDiagnostics: () => undefined }).dispose();

	expect(sockets.map((socket) => socket.closed)).toEqual([1, 1]);
	expect(sockets.map((socket) => socket.url)).toEqual([
		"ws://127.0.0.1:24269/lsp?language=typescript",
		"ws://127.0.0.1:24269/lsp?language=typescript",
	]);
});

test("a refused upgrade answers nothing rather than hanging a feature request", async () => {
	at("http://127.0.0.1:24269/");
	globalThis.WebSocket = ConnectingSocket as unknown as typeof WebSocket;
	const document = openLspDocument({ model: new FakeModel(), onDiagnostics: () => undefined });
	sockets[0]?.onclose?.();
	expect(await document.complete({ line: 0, character: 1 })).toBeUndefined();
	expect(await document.hover({ line: 0, character: 1 })).toBeUndefined();
	document.dispose();
});

const TARGET_RANGE: LspRange = {
	start: { line: 10, character: 4 },
	end: { line: 10, character: 9 },
};

/** The `initialize` that asks for these features is what a server answers them under. */
test("the client asks for definition, type definition and references, with link support", async () => {
	at("http://127.0.0.1:24269/");
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	const { document } = await handshake(new FakeModel());
	expect(opened().paramsOf("initialize")).toMatchObject({
		capabilities: {
			textDocument: {
				definition: { dynamicRegistration: false, linkSupport: true },
				typeDefinition: { dynamicRegistration: false, linkSupport: true },
				references: { dynamicRegistration: false },
			},
		},
	});
	document.dispose();
});

test("a definition answer is normalized from every shape the protocol allows", () => {
	expect(toTargets(null)).toEqual([]);
	expect(toTargets(undefined)).toEqual([]);
	expect(toTargets([])).toEqual([]);
	expect(toTargets({ uri: "file:///workspace/src/other.ts", range: TARGET_RANGE })).toEqual([
		{ uri: "file:///workspace/src/other.ts", range: TARGET_RANGE, selectionRange: TARGET_RANGE },
	]);
	expect(
		toTargets([
			{ uri: "file:///workspace/src/a.ts", range: TARGET_RANGE },
			{ uri: "file:///workspace/src/b.ts", range: TARGET_RANGE },
		]).map((target) => target.uri),
	).toEqual(["file:///workspace/src/a.ts", "file:///workspace/src/b.ts"]);

	const link = toTargets([
		{
			targetUri: "file:///workspace/src/other.ts",
			targetRange: { start: { line: 10, character: 0 }, end: { line: 12, character: 1 } },
			targetSelectionRange: TARGET_RANGE,
			originSelectionRange: { start: { line: 1, character: 6 }, end: { line: 1, character: 10 } },
		},
	])[0];
	expect(link).toEqual({
		uri: "file:///workspace/src/other.ts",
		range: { start: { line: 10, character: 0 }, end: { line: 12, character: 1 } },
		selectionRange: TARGET_RANGE,
		originRange: { start: { line: 1, character: 6 }, end: { line: 1, character: 10 } },
	});
	// A link with no selection range selects the whole target it points at.
	expect(
		toTargets([{ targetUri: "file:///workspace/src/other.ts", targetRange: TARGET_RANGE }])[0]
			?.selectionRange,
	).toEqual(TARGET_RANGE);
});

test("definition, type definition and reference requests carry what their answers need", async () => {
	at("http://127.0.0.1:24269/");
	globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
	const { socket, document } = await handshake(new FakeModel());

	const definition = document.definition({ line: 3, character: 5 });
	await sent("textDocument/definition");
	expect(socket.paramsOf("textDocument/definition")).toEqual({
		textDocument: { uri: URI },
		position: { line: 3, character: 5 },
	});
	socket.answer("textDocument/definition", {
		targetUri: "file:///workspace/src/other.ts",
		targetRange: TARGET_RANGE,
		originSelectionRange: { start: { line: 3, character: 5 }, end: { line: 3, character: 9 } },
	});
	expect((await definition)[0]?.uri).toBe("file:///workspace/src/other.ts");
	expect((await definition)[0]?.originRange).toEqual({
		start: { line: 3, character: 5 },
		end: { line: 3, character: 9 },
	});

	const typeDefinition = document.typeDefinition({ line: 3, character: 5 });
	await sent("textDocument/typeDefinition");
	expect(socket.paramsOf("textDocument/typeDefinition")).toEqual({
		textDocument: { uri: URI },
		position: { line: 3, character: 5 },
	});
	socket.answer("textDocument/typeDefinition", null);
	expect(await typeDefinition).toEqual([]);

	const references = document.references({ line: 3, character: 5 }, false);
	await sent("textDocument/references");
	expect(socket.paramsOf("textDocument/references")).toEqual({
		textDocument: { uri: URI },
		position: { line: 3, character: 5 },
		context: { includeDeclaration: false },
	});
	socket.answer("textDocument/references", [
		{ uri: "file:///workspace/src/a.ts", range: TARGET_RANGE },
		{ uri: "file:///workspace/src/app.ts", range: TARGET_RANGE },
	]);
	expect((await references).map((target) => target.uri)).toEqual([
		"file:///workspace/src/a.ts",
		URI,
	]);
	document.dispose();
});

test("every file a target names is read once, already modelled ones are left alone, and an unreadable one drops out", async () => {
	const modelled = new Set([URI]);
	const read: string[] = [];
	const models: LspModelStore = {
		has: (uri) => modelled.has(uri),
		read: async (uri) => {
			read.push(uri);
			return uri === "file:///unreadable.bin" ? null : `text of ${uri}`;
		},
		add: (uri, text) => {
			expect(text).toBe(`text of ${uri}`);
			modelled.add(uri);
		},
	};
	const target = (uri: string) => ({ uri, range: TARGET_RANGE, selectionRange: TARGET_RANGE });

	await ensureModelsForLocations(
		[
			target(URI),
			target(URI),
			target("untitled:Untitled-1"),
			target("file:///unreadable.bin"),
			target("file:///workspace/src/other.ts"),
		],
		models,
	);

	expect(read.sort()).toEqual(["file:///unreadable.bin", "file:///workspace/src/other.ts"]);
	expect(modelled.has("file:///workspace/src/other.ts")).toBe(true);
	expect(modelled.has("file:///unreadable.bin")).toBe(false);
});
