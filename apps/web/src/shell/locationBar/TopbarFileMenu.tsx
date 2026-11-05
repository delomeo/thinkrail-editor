import {
	RiFileAddLine as FileAdd,
	RiFolderAddLine as FolderAdd,
	RiFolderOpenLine as FolderOpen,
	RiGlobalLine as Globe,
	RiSaveLine as Save,
	RiSparkling2Line as Sparkles,
} from "@remixicon/react";
import type { Workspace } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@thinkrail/ui/dropdown-menu";
import { useRef } from "react";
import { useOpenProject } from "../../panels/useOpenProject";
import { goToProjectHome } from "./ProjectSegment";
import { PillChevron, pillClass, Segment } from "./Segment";

/** A file item runs only for an active workspace and when the caller supplied that item's handler. */
export function canRunFileAction(workspace: Workspace | null, handler?: () => void): boolean {
	return workspace !== null && handler !== undefined;
}

export function TopbarFileMenu({
	workspace,
	onNewFile,
	onNewFolder,
	onSaveFile,
}: {
	workspace: Workspace | null;
	onNewFile?: (() => void) | undefined;
	onNewFolder?: (() => void) | undefined;
	onSaveFile?: (() => void) | undefined;
}) {
	const t = useT();
	const startsNameEditRef = useRef(false);
	const { pickAndOpen, startNewProject, cloneRepository, dialogs } = useOpenProject((opened) =>
		goToProjectHome(opened.id),
	);
	return (
		<Segment
			caption={t("shell.location.file.caption")}
			testid="scope-file-segment"
			className="hidden max-w-[140px] shrink-0 pl-0 sm:flex"
		>
			<DropdownMenu>
				<DropdownMenuTrigger
					data-testid="scope-file"
					aria-label={t("shell.location.file.label")}
					className={pillClass}
				>
					<span data-testid="scope-file-label" className="truncate tr-title-section">
						{t("shell.location.file.trigger")}
					</span>
					<PillChevron />
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					data-testid="scope-file-menu"
					onCloseAutoFocus={(event) => {
						// A file item opens the Files tree's own name row; returning focus to this trigger would
						// blur it before the user typed, and a blurred empty row is a cancelled create.
						if (!startsNameEditRef.current) return;
						startsNameEditRef.current = false;
						event.preventDefault();
					}}
				>
					<DropdownMenuLabel>{t("shell.location.file.caption")}</DropdownMenuLabel>
					<DropdownMenuItem
						data-testid="scope-file-new"
						disabled={!canRunFileAction(workspace, onNewFile)}
						onSelect={() => {
							startsNameEditRef.current = true;
							onNewFile?.();
						}}
					>
						<FileAdd />
						{t("panels.files.newFile")}
					</DropdownMenuItem>
					<DropdownMenuItem
						data-testid="scope-file-new-folder"
						disabled={!canRunFileAction(workspace, onNewFolder)}
						onSelect={() => {
							startsNameEditRef.current = true;
							onNewFolder?.();
						}}
					>
						<FolderAdd />
						{t("panels.files.newFolder")}
					</DropdownMenuItem>
					<DropdownMenuItem
						data-testid="scope-file-save"
						disabled={!canRunFileAction(workspace, onSaveFile)}
						onSelect={() => onSaveFile?.()}
					>
						<Save />
						{t("shell.location.file.saveFile")}
					</DropdownMenuItem>
					<DropdownMenuSeparator />
					<DropdownMenuLabel>{t("shell.location.file.projectGroup")}</DropdownMenuLabel>
					<DropdownMenuItem
						data-testid="scope-file-open-project"
						onSelect={() => void pickAndOpen()}
					>
						<FolderOpen />
						{t("panels.addProject.open")}
					</DropdownMenuItem>
					<DropdownMenuItem data-testid="scope-file-start-new" onSelect={startNewProject}>
						<Sparkles />
						{t("panels.addProject.startNew")}
					</DropdownMenuItem>
					{cloneRepository ? (
						<DropdownMenuItem data-testid="scope-file-clone" onSelect={cloneRepository}>
							<Globe />
							{t("panels.addProject.clone")}
						</DropdownMenuItem>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
			{dialogs}
		</Segment>
	);
}
