import type { ReactNode, SVGProps } from "react";
import "./icons.css";

// Kantel's icons: 16px line icons on a 16 unit grid, 1.5 stroke, in currentColor. Inline SVG rather than an icon
// font or a library: each costs a few hundred bytes and only the ones a screen uses are bundled.
//
// An icon is decorative by default (aria-hidden). Pass `label` when the icon alone carries meaning, such as a status.

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { label?: string; size?: "sm" | "md" };

function Svg({ label, size = "md", className, children, ...rest }: IconProps & { children: ReactNode }) {
	return (
		// biome-ignore lint/a11y/noSvgWithoutTitle: decorative icons are aria-hidden; labelled ones get role="img" and a title.
		<svg
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={`kt-icon kt-icon-${size}${className ? ` ${className}` : ""}`}
			{...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
			{...rest}
		>
			{label === undefined ? null : <title>{label}</title>}
			{children}
		</svg>
	);
}

export const CheckIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M3.5 8.5l3 3 6-7" />
	</Svg>
);
export const CheckCircleIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="6.25" />
		<path d="M5.4 8.2l1.8 1.8 3.4-3.7" />
	</Svg>
);
export const XIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M4 4l8 8M12 4l-8 8" />
	</Svg>
);
export const XCircleIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="6.25" />
		<path d="M6 6l4 4M10 6l-4 4" />
	</Svg>
);
export const MinusCircleIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="6.25" />
		<path d="M5.5 8h5" />
	</Svg>
);
export const ChevronRightIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M6 3.5L10.5 8 6 12.5" />
	</Svg>
);
export const ChevronDownIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M3.5 6L8 10.5 12.5 6" />
	</Svg>
);
/** Only for the composer's icon-only send button. Never put an arrow beside button text. */
export const SendIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 13V3.5M4 7.5L8 3.5l4 4" />
	</Svg>
);
export const StopIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" />
	</Svg>
);
export const CopyIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
		<path d="M10.5 3.5v-.5A1.5 1.5 0 0 0 9 1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" />
	</Svg>
);
export const ShieldIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 1.75l5 2v4c0 3.2-2.2 5.4-5 6.5-2.8-1.1-5-3.3-5-6.5v-4z" />
	</Svg>
);
export const KeyIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="5.5" cy="10.5" r="3" />
		<path d="M7.6 8.4L13.5 2.5M11.5 4.5l1.5 1.5M10 6l1.25 1.25" />
	</Svg>
);
export const VaultIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="1.75" y="1.75" width="12.5" height="12.5" rx="3.5" />
		<path d="M8 4.75a1.75 1.75 0 0 0-.9 3.25l-.35 2.75h2.5l-.35-2.75A1.75 1.75 0 0 0 8 4.75z" />
	</Svg>
);
export const TerminalIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M3 4.5l3 3-3 3" />
		<path d="M8 11.5h5" />
	</Svg>
);
export const FileIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M9 1.75H4.5A1.25 1.25 0 0 0 3.25 3v10a1.25 1.25 0 0 0 1.25 1.25h7A1.25 1.25 0 0 0 12.75 13V5.5z" />
		<path d="M9 1.75V5.5h3.75" />
	</Svg>
);
/** A project: a folder, as T3 Code's sidebar shows one. */
export const FolderIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M1.75 4.25A1.25 1.25 0 0 1 3 3h3.25l1.5 1.75H13a1.25 1.25 0 0 1 1.25 1.25v6A1.25 1.25 0 0 1 13 13.25H3A1.25 1.25 0 0 1 1.75 12z" />
	</Svg>
);
/** A git repository: a book with a bookmark, as code hosts draw one. */
export const RepoIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M3.25 12.5V3.25A1.5 1.5 0 0 1 4.75 1.75h8v9.5h-8a1.5 1.5 0 0 0-1.5 1.5 1.5 1.5 0 0 0 1.5 1.5h1.5" />
		<path d="M8.25 12.75v2.25l1.25-.9 1.25.9v-2.25" />
	</Svg>
);
/** A git branch: two commits on a line and one branching off. */
export const BranchIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="4.5" cy="3.5" r="1.5" />
		<circle cx="4.5" cy="12.5" r="1.5" />
		<circle cx="11.5" cy="4.5" r="1.5" />
		<path d="M4.5 5v6M11.5 6c0 3-3 3.5-7 5" />
	</Svg>
);
export const EyeIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
		<circle cx="8" cy="8" r="2" />
	</Svg>
);
export const PencilIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M10.5 2.5l3 3L6 13H3v-3z" />
	</Svg>
);
export const SearchIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="7" cy="7" r="4.25" />
		<path d="M10.25 10.25L13.5 13.5" />
	</Svg>
);
export const GlobeIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="6.25" />
		<path d="M1.75 8h12.5M8 1.75c1.7 1.8 2.5 3.9 2.5 6.25S9.7 12.45 8 14.25C6.3 12.45 5.5 10.35 5.5 8S6.3 3.55 8 1.75z" />
	</Svg>
);
export const ClockIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="6.25" />
		<path d="M8 4.5V8l2.25 1.5" />
	</Svg>
);
export const DotsIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="3.5" cy="8" r="0.6" fill="currentColor" />
		<circle cx="8" cy="8" r="0.6" fill="currentColor" />
		<circle cx="12.5" cy="8" r="0.6" fill="currentColor" />
	</Svg>
);
export const AlertIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 2l6.25 11H1.75z" />
		<path d="M8 6.5v3M8 11.5v.01" />
	</Svg>
);
export const InfoIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="6.25" />
		<path d="M8 7.25V11M8 5v.01" />
	</Svg>
);
export const QuestionIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="8" cy="8" r="6.25" />
		<path d="M6.25 6.25a1.75 1.75 0 1 1 2.5 1.6c-.5.25-.75.6-.75 1.15v.25M8 11.25v.01" />
	</Svg>
);
export const PlusIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 3v10M3 8h10" />
	</Svg>
);
/** Attach a file. */
export const PaperclipIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M13.25 7.6l-5.3 5.3a3.25 3.25 0 0 1-4.6-4.6l5.65-5.65a2.17 2.17 0 0 1 3.07 3.07L6.4 11.4a1.08 1.08 0 0 1-1.53-1.53l5.13-5.12" />
	</Svg>
);
export const ImageIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="2" y="2.75" width="12" height="10.5" rx="1.75" />
		<circle cx="5.75" cy="6.25" r="1.1" />
		<path d="M2.5 12l3.6-3.6a1 1 0 0 1 1.4 0l1.5 1.5 1.1-1.1a1 1 0 0 1 1.4 0L14 11.4" />
	</Svg>
);
/** A text file: lines on a page. For pasted text the composer turned into an attachment. */
export const TextFileIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M9 1.75H4.5A1.25 1.25 0 0 0 3.25 3v10a1.25 1.25 0 0 0 1.25 1.25h7A1.25 1.25 0 0 0 12.75 13V5.5z" />
		<path d="M9 1.75V5.5h3.75M5.75 8.5h4.5M5.75 11h3" />
	</Svg>
);
/** Steer: the composer's icon-only button for a message to a running agent. */
export const SteerIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M3.5 13v-3.5A3 3 0 0 1 6.5 6.5h7M10.5 3.5l3 3-3 3" />
	</Svg>
);
export const RetryIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.75v2.5h-2.5" />
	</Svg>
);
/** Fork from this response: a branch splitting in two, after Lucide's git-fork, which T3 Code uses. */
export const ForkIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="4.5" cy="3.5" r="1.75" />
		<circle cx="11.5" cy="3.5" r="1.75" />
		<circle cx="8" cy="12.5" r="1.75" />
		<path d="M4.5 5.25v.75A1.5 1.5 0 0 0 6 7.5h4A1.5 1.5 0 0 0 11.5 6v-.75M8 7.5v3.25" />
	</Svg>
);
/** Edit from here: an arrow turning back, after Lucide's undo-2, which T3 Code uses. */
export const RewindIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M5.5 9.5 2.5 6.5l3-3M2.5 6.5h7a3.5 3.5 0 0 1 0 7H7.5" />
	</Svg>
);
/**
 * Thinking: a brain, after Lucide's brain, which T3 Code's live activity row and thinking picker use. Drawn on Lucide's
 * 24 unit grid and scaled to this one, with the stroke scaled back up to 1.5.
 */
export const BrainIcon = (props: IconProps) => (
	<Svg {...props}>
		<g transform="scale(0.6667)" strokeWidth={2.25}>
			<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
			<path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
			<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
			<path d="M12 5v13" />
		</g>
	</Svg>
);
/** Access: a padlock, for what an agent may do without asking (the composer's access picker). */
export const LockIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="3.25" y="7.25" width="9.5" height="6.75" rx="1.5" />
		<path d="M5.25 7.25V5.25a2.75 2.75 0 0 1 5.5 0v2" />
	</Svg>
);
/** A model: a four-point spark. */
export const SparkIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 1.75c.4 3.3 2.95 5.85 6.25 6.25-3.3.4-5.85 2.95-6.25 6.25C7.6 10.95 5.05 8.4 1.75 8 5.05 7.6 7.6 5.05 8 1.75z" />
	</Svg>
);
/** The sidebar: a window with its left pane drawn, for the button that collapses and expands it. */
export const SidebarIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75" />
		<path d="M6 2.75v10.5" />
	</Svg>
);
/** Skills: an open book, the instructions an agent can read. */
export const BookIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 4.25C6.75 3.25 4.75 2.75 1.75 2.75v9.5c3 0 5 .5 6.25 1.5 1.25-1 3.25-1.5 6.25-1.5v-9.5c-3 0-5 .5-6.25 1.5z" />
		<path d="M8 4.25v9.5" />
	</Svg>
);
/** Memory: stacked layers, what an agent has learnt and keeps. */
export const LayersIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 1.75l6.25 3.25L8 8.25 1.75 5z" />
		<path d="M1.75 8L8 11.25 14.25 8M1.75 11L8 14.25 14.25 11" />
	</Svg>
);
/** People: two heads and shoulders, for the organisation's members. */
export const PeopleIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="6" cy="5.5" r="2.5" />
		<path d="M1.75 13.5a4.25 4.25 0 0 1 8.5 0" />
		<path d="M10.5 3.25a2.25 2.25 0 0 1 0 4.5M12 9.75a4 4 0 0 1 2.25 3.75" />
	</Svg>
);
/** A log: lines of entries, each with a mark, for the audit log. */
export const ListIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M6 4h7.5M6 8h7.5M6 12h7.5" />
		<path d="M2.75 4h.01M2.75 8h.01M2.75 12h.01" strokeWidth={2} />
	</Svg>
);
