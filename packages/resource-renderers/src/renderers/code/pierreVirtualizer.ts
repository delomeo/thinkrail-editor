import {
	type AnnotationSide,
	DEFAULT_VIRTUAL_FILE_METRICS,
	type VirtualFileMetrics,
	Virtualizer,
} from "@pierre/diffs";
import type { UiScale } from "@thinkrail/contracts";
import { type RefCallback, useCallback, useEffect, useState } from "react";

type ConnectedInstance = Parameters<Virtualizer["connect"]>[1];

interface LinePositioned {
	getLinePosition(lineNumber: number, side?: AnnotationSide): { top: number } | undefined;
}

function isLinePositioned(
	instance: ConnectedInstance,
): instance is ConnectedInstance & LinePositioned {
	return typeof Reflect.get(instance, "getLinePosition") === "function";
}

export class PierreVirtualizer extends Virtualizer {
	private connected: { container: HTMLElement; instance: LinePositioned } | undefined;

	override connect(container: HTMLElement, instance: ConnectedInstance): () => void {
		if (isLinePositioned(instance)) this.connected = { container, instance };
		return super.connect(container, instance);
	}

	override disconnect(container: HTMLElement): void {
		if (this.connected?.container === container) this.connected = undefined;
		super.disconnect(container);
	}

	override cleanUp(): void {
		this.connected = undefined;
		super.cleanUp();
	}

	revealLine(lineNumber: number, side?: AnnotationSide): boolean {
		const root = this.getRoot();
		const connected = this.connected;
		if (!(root instanceof HTMLElement) || !connected) return false;
		const position = connected.instance.getLinePosition(lineNumber, side);
		if (!position) return false;
		const top = this.getOffsetInScrollContainer(connected.container) + position.top;
		this.scrollTo({ top: top - root.clientHeight / 2, behavior: "instant" });
		return true;
	}
}

const OVERSCROLL_SIZE = 400;
const HUNK_LINE_COUNT = 5;

function codeLineHeight(): number {
	const height = getComputedStyle(document.documentElement).getPropertyValue(
		"--tr-code-row-height",
	);
	return Number.parseFloat(height) || DEFAULT_VIRTUAL_FILE_METRICS.lineHeight;
}

function virtualFileMetrics(): VirtualFileMetrics {
	return {
		...DEFAULT_VIRTUAL_FILE_METRICS,
		lineHeight: codeLineHeight(),
		hunkLineCount: HUNK_LINE_COUNT,
	};
}

export function usePierreVirtualizer<T extends HTMLElement>(
	attachScroller: RefCallback<T>,
	uiScale: UiScale,
): { virtualizer: PierreVirtualizer; metrics: VirtualFileMetrics; attach: RefCallback<T> } {
	const [virtualizer] = useState(() => new PierreVirtualizer({ overscrollSize: OVERSCROLL_SIZE }));
	const [metrics, setMetrics] = useState<VirtualFileMetrics>(virtualFileMetrics);
	// The window a virtualizer renders starts at `scrollTop / lineHeight`. With the row height of the scale this
	// surface was opened under it starts below the line actually at the top of the pane, so re-read the token
	// the scale re-issued.
	useEffect(() => {
		const lineHeight = codeLineHeight();
		setMetrics((current) =>
			current.lineHeight === lineHeight ? current : { ...current, lineHeight },
		);
	}, [uiScale]);
	const attach = useCallback<RefCallback<T>>(
		(node) => {
			if (node) virtualizer.setup(node);
			else virtualizer.cleanUp();
			attachScroller(node);
		},
		[attachScroller, virtualizer],
	);
	return { virtualizer, metrics, attach };
}
