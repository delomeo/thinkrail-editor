/* ------------------------------------------------------------------ wire shapes
 * The LSP forms this client sends and reads, named as the protocol names them. Declaring them here is
 * what keeps a protocol package — types for a Node server — out of the browser bundle.
 */

export interface LspPosition {
	line: number;
	character: number;
}

export interface LspRange {
	start: LspPosition;
	end: LspPosition;
}

export interface LspMarkup {
	kind?: string;
	value: string;
}

export type LspMarkedString = string | { language: string; value: string };

export interface LspDiagnostic {
	range: LspRange;
	message: string;
	severity?: number;
	code?: string | number;
	source?: string;
}

export interface LspTextEdit {
	range: LspRange | { insert: LspRange; replace: LspRange };
	newText: string;
}

export interface LspCompletionItem {
	label: string | { label: string; detail?: string };
	kind?: number;
	detail?: string;
	documentation?: string | LspMarkup;
	insertText?: string;
	insertTextFormat?: number;
	textEdit?: LspTextEdit;
	sortText?: string;
	filterText?: string;
	commitCharacters?: string[];
	tags?: number[];
	deprecated?: boolean;
}

export interface LspCompletionList {
	isIncomplete?: boolean;
	items: LspCompletionItem[];
}

export interface LspHover {
	contents?: string | LspMarkedString[] | LspMarkup;
	range?: LspRange;
}

export interface LspLocation {
	uri: string;
	range: LspRange;
}

export interface LspLocationLink {
	targetUri: string;
	targetRange: LspRange;
	targetSelectionRange?: LspRange;
	originSelectionRange?: LspRange;
}

/** What a definition, type-definition or reference request answers with: the protocol allows one location,
 * an array of either shape, or nothing. */
export type LspLocations = LspLocation | LspLocation[] | LspLocationLink[] | null | undefined;

/** A target in the one shape both the model hydrator and the Monaco providers need. */
export interface LspTarget {
	uri: string;
	/** The whole target: what a preview or outline row shows. */
	range: LspRange;
	/** The identifier inside it: what a jump selects, and what lets a click on a definition itself read as
	 * "find references" rather than "go to the same place". */
	selectionRange: LspRange;
	originRange?: LspRange;
}

/** The members of `editor.ITextModel` this client reads: spelled structurally, so the protocol half is
 * testable without a DOM and a real model satisfies it as it is. */
export interface LspTextModel {
	readonly uri: { toString(): string };
	getLanguageId(): string;
	getValue(): string;
	getVersionId(): number;
	isDisposed(): boolean;
	onDidChangeContent(listener: () => void): { dispose(): void };
}

/** One document's side of the socket: ask for completions and hover, and end the whole thing. */
export interface LspDocument {
	complete(position: LspPosition): Promise<LspCompletionItem[] | undefined>;
	hover(position: LspPosition): Promise<LspHover | undefined>;
	definition(position: LspPosition): Promise<LspTarget[]>;
	typeDefinition(position: LspPosition): Promise<LspTarget[]>;
	references(position: LspPosition, includeDeclaration: boolean): Promise<LspTarget[]>;
	dispose(): void;
}

/** The workspace a language server analyzes, in both spellings its side of the wire needs: the path on the
 * machine that runs the server, and the `file://` URI the protocol names it with. */
export interface LspWorkspaceRoot {
	readonly path: string;
	readonly uri: string;
}

/** The host's own `/lsp` route on the origin that served this page, with the language id and the project
 * directory the upgrade reads as its queries. `wsUrl` names a host reached elsewhere. */
export function lspSocketUrl(
	languageId: string,
	wsUrl: string | undefined,
	root: LspWorkspaceRoot | undefined,
): string {
	const url = new URL(wsUrl ?? "/lsp", window.location.href);
	if (url.protocol === "http:") url.protocol = "ws:";
	else if (url.protocol === "https:") url.protocol = "wss:";
	url.searchParams.set("language", languageId);
	if (root !== undefined) url.searchParams.set("root", root.path);
	return url.toString();
}

/** A language server resolves imports, types and stubs from a workspace directory, and the only one this
 * client knows without a host that names one is the document's own parent. */
export function documentRootUri(uri: string): string {
	const last = uri.lastIndexOf("/");
	return last <= 0 ? uri : uri.slice(0, last);
}

const workspaceName = (path: string): string =>
	path
		.replace(/[/\\]+$/, "")
		.split(/[/\\]/)
		.pop() ?? "";

const CLIENT_CAPABILITIES = {
	workspace: {
		configuration: true,
		workspaceFolders: true,
		didChangeConfiguration: { dynamicRegistration: false },
	},
	textDocument: {
		synchronization: { dynamicRegistration: false },
		publishDiagnostics: { dynamicRegistration: false },
		completion: {
			dynamicRegistration: false,
			completionItem: {
				commitCharactersSupport: true,
				documentationFormat: ["markdown", "plaintext"],
				snippetSupport: true,
			},
		},
		hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
		definition: { dynamicRegistration: false, linkSupport: true },
		typeDefinition: { dynamicRegistration: false, linkSupport: true },
		references: { dynamicRegistration: false },
	},
};

interface IncomingFrame {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string };
}

/** JSON-RPC over a WebSocket: one frame is one message, so there is no `Content-Length` framing to do —
 * only ids to match, requests to answer, and pending calls to release when the socket ends. */
interface JsonRpc {
	request<T>(method: string, params: unknown): Promise<T | undefined>;
	notify(method: string, params: unknown): void;
	onRequest<P>(method: string, handler: (params: P) => unknown): void;
	onNotification<P>(method: string, handler: (params: P) => void): void;
	/** Feed one wire frame in: a request is answered, a notification is dispatched, a response releases the
	 * call that asked for it, and a frame that is none of those is ignored rather than fatal. */
	receive(raw: string): void;
	/** Let go of every call still waiting, so a torn-down editor never awaits an answer that is gone. */
	release(): void;
}

function createJsonRpc(write: (frame: string) => void): JsonRpc {
	const pending = new Map<number, (frame: IncomingFrame) => void>();
	const requestHandlers = new Map<string, (params: unknown) => unknown>();
	const notificationHandlers = new Map<string, (params: unknown) => void>();
	let nextId = 0;

	const send = (frame: Record<string, unknown>): void => {
		write(JSON.stringify(frame));
	};

	return {
		request: <T>(method: string, params: unknown): Promise<T | undefined> =>
			new Promise((resolve) => {
				nextId += 1;
				const id = nextId;
				pending.set(id, (frame) =>
					resolve(
						// A server answers "nothing here" with a null result: that is no answer, not a payload.
						frame.error !== undefined || frame.result === null
							? undefined
							: (frame.result as T | undefined),
					),
				);
				send({ jsonrpc: "2.0", id, method, params });
			}),
		notify: (method, params) => {
			send({ jsonrpc: "2.0", method, params });
		},
		onRequest: <P>(method: string, handler: (params: P) => unknown): void => {
			requestHandlers.set(method, handler as (params: unknown) => unknown);
		},
		onNotification: <P>(method: string, handler: (params: P) => void): void => {
			notificationHandlers.set(method, handler as (params: unknown) => void);
		},
		receive: (raw) => {
			let frame: IncomingFrame;
			try {
				frame = JSON.parse(raw) as IncomingFrame;
			} catch {
				return;
			}
			if (frame.id !== undefined && frame.method !== undefined) {
				const handler = requestHandlers.get(frame.method);
				// An unanswered request is a feature reply that never arrives, so even a method this client
				// has no handler for is answered rather than left waiting on the server's side.
				send({
					jsonrpc: "2.0",
					id: frame.id,
					result: handler === undefined ? null : handler(frame.params),
				});
				return;
			}
			if (frame.method !== undefined) {
				notificationHandlers.get(frame.method)?.(frame.params);
				return;
			}
			if (typeof frame.id !== "number") return;
			const resolve = pending.get(frame.id);
			if (resolve === undefined) return;
			pending.delete(frame.id);
			resolve(frame);
		},
		release: () => {
			for (const resolve of pending.values()) resolve({});
			pending.clear();
		},
	};
}

// `WebSocket`'s state statics are absent in some runtimes (Bun's are undefined), and a teardown that
// compares against `undefined` closes nothing.
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

function warn(languageId: string, reason: unknown): void {
	console.warn(`[resource-renderers] language server failed for ${languageId}`, reason);
}

function completionItems(
	result: LspCompletionList | LspCompletionItem[] | undefined | null,
): LspCompletionItem[] {
	if (result === undefined || result === null) return [];
	return Array.isArray(result) ? result : (result.items ?? []);
}

/** The protocol allows one location, an array of either shape, or nothing; the half that shows them wants
 * one shape for all of it. A `Location` selects what it names, so its own range is the selection range. */
export function toTargets(result: LspLocations): LspTarget[] {
	if (result === null || result === undefined) return [];
	const items: (LspLocation | LspLocationLink)[] = Array.isArray(result) ? result : [result];
	return items.map((item) =>
		"targetUri" in item
			? {
					uri: item.targetUri,
					range: item.targetRange,
					selectionRange: item.targetSelectionRange ?? item.targetRange,
					...(item.originSelectionRange === undefined
						? {}
						: { originRange: item.originSelectionRange }),
				}
			: { uri: item.uri, range: item.range, selectionRange: item.range },
	);
}

/** The model side `ensureModelsForLocations` needs: what is already modelled, how to read a target, and how
 * to add one. `monacoSetup` supplies all three; nothing here imports Monaco. */
export interface LspModelStore {
	has(uri: string): boolean;
	read(uri: string): Promise<string | null>;
	add(uri: string, text: string): void;
}

/** Monaco shows a target only when a text model exists for it — a cross-file hover preview, a Peek row and a
 * jump to another file all read the target's model. Ask for each target once, skip the ones already
 * modelled, and let one unreadable target drop out rather than failing the whole answer. */
export async function ensureModelsForLocations(
	targets: readonly LspTarget[],
	models: LspModelStore,
): Promise<void> {
	const missing = new Set(
		targets.map((target) => target.uri).filter((uri) => uri.startsWith("file://")),
	);
	await Promise.all(
		[...missing].map(async (uri) => {
			if (models.has(uri)) return;
			const text = await models.read(uri);
			if (text !== null) models.add(uri, text);
		}),
	);
}

/**
 * Speak LSP directly to Monaco's own language providers: frame JSON-RPC on the host's `/lsp` socket,
 * open the document on it, and keep it in sync with full-text `didChange`. The answers are handed back
 * for the caller to register — `monacoSetup` owns that half, and nothing here imports Monaco.
 *
 * The socket is one-shot: no reconnect, and closing it is where the host ends its language-server child.
 */
export function openLspDocument(options: {
	model: LspTextModel;
	onDiagnostics: (diagnostics: LspDiagnostic[]) => void;
	wsUrl?: string;
	/** The project this document belongs to. A server that is told only the document's own directory never
	 * sees the environment installed beside the project, so a library import reads as missing. */
	workspaceRoot?: LspWorkspaceRoot | undefined;
}): LspDocument {
	const { model, onDiagnostics, wsUrl, workspaceRoot } = options;
	const languageId = model.getLanguageId();
	const uri = model.uri.toString();
	const url = lspSocketUrl(languageId, wsUrl, workspaceRoot);
	console.log(`[LSP] Attempting WebSocket connection to: ${url}`);
	const webSocket = new WebSocket(url);

	const rpc = createJsonRpc((frame) => {
		if (webSocket.readyState === SOCKET_OPEN) webSocket.send(frame);
	});
	/** A server's own requests must be answered or its feature replies never arrive: an unanswered
	 * `workspace/configuration` is a completion request that hangs forever. Ones this client has no
	 * handler for are answered with `null` so the server's queue drains. */
	rpc.onRequest("workspace/configuration", (params: { items?: unknown[] }) =>
		(params.items ?? []).map(() => null),
	);
	rpc.onRequest("workspace/workspaceFolders", () => null);
	rpc.onRequest("client/registerCapability", () => null);
	rpc.onRequest("window/workDoneProgress/create", () => null);
	rpc.onNotification(
		"textDocument/publishDiagnostics",
		(params: { uri?: string; diagnostics?: LspDiagnostic[] }) => {
			if (params.uri === uri) onDiagnostics(params.diagnostics ?? []);
		},
	);

	let changeListener: { dispose(): void } | undefined;
	let disposed = false;
	let settled = false;
	let settle: (ready: boolean) => void = () => undefined;
	// A feature request that arrives mid-handshake waits for it rather than answering nothing.
	const ready = new Promise<boolean>((resolve) => {
		settle = resolve;
	});
	const finish = (isReady: boolean): void => {
		if (settled) return;
		settled = true;
		settle(isReady);
	};

	const start = async (): Promise<void> => {
		await rpc.request("initialize", {
			processId: null,
			clientInfo: { name: "thinkrail" },
			rootUri: workspaceRoot?.uri ?? documentRootUri(uri),
			...(workspaceRoot === undefined
				? {}
				: {
						rootPath: workspaceRoot.path,
						workspaceFolders: [{ uri: workspaceRoot.uri, name: workspaceName(workspaceRoot.path) }],
					}),
			capabilities: CLIENT_CAPABILITIES,
		});
		if (disposed) return;
		rpc.notify("initialized", {});
		rpc.notify("textDocument/didOpen", {
			textDocument: { uri, languageId, version: model.getVersionId(), text: model.getValue() },
		});
		changeListener = model.onDidChangeContent(() => {
			if (disposed || model.isDisposed()) return;
			rpc.notify("textDocument/didChange", {
				textDocument: { uri, version: model.getVersionId() },
				contentChanges: [{ text: model.getValue() }],
			});
		});
		finish(true);
	};

	webSocket.onopen = () => {
		void start().catch((error: unknown) => {
			warn(languageId, error);
			finish(false);
		});
	};
	webSocket.onmessage = (event) => rpc.receive(String(event.data));
	// A refused upgrade or a server that died is the end of this document.
	webSocket.onclose = () => finish(false);
	webSocket.onerror = () => finish(false);

	const ask = async <T>(
		method: string,
		params: Record<string, unknown>,
	): Promise<T | undefined> => {
		if (!(await ready) || disposed) return undefined;
		return rpc.request<T>(method, { textDocument: { uri }, ...params });
	};

	const targets = async (method: string, params: Record<string, unknown>): Promise<LspTarget[]> =>
		toTargets(await ask<LspLocations>(method, params));

	return {
		complete: async (position) => {
			const result = await ask<LspCompletionList | LspCompletionItem[]>("textDocument/completion", {
				position,
			});
			return result === undefined ? undefined : completionItems(result);
		},
		hover: (position) => ask<LspHover>("textDocument/hover", { position }),
		definition: (position) => targets("textDocument/definition", { position }),
		typeDefinition: (position) => targets("textDocument/typeDefinition", { position }),
		references: (position, includeDeclaration) =>
			targets("textDocument/references", {
				position,
				context: { includeDeclaration },
			}),
		dispose: () => {
			disposed = true;
			finish(false);
			changeListener?.dispose();
			rpc.release();
			// A socket still connecting is a child the host is about to spawn for nothing: closing it here
			// is what keeps a fast file switch from leaving language servers behind.
			if (webSocket.readyState === SOCKET_OPEN || webSocket.readyState === SOCKET_CONNECTING) {
				webSocket.close();
			}
		},
	};
}
