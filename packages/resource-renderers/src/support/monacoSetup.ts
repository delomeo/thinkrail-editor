/// <reference path="../bundler.d.ts" />
import type { Translator } from "@thinkrail/locales/react";
import type { ThemeRegistration } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import "monaco-editor/features/codicon/register.js";
import "monaco-editor/features/bracketMatching/register.js";
import "monaco-editor/features/clipboard/register.js";
import "monaco-editor/features/contextmenu/register.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/features/folding/register.js";
import "monaco-editor/features/hover/register.js";
import "monaco-editor/features/links/register.js";
import "monaco-editor/features/readOnlyMessage/register.js";
import "monaco-editor/features/stickyScroll/register.js";
import "monaco-editor/features/suggest/register.js";
// `features/suggest/register.js` is the inline-completions half of suggestions; the widget itself, the
// `editor.action.triggerSuggest` chord, and the model that reacts to a trigger character live here.
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/features/unicodeHighlighter/register.js";
import "monaco-editor/features/wordHighlighter/register.js";
// Word navigation is its own contribution: without it `cursorWordEndRight` and its three siblings are
// commands nothing registered, and the editor only ever moves one character at a time.
import "monaco-editor/features/wordOperations/register.js";
import "monaco-editor/features/quickCommand/register.js";
import "monaco-editor/features/gotoLine/register.js";
import "monaco-editor/features/gotoSymbol/register.js";
// `features/gotoSymbol/register.js` is only the Ctrl/Cmd+Click definition link. The goto commands, the
// multi-result Peek widget, and the command `gotoLocation.alternativeDefinitionCommand` names all live
// behind the deep paths the editor core itself uses.
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js";
import "monaco-editor/features/referenceSearch/register.js";
import { onThemeSwap } from "@thinkrail/ui/theme";
import type {
	Environment,
	editor,
	IDisposable,
	IMarkdownString,
	IPosition,
	IRange,
	languages,
	Uri,
} from "monaco-editor/editor/editor.api.js";
import * as monaco from "monaco-editor/editor/editor.api.js";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import onigWasmUrl from "shiki/onig.wasm?url";
import type { ResourceCodeHost, ResourceHost, ResourcePreferences } from "../host";
import { resolveEditorSettings } from "./editorSettings";
import { editorWrappingOptions } from "./editorWrapping";
import { indentRainbowApplies } from "./indentRainbow";
import {
	ensureModelsForLocations,
	type LspCompletionItem,
	type LspDiagnostic,
	type LspHover,
	type LspMarkup,
	type LspModelStore,
	type LspPosition,
	type LspRange,
	type LspTarget,
	type LspWorkspaceRoot,
	openLspDocument,
} from "./lspClient";
import { createShikiTokens, monacoThemeData } from "./shikiTokens";

declare global {
	interface Window {
		MonacoEnvironment?: Environment;
	}
}

window.MonacoEnvironment = {
	getWorker() {
		return new editorWorker();
	},
};

const EDITOR_THEME = "thinkrail-editor";

export const SAVE_FILE_KEYBINDING = monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS;

/**
 * The word-jump chords, asked for one chord per direction and selection state. Monaco's own rules bind the
 * platform-correct chord (`CtrlCmd` on Windows/Linux, `Alt` on macOS) and leave `CtrlCmd|Arrow` on macOS to
 * `cursorEnd`/`cursorHome`; these rules claim it for word navigation on every platform, which is what makes
 * the same chord mean the same thing here. They are page-global because they run Monaco's own commands, so
 * unlike the save chord they need no label, no context-menu entry, and no per-mount registration.
 */
const WORD_NAVIGATION_KEYBINDINGS: editor.IKeybindingRule[] = [
	{
		keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.RightArrow,
		command: "cursorWordEndRight",
		when: "textInputFocus",
	},
	{
		keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.RightArrow,
		command: "cursorWordEndRightSelect",
		when: "textInputFocus",
	},
	{
		keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyCode.LeftArrow,
		command: "cursorWordStartLeft",
		when: "textInputFocus",
	},
	{
		keybinding: monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.LeftArrow,
		command: "cursorWordStartLeftSelect",
		when: "textInputFocus",
	},
];

const BRACKETS: [string, string][] = [
	["(", ")"],
	["[", "]"],
	["{", "}"],
];

/**
 * Monaco auto-closes only the pairs a language configuration names, and a language registered here names
 * none. `notIn` is left out on purpose, which is what closes a pair inside a comment as well as in code, and
 * surrounding a selection falls back to these same pairs. A later `setLanguageConfiguration` composes per
 * field, so this adds pairs without rewriting a language's own brackets, colourization or folding.
 */
const AUTO_CLOSING_CONFIG: languages.LanguageConfiguration = {
	autoClosingPairs: [
		{ open: "(", close: ")" },
		{ open: "[", close: "]" },
		{ open: "{", close: "}" },
		{ open: '"', close: '"' },
		{ open: "'", close: "'" },
	],
};

function registerShikiLanguages(code: ResourceCodeHost): void {
	const registered = new Set(monaco.languages.getLanguages().map((language) => language.id));
	for (const language of code.languages) {
		if (!registered.has(language.id)) {
			monaco.languages.register({
				id: language.id,
				extensions: [...language.extensions],
				aliases: [...language.aliases],
				...(language.filenames ? { filenames: [...language.filenames] } : {}),
			});
			registered.add(language.id);
		}
		monaco.languages.setLanguageConfiguration(language.id, {
			brackets: BRACKETS,
			colorizedBracketPairs: BRACKETS,
		});
	}
	// Every language this page can be handed, the built-in `plaintext` behind an unknown extension included.
	for (const { id } of monaco.languages.getLanguages()) {
		monaco.languages.setLanguageConfiguration(id, AUTO_CLOSING_CONFIG);
	}
}

const languageByPath = new Map<string, string>();

export function languageForPath(path: string): string {
	const cached = languageByPath.get(path);
	if (cached !== undefined) return cached;
	const uri = monaco.Uri.parse(`lang-probe://probe/${path}`);
	const existing = monaco.editor.getModel(uri);
	const model = existing ?? monaco.editor.createModel("", undefined, uri);
	const id = model.getLanguageId();
	if (!existing) model.dispose();
	languageByPath.set(path, id);
	return id;
}

function cssVar(name: string): string | undefined {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;
}

/**
 * Every metric here is read from the live document, so the preferences arrive as one object: this call is
 * memoized on its arguments, and an unchanged one would hand the editor the metrics of an older scale.
 */
export function fileEditorOptions(
	t: Translator,
	preferences: ResourcePreferences,
	path: string,
	editable: boolean,
) {
	const { fileLineWidth: lineWidth, fileLineWidthBounded: bounded } = preferences;
	const indentRainbow = resolveEditorSettings(preferences.editor).indentRainbow;
	const fontSize = Number.parseFloat(cssVar("--tr-font-size-s14") ?? "") || 14;
	const lineHeight = Number.parseFloat(cssVar("--tr-line-height-default") ?? "") || undefined;
	const paddingTop = Number.parseFloat(cssVar("--space-8") ?? "");
	const options: editor.IStandaloneEditorConstructionOptions = {
		readOnly: !editable,
		ariaLabel: path,
		unicodeHighlight: { ambiguousCharacters: false },
		// Typed marks close themselves and leave the caret between the pair; `'always'` is what steps over a
		// closing mark instead of writing a second one, and `autoIndent` is the indentation `Enter` inherits.
		autoClosingBrackets: "always",
		autoClosingQuotes: "always",
		autoClosingOvertype: "always",
		autoSurround: "languageDefined",
		autoIndent: "full",
		lineNumbersMinChars: 3,
		renderLineHighlight: "all",
		smoothScrolling: true,
		guides: {
			bracketPairs: "active",
			// The colourized guides own the indentation lines; Monaco's monochrome set comes back only for a
			// language the settings exclude or a user who switched the colorizer off.
			indentation: !indentRainbowApplies(indentRainbow, languageForPath(path)),
		},
		occurrencesHighlight: "singleFile",
		...editorWrappingOptions(lineWidth, bounded),
		minimap: { enabled: false },
		scrollBeyondLastLine: false,
		automaticLayout: true,
		fontSize,
		fontFamily: cssVar("--tr-font-family-code") ?? "monospace",
		...(lineHeight && lineHeight > 0 ? { lineHeight } : {}),
		scrollbar: {
			vertical: "auto",
			horizontal: "auto",
			verticalScrollbarSize: 6,
			horizontalScrollbarSize: 6,
			useShadows: false,
		},
		overviewRulerLanes: 0,
		overviewRulerBorder: false,
		hideCursorInOverviewRuler: true,
	};
	options.padding = { top: Number.isFinite(paddingTop) ? paddingTop : 0 };
	if (!editable) options.readOnlyMessage = { value: t("panels.monacoSetup.readOnly") };
	return options;
}

/* ------------------------------------------------------------------ cross-file targets
 * A definition, type-definition or reference answer names a place in another file. Nothing shows it until a
 * text model for that file exists, and no tab exists for it until the host is asked for one. */

/**
 * A target file's identity, in the form both of the models it can end up behind carry: a workspace file's
 * own `file://` model, and the scoped model a read-only view of a file outside the worktree gets — whose
 * path is the same location with the leading separator dropped, which is how `canonicalWorkspacePath` and
 * `projectRelativePath` spell an out-of-worktree file.
 */
function targetKey(path: string): string {
	return path.replaceAll("\\", "/").replace(/^\/+/, "");
}

/** Ask the host to open this target as a file tab. Registered by the mount whose model is a real file, and
 * looked up by that model's key: an editor with no host behind it navigates nowhere. */
const targetOpeners = new Map<string, (target: Uri) => void>();
const pendingReveals = new Map<string, IRange | IPosition>();
let openerInstalled = false;

function editorForTarget(key: string): editor.ICodeEditor | undefined {
	for (const candidate of monaco.editor.getEditors()) {
		const model = candidate.getModel();
		if (model !== null && targetKey(model.uri.path) === key) return candidate;
	}
	return undefined;
}

function revealInEditor(codeEditor: editor.ICodeEditor, target: IRange | IPosition): void {
	if ("startLineNumber" in target) {
		codeEditor.setPosition({ lineNumber: target.startLineNumber, column: target.startColumn });
		codeEditor.revealRangeInCenterIfOutsideViewport(target, monaco.editor.ScrollType.Smooth);
	} else {
		codeEditor.setPosition(target);
		codeEditor.revealPositionInCenterIfOutsideViewport(target, monaco.editor.ScrollType.Smooth);
	}
	codeEditor.focus();
}

/**
 * What Monaco does when a definition link, a goto command, or a row of the Peek pop-up belongs to a model
 * other than the one it is showing. Registered once for the page: Monaco calls the handler that was
 * registered last, and the editor that asked is handed to it, so one handler serves every mount.
 */
function installEditorOpener(): void {
	if (openerInstalled) return;
	openerInstalled = true;
	monaco.editor.registerEditorOpener({
		openCodeEditor: (source, resource, selectionOrPosition) => {
			const model = source.getModel();
			if (model === null || resource.scheme !== "file") return false;
			if (resource.toString() === model.uri.toString()) {
				if (selectionOrPosition !== undefined) revealInEditor(source, selectionOrPosition);
				return true;
			}
			const key = targetKey(resource.path);
			const open = targetOpeners.get(targetKey(model.uri.path));
			// A target nothing read is a target no tab can show: the provider was told about it, but its text
			// is not here.
			if (open === undefined || monaco.editor.getModel(resource) === null) return false;
			const opened = editorForTarget(key);
			if (opened !== undefined) {
				revealInEditor(opened, selectionOrPosition ?? { lineNumber: 1, column: 1 });
				return true;
			}
			pendingReveals.set(key, selectionOrPosition ?? { lineNumber: 1, column: 1 });
			open(resource);
			return true;
		},
	});
}

/** Reveal the target a navigation asked for, when this mount is the tab that arrived with it. */
export function revealPendingTarget(codeEditor: editor.IStandaloneCodeEditor, path: string): void {
	const model = codeEditor.getModel();
	if (model === null) return;
	for (const key of new Set([targetKey(model.uri.path), targetKey(path)])) {
		const target = pendingReveals.get(key);
		if (target === undefined) continue;
		pendingReveals.delete(key);
		revealInEditor(codeEditor, target);
		return;
	}
}

interface FileModelInput {
	scope: string;
	path: string;
	text: string;
	/**
	 * The file's absolute path, carried only by the mount that owns this file's language services: a
	 * language server resolves workspaces, imports and types from a `file://` document URI, so only that
	 * URI makes the model a document the server can answer about.
	 */
	filePath: string | undefined;
}

function fileModelUri(input: FileModelInput, owned: editor.ITextModel | undefined) {
	const scoped = monaco.Uri.parse(`${input.scope}/${input.path}`);
	if (input.filePath === undefined) return scoped;
	const file = monaco.Uri.file(input.filePath);
	const holder = monaco.editor.getModel(file);
	// shortcut: one mount per file claims its `file://` model. A model another live editor holds is left
	// alone rather than colliding with it, which Monaco's model service refuses; one that this client only
	// hydrated for a navigation is claimed, so the tab that opens shows the file language services know.
	if (holder === null || holder === owned) return file;
	return editorForTarget(targetKey(file.path)) === undefined ? file : scoped;
}

function createFileModel(
	input: FileModelInput,
	owned: editor.ITextModel | undefined,
): editor.ITextModel {
	const uri = fileModelUri(input, owned);
	const existing = monaco.editor.getModel(uri);
	if (existing !== null) {
		if (existing !== owned && existing.getValue() !== input.text) existing.setValue(input.text);
		return existing;
	}
	return monaco.editor.createModel(input.text, languageForPath(input.path), uri);
}

export function createFileEditor(
	container: HTMLElement,
	{ options, ...model }: FileModelInput & { options: editor.IStandaloneEditorConstructionOptions },
) {
	return monaco.editor.create(container, {
		...options,
		model: createFileModel(model, undefined),
		theme: EDITOR_THEME,
	});
}

export function syncFileModel(
	codeEditor: editor.IStandaloneCodeEditor,
	input: FileModelInput,
	appliedText: string,
): void {
	const current = codeEditor.getModel();
	if (!current || current.uri.toString() !== fileModelUri(input, current).toString()) {
		const next = createFileModel(input, current ?? undefined);
		codeEditor.setModel(next);
		if (next !== current) current?.dispose();
		return;
	}
	if (input.text !== appliedText) current.setValue(input.text);
}

export function revealLineNow(codeEditor: editor.IStandaloneCodeEditor, line: number): void {
	codeEditor.revealLineInCenter(line, monaco.editor.ScrollType.Immediate);
}

export function disposeFileEditor(codeEditor: editor.IStandaloneCodeEditor): void {
	const model = codeEditor.getModel();
	codeEditor.dispose();
	model?.dispose();
}

/* ------------------------------------------------------------------ language services
 * `lspClient` owns the socket and the JSON-RPC. This half owns the Monaco side: the registrations, and
 * the conversion in both directions between Monaco's 1-based positions and LSP's 0-based ones. */

const MARKER_OWNER = (languageId: string): string => `lsp-${languageId}`;

/** The characters that ask a server for completions. `.` is the member-access case every language has. */
const COMPLETION_TRIGGERS = [".", ":", "/", '"', "'"];

const LSP_SEVERITY: Record<number, editor.IMarkerData["severity"]> = {
	1: monaco.MarkerSeverity.Error,
	2: monaco.MarkerSeverity.Warning,
	3: monaco.MarkerSeverity.Info,
	4: monaco.MarkerSeverity.Hint,
};

/** LSP `CompletionItemKind` to Monaco's, by name: the two enums agree on the names and not on the numbers. */
const LSP_COMPLETION_KIND: Record<number, languages.CompletionItemKind> = {
	1: monaco.languages.CompletionItemKind.Text,
	2: monaco.languages.CompletionItemKind.Method,
	3: monaco.languages.CompletionItemKind.Function,
	4: monaco.languages.CompletionItemKind.Constructor,
	5: monaco.languages.CompletionItemKind.Field,
	6: monaco.languages.CompletionItemKind.Variable,
	7: monaco.languages.CompletionItemKind.Class,
	8: monaco.languages.CompletionItemKind.Interface,
	9: monaco.languages.CompletionItemKind.Module,
	10: monaco.languages.CompletionItemKind.Property,
	11: monaco.languages.CompletionItemKind.Unit,
	12: monaco.languages.CompletionItemKind.Value,
	13: monaco.languages.CompletionItemKind.Enum,
	14: monaco.languages.CompletionItemKind.Keyword,
	15: monaco.languages.CompletionItemKind.Snippet,
	16: monaco.languages.CompletionItemKind.Color,
	17: monaco.languages.CompletionItemKind.File,
	18: monaco.languages.CompletionItemKind.Reference,
	19: monaco.languages.CompletionItemKind.Folder,
	20: monaco.languages.CompletionItemKind.EnumMember,
	21: monaco.languages.CompletionItemKind.Constant,
	22: monaco.languages.CompletionItemKind.Struct,
	23: monaco.languages.CompletionItemKind.Event,
	24: monaco.languages.CompletionItemKind.Operator,
	25: monaco.languages.CompletionItemKind.TypeParameter,
};

function toRange(range: LspRange): IRange {
	return {
		startLineNumber: range.start.line + 1,
		startColumn: range.start.character + 1,
		endLineNumber: range.end.line + 1,
		endColumn: range.end.character + 1,
	};
}

function toLspPosition(position: IPosition): LspPosition {
	return { line: position.lineNumber - 1, character: position.column - 1 };
}

function toMarkerData(diagnostics: readonly LspDiagnostic[]): editor.IMarkerData[] {
	return diagnostics.map((diagnostic) => ({
		severity: LSP_SEVERITY[diagnostic.severity ?? 1] ?? monaco.MarkerSeverity.Error,
		message: diagnostic.message,
		...toRange(diagnostic.range),
		...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
		...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
	}));
}

function toMarkdown(value: string | LspMarkup): IMarkdownString {
	return typeof value === "string" ? { value } : { value: value.value };
}

/** LSP `MarkupContent`, a bare string, or a `MarkedString[]`: Monaco takes an array of markdown. */
function toHoverContents(contents: LspHover["contents"]): IMarkdownString[] {
	if (contents === undefined) return [];
	if (typeof contents === "string") return [{ value: contents }];
	if (!Array.isArray(contents)) return [{ value: contents.value }];
	return contents.map((entry) =>
		typeof entry === "string"
			? { value: entry }
			: { value: `\`\`\`${entry.language}\n${entry.value}\n\`\`\`` },
	);
}

/** A completion inserts over what the server named in its `textEdit`; with none, over the word under the
 * cursor, or at the cursor when there is no word. */
function insertRange(
	model: editor.ITextModel,
	item: LspCompletionItem,
	position: IPosition,
): IRange | languages.CompletionItemRanges {
	const edit = item.textEdit;
	if (edit === undefined) {
		const word = model.getWordAtPosition(position);
		return word === null
			? {
					startLineNumber: position.lineNumber,
					startColumn: position.column,
					endLineNumber: position.lineNumber,
					endColumn: position.column,
				}
			: {
					startLineNumber: position.lineNumber,
					startColumn: word.startColumn,
					endLineNumber: position.lineNumber,
					endColumn: word.endColumn,
				};
	}
	if ("insert" in edit.range) {
		return { insert: toRange(edit.range.insert), replace: toRange(edit.range.replace) };
	}
	return toRange(edit.range);
}

function toCompletionItems(
	items: readonly LspCompletionItem[],
	model: editor.ITextModel,
	position: IPosition,
): languages.CompletionItem[] {
	return items.map((item) => {
		const label = typeof item.label === "string" ? item.label : item.label.label;
		return {
			label: item.label,
			kind: LSP_COMPLETION_KIND[item.kind ?? 1] ?? monaco.languages.CompletionItemKind.Text,
			insertText: item.textEdit?.newText ?? item.insertText ?? label,
			range: insertRange(model, item, position),
			...(item.detail === undefined ? {} : { detail: item.detail }),
			...(item.documentation === undefined
				? {}
				: { documentation: toMarkdown(item.documentation) }),
			...(item.insertTextFormat === 2
				? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet }
				: {}),
			...(item.sortText === undefined ? {} : { sortText: item.sortText }),
			...(item.filterText === undefined ? {} : { filterText: item.filterText }),
			...(item.commitCharacters === undefined ? {} : { commitCharacters: item.commitCharacters }),
			...(item.deprecated === true
				? { tags: [monaco.languages.CompletionItemTag.Deprecated] }
				: {}),
		};
	});
}

/**
 * A `file://` target as a path the machine that read it can open: the URI's own path, with only the Windows
 * drive spelling corrected, because a `file://` URI writes `c:\dir\file` as `/c:/dir/file`. `Uri#fsPath` is
 * the wrong tool here: it follows the platform the browser claims, not the one the host reads files on.
 */
function filePathOf(resource: { path: string }): string {
	return /^[A-Za-z]:\//.test(resource.path.slice(1)) ? resource.path.slice(1) : resource.path;
}

/** A target file's text model, made from the host's own read of the path the server named. A target that
 * cannot be read gets no model, and then no preview of it — a weaker answer than failing the whole request
 * that named it. */
function targetModelStore(host: ResourceHost, workspaceId: string): LspModelStore {
	const parse = (uri: string) => monaco.Uri.parse(uri);
	return {
		has: (uri) => monaco.editor.getModel(parse(uri)) !== null,
		read: async (uri) => {
			try {
				const { content, meta } = await host.readFile(workspaceId, filePathOf(parse(uri)));
				return meta?.text === false ? null : content;
			} catch {
				return null;
			}
		},
		add: (uri, text) => {
			const resource = parse(uri);
			if (monaco.editor.getModel(resource) === null) {
				monaco.editor.createModel(text, languageForPath(resource.path), resource);
			}
		},
	};
}

/** The whole target range for a preview, and the identifier inside it for the jump — that range is what lets
 * a click on a definition that is already the definition take its alternative command instead of landing
 * where the cursor already was. */
function toLocationLinks(targets: readonly LspTarget[]): languages.LocationLink[] {
	return targets.map((target) => ({
		uri: monaco.Uri.parse(target.uri),
		range: toRange(target.range),
		...(target.originRange === undefined
			? {}
			: { originSelectionRange: toRange(target.originRange) }),
		...(target.selectionRange === target.range
			? {}
			: { targetSelectionRange: toRange(target.selectionRange) }),
	}));
}

/** A provider's answer, with every target it names made readable first. */
async function asked(models: LspModelStore, ask: () => Promise<LspTarget[]>): Promise<LspTarget[]> {
	const targets = await ask();
	await ensureModelsForLocations(targets, models);
	return targets;
}

/** The project a document belongs to, in both spellings the protocol and the host need. `Uri.file` is the
 * same conversion that gives the model its `file://` URI, so the root a server is told and the document it
 * is asked about come from one place. */
function workspaceRootOf(host: ResourceHost, workspaceId: string): LspWorkspaceRoot | undefined {
	const path = host.workspacePath(workspaceId);
	return path === undefined ? undefined : { path, uri: monaco.Uri.file(path).toString() };
}

/**
 * One document's language services: open its `/lsp` document, publish its diagnostics as Monaco markers,
 * and answer completion, hover, definition, type definition and references from the server. The providers
 * are registered for the whole language, so each one answers only for the model this attachment owns —
 * every other model of the same language keeps its own behavior, and an unserved language's socket simply
 * never answers.
 */
export function attachLanguageServices(
	model: editor.ITextModel,
	host: ResourceHost,
	workspaceId: string,
): IDisposable {
	const languageId = model.getLanguageId();
	const uri = model.uri.toString();
	const owner = MARKER_OWNER(languageId);
	const models = targetModelStore(host, workspaceId);
	const document = openLspDocument({
		model,
		workspaceRoot: workspaceRootOf(host, workspaceId),
		onDiagnostics: (diagnostics) => {
			if (!model.isDisposed())
				monaco.editor.setModelMarkers(model, owner, toMarkerData(diagnostics));
		},
	});
	const completions = monaco.languages.registerCompletionItemProvider(languageId, {
		triggerCharacters: COMPLETION_TRIGGERS,
		provideCompletionItems: async (candidate, position) => {
			if (candidate.uri.toString() !== uri) return { suggestions: [] };
			const items = await document.complete(toLspPosition(position));
			return {
				suggestions: items === undefined ? [] : toCompletionItems(items, candidate, position),
			};
		},
	});
	const hover = monaco.languages.registerHoverProvider(languageId, {
		provideHover: async (candidate, position) => {
			if (candidate.uri.toString() !== uri) return undefined;
			const result = await document.hover(toLspPosition(position));
			if (result === undefined) return undefined;
			return {
				contents: toHoverContents(result.contents),
				...(result.range === undefined ? {} : { range: toRange(result.range) }),
			};
		},
	});
	const definition = monaco.languages.registerDefinitionProvider(languageId, {
		provideDefinition: async (candidate, position) => {
			if (candidate.uri.toString() !== uri) return null;
			return toLocationLinks(
				await asked(models, () => document.definition(toLspPosition(position))),
			);
		},
	});
	const typeDefinition = monaco.languages.registerTypeDefinitionProvider(languageId, {
		provideTypeDefinition: async (candidate, position) => {
			if (candidate.uri.toString() !== uri) return null;
			return toLocationLinks(
				await asked(models, () => document.typeDefinition(toLspPosition(position))),
			);
		},
	});
	const references = monaco.languages.registerReferenceProvider(languageId, {
		provideReferences: async (candidate, position, context) => {
			if (candidate.uri.toString() !== uri) return null;
			const targets = await asked(models, () =>
				document.references(toLspPosition(position), context.includeDeclaration),
			);
			return targets.map((target) => ({
				uri: monaco.Uri.parse(target.uri),
				range: toRange(target.selectionRange),
			}));
		},
	});
	// A jump out of this document is a tab the host has to open, so this is also where the editor opener
	// learns which host answers for which file.
	const openerKey = targetKey(model.uri.path);
	targetOpeners.set(openerKey, (target) =>
		host.openFile(workspaceId, filePathOf(target), { keep: true }),
	);
	installEditorOpener();
	return {
		dispose: () => {
			targetOpeners.delete(openerKey);
			completions.dispose();
			hover.dispose();
			definition.dispose();
			typeDefinition.dispose();
			references.dispose();
			document.dispose();
			if (!model.isDisposed()) monaco.editor.setModelMarkers(model, owner, []);
		},
	};
}

function themeData(registration: ThemeRegistration) {
	try {
		const { rules, colors } = monacoThemeData(registration);
		return { rules, colors };
	} catch {
		return { rules: [], colors: {} };
	}
}

function currentTheme(code: ResourceCodeHost) {
	const root = document.documentElement;
	const styles = getComputedStyle(root);
	const light = styles.colorScheme.split(/\s+/).includes("light");
	const base: editor.BuiltinTheme =
		root.dataset.themeContrast === "high"
			? light
				? "hc-light"
				: "hc-black"
			: light
				? "vs"
				: "vs-dark";
	const registration = code.theme({
		name: EDITOR_THEME,
		type: light ? "light" : "dark",
		readVariable: (name) => styles.getPropertyValue(name).trim(),
	});
	return { base, registration, data: themeData(registration) };
}

function defineTheme({ base, data }: ReturnType<typeof currentTheme>): void {
	monaco.editor.defineTheme(EDITOR_THEME, { base, inherit: true, ...data });
	monaco.editor.setTheme(EDITOR_THEME);
}

async function createEngine() {
	if (typeof WebAssembly !== "object") {
		const { createJavaScriptRegexEngine } = await import("shiki/engine/javascript");
		return createJavaScriptRegexEngine();
	}
	const response = await fetch(onigWasmUrl);
	if (!response.ok) throw new Error(`onig.wasm: HTTP ${response.status}`);
	const onig = await WebAssembly.compile(await response.arrayBuffer());
	return createOnigurumaEngine((imports) => WebAssembly.instantiate(onig, imports));
}

interface MonacoSetup {
	code: ResourceCodeHost;
	tokens: ReturnType<typeof createShikiTokens>;
}

let setup: MonacoSetup | null = null;
const missingProviders = new Set<string>();

function registerTokenProvider(id: string, tokens: MonacoSetup["tokens"]): void {
	monaco.languages.registerTokensProviderFactory(id, {
		create: async () => {
			if (await tokens.ready(id)) return tokens.provider(id);
			missingProviders.add(id);
			return null;
		},
	});
}

async function recoverProvider(id: string, tokens: MonacoSetup["tokens"]) {
	return missingProviders.has(id) && (await tokens.ready(id)) && missingProviders.delete(id);
}

function loadModelEmbeds(model: editor.ITextModel, tokens: MonacoSetup["tokens"]): void {
	const id = model.getLanguageId();
	void Promise.all([
		recoverProvider(id, tokens),
		tokens.loadEmbeds(id, () => (model.isDisposed() ? "" : model.getValue())),
	]).then(([recovered, loaded]) => {
		if (recovered || loaded) monaco.languages.setTokensProvider(id, tokens.provider(id));
	});
}

function watchModelEmbeds(tokens: MonacoSetup["tokens"]): void {
	monaco.editor.onDidCreateModel((model) => {
		loadModelEmbeds(model, tokens);
		const subscriptions = [
			model.onDidChangeContent(() => loadModelEmbeds(model, tokens)),
			model.onDidChangeLanguage(() => loadModelEmbeds(model, tokens)),
		];
		model.onWillDispose(() => {
			for (const subscription of subscriptions) subscription.dispose();
		});
	});
}

export function ensureMonaco(code: ResourceCodeHost): void {
	if (setup) return;
	const tokens = createShikiTokens({
		languages: code.languages,
		languageId: (value) => code.languageId(value),
		engine: createEngine,
	});
	registerShikiLanguages(code);
	monaco.editor.addKeybindingRules(WORD_NAVIGATION_KEYBINDINGS);
	for (const { id } of code.languages) registerTokenProvider(id, tokens);
	watchModelEmbeds(tokens);
	const theme = currentTheme(code);
	void tokens.applyTheme(theme.registration, theme.data.rules);
	defineTheme(theme);
	setup = { code, tokens };
	onThemeSwap(() => {
		void refreshTheme(code, tokens).catch(() => monaco.editor.setTheme(EDITOR_THEME));
	});
}

export function warmLanguage(id: string): void {
	setup?.tokens.warm(id);
}

async function refreshTheme(code: ResourceCodeHost, tokens: MonacoSetup["tokens"]): Promise<void> {
	const theme = currentTheme(code);
	await tokens.applyTheme(theme.registration, theme.data.rules);
	defineTheme(theme);
}
