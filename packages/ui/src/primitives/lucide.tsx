import {
	Archive,
	ArchiveRestore,
	Bot,
	Braces,
	Check,
	ChevronRight,
	ChevronsDownUp,
	ChevronsUpDown,
	CircleAlert,
	Ellipsis,
	ExternalLink,
	Eye,
	EyeOff,
	File,
	FileCode,
	FileDiff,
	FileImage,
	FilePenLine,
	FileSpreadsheet,
	FileText,
	ListFilter,
	type LucideIcon,
	Palette,
	Pause,
	Pencil,
	Pin,
	PinOff,
	Play,
	RotateCcw,
	SquareTerminal,
	Trash2,
} from "lucide-react";
import type { IconProps } from "./icons.tsx";

// Lucide icons (lucide.dev) in Harbour's icon shape: 16px (14 small), a 1.5px stroke whatever the size, in
// currentColor, decorative unless given a `label`. Imported one by one, so only the icons a screen uses are bundled.
// New menus and controls use these; the inline icons in icons.tsx stay until each is replaced.

const SIZES = { sm: 14, md: 16 } as const;

function lucide(Icon: LucideIcon, name: string) {
	function HarbourLucide({ label, size = "md", className, ...rest }: IconProps) {
		return (
			<Icon
				size={SIZES[size]}
				strokeWidth={1.5}
				absoluteStrokeWidth
				className={`hb-icon hb-icon-${size}${className ? ` ${className}` : ""}`}
				{...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
				{...(rest as object)}
			/>
		);
	}
	HarbourLucide.displayName = name;
	return HarbourLucide;
}

export const ArchiveIcon = lucide(Archive, "ArchiveIcon");
export const UnarchiveIcon = lucide(ArchiveRestore, "UnarchiveIcon");
export const MenuCheckIcon = lucide(Check, "MenuCheckIcon");
export const MenuChevronIcon = lucide(ChevronRight, "MenuChevronIcon");
export const EllipsisIcon = lucide(Ellipsis, "EllipsisIcon");
export const MarkReadIcon = lucide(Eye, "MarkReadIcon");
export const MarkUnreadIcon = lucide(EyeOff, "MarkUnreadIcon");
export const FilterIcon = lucide(ListFilter, "FilterIcon");
export const RenameIcon = lucide(Pencil, "RenameIcon");
export const PinIcon = lucide(Pin, "PinIcon");
export const UnpinIcon = lucide(PinOff, "UnpinIcon");
export const TrashIcon = lucide(Trash2, "TrashIcon");
export const PaletteIcon = lucide(Palette, "PaletteIcon");
/** A subagent: the bot in T3 Code's subagent avatar. */
export const BotIcon = lucide(Bot, "BotIcon");
// A player's controls (a browser's replay) and a link that opens in a new tab.
export const PlayIcon = lucide(Play, "PlayIcon");
export const PauseIcon = lucide(Pause, "PauseIcon");
export const ReplayIcon = lucide(RotateCcw, "ReplayIcon");
export const ExternalLinkIcon = lucide(ExternalLink, "ExternalLinkIcon");
// File types, for attachment cards (`file-icons.ts`).
export const LucideFileIcon = lucide(File, "LucideFileIcon");
export const FileTextIcon = lucide(FileText, "FileTextIcon");
export const FileImageIcon = lucide(FileImage, "FileImageIcon");
export const FileCodeIcon = lucide(FileCode, "FileCodeIcon");
export const FileSpreadsheetIcon = lucide(FileSpreadsheet, "FileSpreadsheetIcon");
// The file and shell tools' cards (`session/tool-views.tsx`): a file written, a file edited, a terminal, the raw call,
// and a long view's expand and collapse.
export const FileWriteIcon = lucide(FilePenLine, "FileWriteIcon");
export const FileDiffIcon = lucide(FileDiff, "FileDiffIcon");
export const TerminalWindowIcon = lucide(SquareTerminal, "TerminalWindowIcon");
export const RawIcon = lucide(Braces, "RawIcon");
export const ExpandIcon = lucide(ChevronsUpDown, "ExpandIcon");
export const CollapseIcon = lucide(ChevronsDownUp, "CollapseIcon");
/** Something in a collapsed section of work failed: T3 Code's failure mark (CircleAlertIcon) on its line. */
export const FailedStepsIcon = lucide(CircleAlert, "FailedStepsIcon");
