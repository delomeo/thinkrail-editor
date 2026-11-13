import { INDENT_RAINBOW_COLORS, type IndentRainbowSettings, rgbaPaint } from "@thinkrail/contracts";
import type { editor, IDisposable } from "monaco-editor/editor/editor.api.js";
import { subscribeEditorSettings } from "./editorSettings";

/** Guides are painted for the visible window plus this, so a fast scroll never shows a bare stretch. */
const BUFFER_LINES = 30;

const stepClass = (index: number) => `tr-indent-step-${index}`;
const activeStepClass = (index: number) => `tr-indent-step-active-${index}`;

/** The visible lines of the indent step at column `step * tabSize + 1`. */
export interface IndentStep {
	step: number;
	startColumn: number;
	endColumn: number;
}

/** Whether this document takes the custom guides, i.e. whether Monaco's own should step aside. */
export function indentRainbowApplies(settings: IndentRainbowSettings, languageId: string): boolean {
	return settings.enabled && !settings.excludedLanguages.includes(languageId);
}

/**
 * The four cycle colours as paint alphas, on the custom-property names the guide rules read. An alpha of
 * zero is how a style that does not draw a line, or does not fill a block, opts out of that half.
 */
export function indentRainbowVariables(settings: IndentRainbowSettings): Record<string, string> {
	const drawsLine = settings.style !== "background";
	const drawsBackground = settings.style !== "lines";
	const variables: Record<string, string> = {};
	settings.colors.slice(0, INDENT_RAINBOW_COLORS).forEach((color, index) => {
		variables[`--tr-indent-line-${index}`] = rgbaPaint(color, drawsLine ? settings.lineOpacity : 0);
		variables[`--tr-indent-line-active-${index}`] = rgbaPaint(
			color,
			drawsLine ? settings.activeLineOpacity : 0,
		);
		variables[`--tr-indent-bg-${index}`] = rgbaPaint(
			color,
			drawsBackground ? settings.backgroundOpacity : 0,
		);
	});
	return variables;
}

function guideRule(className: string, lineVar: string, bgVar: string): string {
	// The negative margin cancels the border's width, so a guide never shifts the code it sits beside.
	return (
		`.monaco-editor .${className}{border-left:1px solid var(${lineVar});` +
		`background-color:var(${bgVar});margin-left:-1px;pointer-events:none}`
	);
}

const GUIDE_CSS = [
	...Array.from({ length: INDENT_RAINBOW_COLORS }, (_unused, index) =>
		guideRule(stepClass(index), `--tr-indent-line-${index}`, `--tr-indent-bg-${index}`),
	),
	// Declared after the base rules, so the cursor's own level wins over the class it also carries.
	...Array.from({ length: INDENT_RAINBOW_COLORS }, (_unused, index) =>
		guideRule(
			activeStepClass(index),
			`--tr-indent-line-active-${index}`,
			`--tr-indent-bg-${index}`,
		),
	),
].join("");

/** The steps of one line's leading whitespace: a tab is `tabSize` columns, a space is one. */
export function indentSteps(text: string, tabSize: number): IndentStep[] {
	const width = Math.max(1, Math.trunc(tabSize) || 1);
	let columns = 0;
	let index = 0;
	while (index < text.length) {
		const character = text[index];
		if (character === "\t") columns += width;
		else if (character === " ") columns += 1;
		else break;
		index += 1;
	}
	const steps: IndentStep[] = [];
	for (let step = 0; step < Math.floor(columns / width); step++) {
		steps.push({
			step,
			startColumn: step * width + 1,
			endColumn: Math.min((step + 1) * width, columns) + 1,
		});
	}
	return steps;
}

export function indentStepClass(step: number, active: boolean): string {
	const index = step % INDENT_RAINBOW_COLORS;
	return active ? `${stepClass(index)} ${activeStepClass(index)}` : stepClass(index);
}

function applyVariables(node: HTMLElement, settings: IndentRainbowSettings): void {
	const variables = indentRainbowVariables(settings);
	for (const [name, value] of Object.entries(variables)) node.style.setProperty(name, value);
	const root = node.getRootNode();
	const head = root instanceof Document ? root.head : (root as ShadowRoot);
	if (head.querySelector("style[data-indent-rainbow]")) return;
	const style = document.createElement("style");
	style.dataset.indentRainbow = "true";
	style.textContent = GUIDE_CSS;
	head.appendChild(style);
}

/**
 * Colour every indentation step of the lines on screen, cycling the configured palette, and mark the
 * cursor's own line with the active alphas. Decoration work stays inside the visible window and one
 * animation frame, whatever asked for it.
 */
export function attachIndentRainbow(
	codeEditor: editor.ICodeEditor,
	model: editor.ITextModel,
	getSettings: () => IndentRainbowSettings,
): IDisposable {
	const decorations = codeEditor.createDecorationsCollection([]);
	let frame = 0;

	const render = (): void => {
		if (model.isDisposed() || codeEditor.getModel() !== model) return;
		const settings = getSettings();
		const node = codeEditor.getDomNode();
		if (node !== null) applyVariables(node, settings);
		if (!indentRainbowApplies(settings, model.getLanguageId())) {
			decorations.set([]);
			return;
		}
		const tabSize = Math.max(1, Math.trunc(model.getOptions().tabSize) || 1);
		const ranges = codeEditor.getVisibleRanges();
		if (ranges.length === 0) return;
		let first = Number.POSITIVE_INFINITY;
		let last = 0;
		for (const range of ranges) {
			first = Math.min(first, range.startLineNumber);
			last = Math.max(last, range.endLineNumber);
		}
		const cursorLine = codeEditor.getPosition()?.lineNumber ?? 0;
		const next: editor.IModelDeltaDecoration[] = [];
		for (
			let line = Math.max(1, first - BUFFER_LINES);
			line <= Math.min(model.getLineCount(), last + BUFFER_LINES);
			line++
		) {
			for (const { step, startColumn, endColumn } of indentSteps(
				model.getLineContent(line),
				tabSize,
			)) {
				next.push({
					range: { startLineNumber: line, startColumn, endLineNumber: line, endColumn },
					options: { className: indentStepClass(step, line === cursorLine) },
				});
			}
		}
		decorations.set(next);
	};

	const schedule = (): void => {
		if (frame !== 0) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			render();
		});
	};

	const subscriptions = [
		codeEditor.onDidChangeModelContent(schedule),
		codeEditor.onDidScrollChange((event) => {
			if (event.scrollTopChanged) schedule();
		}),
		codeEditor.onDidChangeModelOptions((event) => {
			if (event.tabSize) schedule();
		}),
		codeEditor.onDidChangeCursorPosition(schedule),
		model.onDidChangeLanguage(schedule),
	];
	const unsubscribe = subscribeEditorSettings(schedule);
	render();

	return {
		dispose() {
			if (frame !== 0) cancelAnimationFrame(frame);
			for (const subscription of subscriptions) subscription.dispose();
			unsubscribe();
			decorations.clear();
		},
	};
}
