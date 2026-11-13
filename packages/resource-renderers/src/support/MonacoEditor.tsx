import { useT } from "@thinkrail/locales/react";
import type { editor, IDisposable } from "monaco-editor/editor/editor.api.js";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { type ResourceHost, useResourceHost, useResourcePreferences } from "../host";
import type { ResourceDescriptor, ResourceViewProps, SurfaceReview } from "../registry";
import { currentEditorSettings, publishEditorSettings } from "./editorSettings";
import { attachIndentRainbow } from "./indentRainbow";
import { MonacoReviewZones } from "./MonacoReviewZones";
import { decorateEditorContextMenus } from "./monacoMenuIcons";
import {
	attachLanguageServices,
	createFileEditor,
	disposeFileEditor,
	ensureMonaco,
	fileEditorOptions,
	languageForPath,
	revealLineNow,
	revealPendingTarget,
	SAVE_FILE_KEYBINDING,
	syncFileModel,
	warmLanguage,
} from "./monacoSetup";
import {
	applyReviewDecorations,
	attachReviewCommenting,
	attachReviewThreads,
	type MonacoReviewZoneState,
	type ReviewCommenting,
} from "./reviewWidgets";

function focusLine(review: SurfaceReview): number | null {
	const range = review.focus?.anchor.selectors.find((selector) => selector.kind === "lineRange");
	return range?.kind === "lineRange" ? range.startLine : null;
}

function isEditorViewState(value: unknown): value is editor.ICodeEditorViewState {
	if (typeof value !== "object" || value === null) return false;
	return Array.isArray(Reflect.get(value, "cursorState")) && Reflect.has(value, "viewState");
}

export function warm(host: ResourceHost, resource: ResourceDescriptor): void {
	ensureMonaco(host.code);
	setTimeout(() => warmLanguage(languageForPath(resource.path)), 0);
}

export default function MonacoEditor({
	resource,
	content,
	review,
	viewState,
	onViewState,
	editable = false,
	onChange,
	onSave,
	collaboration,
}: ResourceViewProps) {
	const t = useT();
	const host = useResourceHost();
	const preferences = useResourcePreferences();
	ensureMonaco(host.code);
	const scope = useId().replace(/[^\w-]/g, "");
	const path = resource.path;
	const text = content.kind === "text" ? content.text : "";
	// Only the editing surface claims the file's own `file://` model, and the host is what knows where
	// the file actually is.
	const filePath = editable ? host.filePath(resource.workspaceId, path) : undefined;
	const commentLabel = t("review.widget.commentOnSelection");
	const saveLabel = t("common.save");
	const options = fileEditorOptions(t, preferences, path, editable);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const commentingRef = useRef<ReviewCommenting | null>(null);
	const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
	const threadsRef = useRef<ReturnType<typeof attachReviewThreads> | null>(null);
	const decorationsRef = useRef<string[]>([]);
	const freshMountRef = useRef(false);
	const saveActionRef = useRef<IDisposable | null>(null);
	const lspRef = useRef<IDisposable | null>(null);
	const indentRef = useRef<IDisposable | null>(null);
	const sharedRef = useRef<IDisposable | null>(null);
	const appliedRef = useRef({ scope, path, text, options });
	const latestRef = useRef({
		scope,
		path,
		text,
		filePath,
		options,
		commentLabel,
		viewState,
		review,
		onViewState,
		editable,
		onChange,
		onSave,
		collaboration,
	});
	const [reviewZones, setReviewZones] = useState<MonacoReviewZoneState>({
		threads: [],
		composer: null,
	});

	useLayoutEffect(() => {
		latestRef.current = {
			scope,
			path,
			text,
			filePath,
			options,
			commentLabel,
			viewState,
			review,
			onViewState,
			editable,
			onChange,
			onSave,
			collaboration,
		};
	});

	const applySaveAction = (codeEditor: editor.IStandaloneCodeEditor, enabled: boolean): void => {
		saveActionRef.current?.dispose();
		saveActionRef.current = enabled
			? codeEditor.addAction({
					id: `thinkrail.code.save.${codeEditor.getId()}`,
					label: saveLabel,
					keybindings: [SAVE_FILE_KEYBINDING],
					run: () => latestRef.current.onSave?.(),
				})
			: null;
	};

	// Only the mount that holds the file's own `file://` model asks for language services: a server
	// answers nothing about a document it cannot locate. Colourized indent guides belong to every model.
	const attachToModel = (codeEditor: editor.IStandaloneCodeEditor): void => {
		lspRef.current?.dispose();
		indentRef.current?.dispose();
		const model = codeEditor.getModel();
		lspRef.current =
			model?.uri.scheme === "file"
				? attachLanguageServices(model, host, resource.workspaceId)
				: null;
		indentRef.current =
			model === null
				? null
				: attachIndentRainbow(codeEditor, model, () => currentEditorSettings().indentRainbow);
	};

	// The host's editor settings reach every live code surface, not only the one that re-rendered.
	useLayoutEffect(() => {
		publishEditorSettings(preferences.editor);
	}, [preferences.editor]);

	useLayoutEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		const mount = latestRef.current;
		const codeEditor = createFileEditor(container, mount);
		editorRef.current = codeEditor;
		freshMountRef.current = true;
		appliedRef.current = {
			scope: mount.scope,
			path: mount.path,
			text: mount.text,
			options: mount.options,
		};
		const menuIcons = decorateEditorContextMenus(codeEditor);
		const modelContent = codeEditor.onDidChangeModelContent(() => {
			const current = latestRef.current;
			if (!current.editable) return;
			const value = codeEditor.getValue();
			appliedRef.current.text = value;
			if (value === current.text) return;
			current.onChange?.(value);
		});
		applySaveAction(codeEditor, mount.editable);
		if (isEditorViewState(mount.viewState)) codeEditor.restoreViewState(mount.viewState);
		revealPendingTarget(codeEditor, mount.path);
		const threads = mount.review ? attachReviewThreads(codeEditor, setReviewZones) : null;
		const commenting = threads
			? attachReviewCommenting(codeEditor, threads, mount.commentLabel)
			: null;
		attachToModel(codeEditor);
		threadsRef.current = threads;
		commentingRef.current = commenting;
		return () => {
			const saved = codeEditor.saveViewState();
			if (saved) latestRef.current.onViewState?.(saved);
			modelContent.dispose();
			saveActionRef.current?.dispose();
			saveActionRef.current = null;
			menuIcons.dispose();
			commenting?.dispose();
			threads?.dispose();
			threadsRef.current = null;
			commentingRef.current = null;
			editorRef.current = null;
			decorationsRef.current = [];
			lspRef.current?.dispose();
			lspRef.current = null;
			indentRef.current?.dispose();
			indentRef.current = null;
			disposeFileEditor(codeEditor);
		};
	}, []);

	// A shared file follows the seam, not the mount: sharing the file already on screen binds it, and leaving
	// the room unbinds it, without remounting the editor.
	useLayoutEffect(() => {
		const codeEditor = editorRef.current;
		const model = codeEditor?.getModel() ?? null;
		sharedRef.current?.dispose();
		sharedRef.current = null;
		if (collaboration === undefined || codeEditor === null || model === null) return;
		sharedRef.current = collaboration.attach(codeEditor, model);
	}, [collaboration]);

	useLayoutEffect(() => {
		// A bound model answers to the shared document, not to the buffer that described the file: re-writing it
		// here would overwrite what a teammate just typed.
		if (collaboration !== undefined) return;
		const codeEditor = editorRef.current;
		const applied = appliedRef.current;
		if (
			!codeEditor ||
			(applied.scope === scope && applied.path === path && applied.text === text)
		) {
			return;
		}
		const previousModel = codeEditor.getModel();
		syncFileModel(codeEditor, { scope, path, text, filePath }, applied.text);
		// The language follows the path, so a swapped model is a different document: re-attaching here is
		// what keeps the file that left the screen from holding its language server open.
		if (codeEditor.getModel() !== previousModel) {
			attachToModel(codeEditor);
			revealPendingTarget(codeEditor, path);
		}
		appliedRef.current = { ...applied, scope, path, text };
	}, [scope, path, text]);

	useLayoutEffect(() => {
		commentingRef.current?.setLabel(commentLabel);
	}, [commentLabel]);

	useLayoutEffect(() => {
		const codeEditor = editorRef.current;
		if (!codeEditor || appliedRef.current.options === options) return;
		appliedRef.current = { ...appliedRef.current, options };
		codeEditor.updateOptions(options);
		applySaveAction(codeEditor, editable);
	}, [options]);

	const closeComposer = () => threadsRef.current?.closeComposer();
	const layoutReviewZones = () => threadsRef.current?.layout();

	useLayoutEffect(() => {
		const codeEditor = editorRef.current;
		const freshMount = freshMountRef.current;
		freshMountRef.current = false;
		if (!review || !codeEditor) return;
		threadsRef.current?.setThreads(review.threads);
		decorationsRef.current = applyReviewDecorations(
			codeEditor,
			decorationsRef.current,
			review.threads,
		);
		const line = focusLine(review);
		if (line === null) return;
		if (freshMount) revealLineNow(codeEditor, line);
		else codeEditor.revealLineInCenter(line);
		review.onFocusHandled();
	}, [review]);

	return (
		<>
			<div ref={containerRef} className="h-full w-full text-left" />
			<MonacoReviewZones
				zones={reviewZones}
				review={review}
				onCloseComposer={closeComposer}
				onRendered={layoutReviewZones}
			/>
		</>
	);
}
