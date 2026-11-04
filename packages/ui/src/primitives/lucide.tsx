import {
	Activity,
	AppWindow,
	Archive,
	ArchiveRestore,
	Blocks,
	BookOpen,
	Bot,
	Box,
	Braces,
	Building2,
	Camera,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronsDownUp,
	ChevronsUpDown,
	CircleAlert,
	CreditCard,
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
	FolderClosed,
	KeyRound,
	Laptop,
	Layers,
	ListFilter,
	LogOut,
	type LucideIcon,
	Monitor,
	Moon,
	Network,
	Pause,
	Pencil,
	Pin,
	PinOff,
	Play,
	Plug,
	RectangleEllipsis,
	RefreshCw,
	RotateCcw,
	Search,
	Server,
	Settings,
	ShieldCheck,
	SkipBack,
	SkipForward,
	SquareCode,
	SquareTerminal,
	Sun,
	Trash2,
	Unplug,
	User,
	UserPlus,
	UserX,
	WandSparkles,
	Webhook,
	Zap,
} from "lucide-react";
import type { IconProps } from "./icons.tsx";

// Lucide icons (lucide.dev) in Kantel's icon shape: 16px (14 small), a 1.5px stroke whatever the size, in
// currentColor, decorative unless given a `label`. Imported one by one, so only the icons a screen uses are bundled.
// New menus and controls use these; the inline icons in icons.tsx stay until each is replaced.

const SIZES = { sm: 14, md: 16 } as const;

function lucide(Icon: LucideIcon, name: string) {
	function KantelLucide({ label, size = "md", className, ...rest }: IconProps) {
		return (
			<Icon
				size={SIZES[size]}
				strokeWidth={1.5}
				absoluteStrokeWidth
				className={`kt-icon kt-icon-${size}${className ? ` ${className}` : ""}`}
				{...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
				{...(rest as object)}
			/>
		);
	}
	KantelLucide.displayName = name;
	return KantelLucide;
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
/** The theme switch's three choices: follow the device, light, dark. */
export const SystemThemeIcon = lucide(Laptop, "SystemThemeIcon");
export const LightThemeIcon = lucide(Sun, "LightThemeIcon");
export const DarkThemeIcon = lucide(Moon, "DarkThemeIcon");
/** Your menu: the docs, and signing out. */
export const DocsIcon = lucide(BookOpen, "DocsIcon");
export const SignOutIcon = lucide(LogOut, "SignOutIcon");
/** A split button's caret: more ways to do its action. */
export const CaretIcon = lucide(ChevronDown, "CaretIcon");
/** A sandbox's desktop. */
export const DesktopIcon = lucide(Monitor, "DesktopIcon");
/** A subagent: the bot in T3 Code's subagent avatar. */
export const BotIcon = lucide(Bot, "BotIcon");
// A player's controls (a browser's replay) and a link that opens in a new tab.
export const PlayIcon = lucide(Play, "PlayIcon");
export const PauseIcon = lucide(Pause, "PauseIcon");
export const ReplayIcon = lucide(RotateCcw, "ReplayIcon");
export const PreviousStepIcon = lucide(SkipBack, "PreviousStepIcon");
export const NextStepIcon = lucide(SkipForward, "NextStepIcon");
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
/** A script the agent ran (code mode's `codemode` calls). */
export const ScriptIcon = lucide(SquareCode, "ScriptIcon");
export const ExpandIcon = lucide(ChevronsUpDown, "ExpandIcon");
export const CollapseIcon = lucide(ChevronsDownUp, "CollapseIcon");
// The Connections page (src/connections/): a connection, the catalogue, a remote MCP server, a key, an OAuth app, and
// a connection's owner (a person, a project, the organisation).
export const PlugIcon = lucide(Plug, "PlugIcon");
export const UnplugIcon = lucide(Unplug, "UnplugIcon");
export const CatalogueIcon = lucide(Blocks, "CatalogueIcon");
export const ServerIcon = lucide(Server, "ServerIcon");
// An environment: a long-lived machine sessions attach to (sandbox tier 3).
export const EnvironmentIcon = lucide(Layers, "EnvironmentIcon");
export const KeyRoundIcon = lucide(KeyRound, "KeyRoundIcon");
export const AppWindowIcon = lucide(AppWindow, "AppWindowIcon");
export const LucideSearchIcon = lucide(Search, "LucideSearchIcon");
export const ReconnectIcon = lucide(RefreshCw, "ReconnectIcon");
export const ShieldCheckIcon = lucide(ShieldCheck, "ShieldCheckIcon");
export const PersonIcon = lucide(User, "PersonIcon");
/** Members' Invite, and revoking an invite. */
export const InviteIcon = lucide(UserPlus, "InviteIcon");
export const RevokeInviteIcon = lucide(UserX, "RevokeInviteIcon");
export const ProjectIcon = lucide(FolderClosed, "ProjectIcon");
export const OrganisationIcon = lucide(Building2, "OrganisationIcon");
/** Connections' setup tiers: nothing to set up, a code to type, an app made with Kantel's help. */
export const NoSetupIcon = lucide(Zap, "NoSetupIcon");
export const SignInCodeIcon = lucide(RectangleEllipsis, "SignInCodeIcon");
export const GuidedSetupIcon = lucide(WandSparkles, "GuidedSetupIcon");
/** The console's Settings, and the way back out of them to the sessions. */
export const SettingsIcon = lucide(Settings, "SettingsIcon");
export const BackIcon = lucide(ChevronLeft, "BackIcon");
/** A step in a collapsed section of work failed: T3 Code's failure mark (CircleAlertIcon) on its line. */
export const StepFailedIcon = lucide(CircleAlert, "StepFailedIcon");
/** The compute console's pages (src/compute/): sandboxes, snapshots, the egress proxy, webhooks, OpenTelemetry, billing. */
export const SandboxIcon = lucide(Box, "SandboxIcon");
export const SnapshotIcon = lucide(Camera, "SnapshotIcon");
export const ProxyIcon = lucide(Network, "ProxyIcon");
export const WebhookIcon = lucide(Webhook, "WebhookIcon");
export const TelemetryIcon = lucide(Activity, "TelemetryIcon");
export const BillingIcon = lucide(CreditCard, "BillingIcon");
