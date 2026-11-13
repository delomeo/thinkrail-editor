import type { EditorSettings, ResourceMeta, UiScale } from "@thinkrail/contracts";
import type { ComponentProps, ComponentType, ReactNode } from "react";
import { createContext, useContext } from "react";
import type ReactMarkdown from "react-markdown";
import type { LanguageRegistration, ThemeRegistration } from "shiki/core";
import type { ResourceEnvironment, SurfaceReview } from "./registry";

type ReactMarkdownProps = ComponentProps<typeof ReactMarkdown>;

export type MarkdownRehypePlugins = ReactMarkdownProps["rehypePlugins"];

export interface ResourceMarkdownProps {
	text: string;
	className?: string;
	remarkPlugins?: ReactMarkdownProps["remarkPlugins"];
	rehypePlugins?: MarkdownRehypePlugins;
	urlTransform?: ReactMarkdownProps["urlTransform"];
	components?: ReactMarkdownProps["components"];
}

export type ResourceMarkdown = ComponentType<ResourceMarkdownProps>;

export interface ResourceCodeLanguage {
	id: string;
	extensions: readonly string[];
	aliases: readonly string[];
	filenames?: readonly string[];
	load: () => Promise<{ default: LanguageRegistration[] }>;
}

export interface ResourceCodeHost {
	languages: readonly ResourceCodeLanguage[];
	languageId(value: string): string | null;
	theme(options: {
		name: string;
		type: "light" | "dark";
		readVariable: (name: string) => string;
	}): ThemeRegistration;
}

export interface ResourceScope {
	workspaceId: string;
	sessionId?: string | undefined;
}

export interface ResourceReviewSendProps {
	workspaceId: string;
	paths: readonly string[];
	sessionId?: string | undefined;
}

export interface ResourceFileReviewProps {
	workspaceId: string;
	path: string;
	kind: "inline" | "diff";
	sessionId?: string | undefined;
	children: (review: SurfaceReview) => ReactNode;
}

export interface ResourceHost {
	markdown: ResourceMarkdown;
	code: ResourceCodeHost;
	bytesUrl(workspaceId: string, path: string, oid?: string | null): string;
	/**
	 * The absolute filesystem path a workspace file has on the machine that reads it, or `undefined`
	 * when this host cannot name one. A language server resolves a document by that path, so a model
	 * that wants language services needs it.
	 */
	filePath(workspaceId: string, path: string): string | undefined;
	/**
	 * The absolute path of that workspace's own root directory, or `undefined` when this host cannot name
	 * one. A language server resolves the environment a project installed its libraries into from that
	 * directory, never from the file being edited.
	 */
	workspacePath(workspaceId: string): string | undefined;
	openFile(workspaceId: string, path: string, options?: { keep?: boolean }): void;
	openComparison(workspaceId: string, before: string, path: string): void;
	readFile(
		workspaceId: string,
		path: string,
	): Promise<{ content: string; meta?: ResourceMeta | undefined }>;
	subscribeFileChanges(
		workspaceId: string,
		onChange: (paths: readonly string[] | null) => void,
	): () => void;
	FileReview: ComponentType<ResourceFileReviewProps>;
	ReviewSend: ComponentType<ResourceReviewSendProps>;
}

export interface ResourcePreferences {
	fileLineWidth: number;
	fileLineWidthBounded: boolean;
	/** Editor-surface settings the code renderers paint with, as the host's config carries them. */
	editor: EditorSettings;
	/**
	 * The scale `<html>` carries. Monaco, xterm and Pierre take their font and row metrics as JS options read
	 * from the generated tokens, so they need a render when the selected scale changes — without it a code
	 * surface keeps the metrics of the scale it was opened under while the text around it moves.
	 */
	uiScale: UiScale;
}

const ResourceHostContext = createContext<ResourceHost | null>(null);
const ResourcePreferencesContext = createContext<ResourcePreferences | null>(null);
const ResourceEnvironmentContext = createContext<ResourceEnvironment | null>(null);
const ResourceScopeContext = createContext<ResourceScope | null>(null);

export const ResourceHostProvider = ResourceHostContext.Provider;
export const ResourcePreferencesProvider = ResourcePreferencesContext.Provider;
export const ResourceEnvironmentProvider = ResourceEnvironmentContext.Provider;
export const ResourceScopeProvider = ResourceScopeContext.Provider;

export function useOptionalResourceHost(): ResourceHost | null {
	return useContext(ResourceHostContext);
}

export function useResourceHost(): ResourceHost {
	const host = useContext(ResourceHostContext);
	if (!host) throw new Error("Resource renderers need a ResourceHostProvider");
	return host;
}

export function useResourcePreferences(): ResourcePreferences {
	const preferences = useContext(ResourcePreferencesContext);
	if (!preferences) throw new Error("Resource renderers need a ResourcePreferencesProvider");
	return preferences;
}

export function useResourceScope(): ResourceScope | null {
	return useContext(ResourceScopeContext);
}

export function useResourceEnvironment(): ResourceEnvironment {
	const environment = useContext(ResourceEnvironmentContext);
	if (!environment) throw new Error("Resource renderers need a ResourceEnvironmentProvider");
	return environment;
}
