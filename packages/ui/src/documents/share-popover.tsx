import { Check, ChevronDown, FileDown, FileText, Globe, Link, Lock, Share, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { initials } from "../identity/signed-in-as.tsx";
import { Button } from "../primitives/button.tsx";
import { SegmentedControl } from "../primitives/controls.tsx";

// Sharing a file the agent made, after Claude's Share popover: Share (invite people by email, who has access, general
// access and the link) and Export (Markdown, PDF). Presentational: the host owns the share and its calls, and passes
// the state in.

/** Who besides those invited can open the file: only its owner, or anyone with the link. */
export type ShareAccess = "restricted" | "link";

export type ShareInvite = {
	readonly email: string;
};

export type ShareState = {
	/** The file's owner: the person sharing it. */
	readonly owner: { readonly name: string; readonly email?: string | undefined };
	readonly access: ShareAccess;
	readonly invites: readonly ShareInvite[];
	/** The link, once the file has one. */
	readonly link?: string | undefined;
};

export type ShareExport = {
	readonly id: string;
	/** "Markdown", "PDF". */
	readonly label: string;
	/** What it gives: "A .md file", "Print or save as PDF". */
	readonly hint: string;
	readonly run: () => void;
};

/** The Share tab's state and calls. */
export type ShareControls = {
	/** The share as it stands; `undefined` while it loads. */
	share: ShareState | undefined;
	/** Why the last change failed, if it did. */
	error?: string | undefined;
	onAccessChange: (access: ShareAccess) => Promise<void> | void;
	/** Records an invitation. Sending it is the host's business. */
	onInvite: (email: string) => Promise<void> | void;
	onRemoveInvite?: ((email: string) => Promise<void> | void) | undefined;
	/** The link to copy, made first if the file has none yet. */
	onCopyLink: () => Promise<string>;
};

export type SharePopoverProps = {
	/** The file's title, at the top. */
	title: string;
	/** Sharing, when the host can share. Without it the popover offers Export alone. */
	sharing?: ShareControls | undefined;
	exports: readonly ShareExport[];
	onClose: () => void;
	/** Which tab opens first. */
	initialTab?: "share" | "export";
};

const ACCESS: { readonly [access in ShareAccess]: { label: string; hint: string } } = {
	restricted: { label: "Only you", hint: "Only people who can see this session can open the link" },
	link: { label: "Anyone with the link", hint: "Anyone with the link can view" },
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Styled with Tailwind utilities (src/tokens/tailwind.css). hb-share-popover and hb-share-close carry no style: the
// story frame and the focus-on-open below find them by those names. The popover hangs from its trigger's wrapper, which
// must be positioned: give it `shareAnchor`.

/** The wrapper round the Share button and its popover: the box the popover hangs from. */
export const shareAnchor = "hb-share-anchor relative";
/** Close and Remove: a 28px icon button. */
const iconButton =
	"hb-focusable inline-flex size-control-sm cursor-pointer items-center justify-center rounded-control border-0 bg-transparent p-0 text-muted hover:bg-hover hover:text-fg";
/** Each tab's content. */
const body = "m-0 flex list-none flex-col px-5 pt-4 pb-5";
/** A 36px mark at the start of a row: initials, the general access, an export's file type. */
const mark = "inline-flex size-control-lg flex-none items-center justify-center text-sm font-medium";
const who = "flex min-w-0 flex-1 flex-col gap-0.5";
const name = "truncate leading-tight";
const secondary = "truncate text-sm leading-tight text-muted";
const heading = "m-0 text-sm font-regular text-muted";
const section = "flex flex-col gap-2.5";

function GeneralAccess({ access, onChange }: { access: ShareAccess; onChange: (access: ShareAccess) => void }) {
	const id = useId();
	const Icon = access === "link" ? Globe : Lock;
	return (
		<div className="flex items-center gap-3">
			<span className={`${mark} rounded-full bg-active text-muted`} aria-hidden="true">
				<Icon className="hb-icon hb-icon-md" strokeWidth={1.75} />
			</span>
			<label className="hb-sr-only" htmlFor={id}>
				General access
			</label>
			<span className="relative inline-flex items-center">
				<select
					id={id}
					className="hb-focusable h-control-md cursor-pointer appearance-none rounded-control border-0 bg-transparent py-0 pr-6 pl-2 text-fg [font:inherit] hover:bg-hover"
					value={access}
					onChange={(event) => onChange(event.target.value as ShareAccess)}
				>
					<option className="bg-raised text-fg" value="restricted">
						{ACCESS.restricted.label}
					</option>
					<option className="bg-raised text-fg" value="link">
						{ACCESS.link.label}
					</option>
				</select>
				<ChevronDown
					className="hb-icon hb-icon-sm pointer-events-none absolute right-2 text-muted"
					aria-hidden="true"
				/>
			</span>
		</div>
	);
}

function CopyLink({ access, onCopyLink }: { access: ShareAccess; onCopyLink: () => Promise<string> }) {
	const [state, setState] = useState<"idle" | "busy" | "copied" | "failed">("idle");
	const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = useCallback(async () => {
		setState("busy");
		try {
			const link = await onCopyLink();
			await navigator.clipboard.writeText(link);
			setState("copied");
		} catch {
			setState("failed");
		}
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setState("idle"), 1500);
	}, [onCopyLink]);
	const Icon = state === "copied" ? Check : access === "link" ? Link : Lock;
	const words =
		state === "copied"
			? "Copied"
			: state === "failed"
				? "Couldn't copy"
				: access === "link"
					? "Copy link"
					: "Copy private link";
	return (
		<Button
			variant="secondary"
			busy={state === "busy"}
			icon={<Icon className="hb-icon hb-icon-sm" strokeWidth={1.75} aria-hidden="true" />}
			onClick={() => void copy()}
		>
			<span aria-live="polite">{words}</span>
		</Button>
	);
}

function ShareTab({
	share,
	onAccessChange,
	onInvite,
	onRemoveInvite,
	onCopyLink,
}: Pick<ShareControls, "onAccessChange" | "onInvite" | "onRemoveInvite" | "onCopyLink"> & {
	share: ShareState;
}) {
	const [email, setEmail] = useState("");
	const [invalid, setInvalid] = useState(false);
	const [inviting, setInviting] = useState(false);
	const inviteId = useId();
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const address = email.trim();
		if (!EMAIL.test(address)) {
			setInvalid(true);
			return;
		}
		setInviting(true);
		try {
			await onInvite(address);
			setEmail("");
		} finally {
			setInviting(false);
		}
	};
	return (
		<>
			<div className={`${body} gap-4`}>
				<form className="flex gap-2" onSubmit={(event) => void submit(event)}>
					<label className="hb-sr-only" htmlFor={inviteId}>
						Invite people by email
					</label>
					<input
						id={inviteId}
						// `!`: .hb-input (primitives/controls.css) is unlayered, so it beats a plain utility. Drop it once controls.css
						// is converted.
						className="hb-input hb-focusable min-w-0 flex-1 h-control-lg! bg-canvas!"
						type="email"
						placeholder="Invite people by email"
						autoComplete="off"
						value={email}
						aria-invalid={invalid || undefined}
						onChange={(event) => {
							setEmail(event.target.value);
							setInvalid(false);
						}}
					/>
					{email.trim() === "" ? null : (
						<Button type="submit" variant="primary" busy={inviting}>
							Invite
						</Button>
					)}
				</form>
				<section className={section} aria-label="People with access">
					<h3 className={heading}>People with access</h3>
					<ul className="m-0 flex list-none flex-col gap-2.5 p-0">
						<li className="flex min-w-0 items-center gap-3">
							<span className={`${mark} rounded-full bg-status-done-soft text-status-done`} aria-hidden="true">
								{initials(share.owner.name)}
							</span>
							<span className={who}>
								<span className={name}>
									{share.owner.name} <span className="text-muted">(you)</span>
								</span>
								{share.owner.email === undefined ? null : <span className={secondary}>{share.owner.email}</span>}
							</span>
							<span className="flex-none text-sm text-muted">Owner</span>
						</li>
						{share.invites.map((invite) => (
							<li key={invite.email} className="flex min-w-0 items-center gap-3">
								<span className={`${mark} rounded-full bg-accent-soft text-accent-text`} aria-hidden="true">
									{initials(invite.email)}
								</span>
								<span className={who}>
									<span className={name}>{invite.email}</span>
									<span className={secondary}>Invited</span>
								</span>
								<span className="flex-none text-sm text-muted">Can view</span>
								{onRemoveInvite === undefined ? null : (
									<button
										type="button"
										className={iconButton}
										aria-label={`Remove ${invite.email}`}
										title={`Remove ${invite.email}`}
										onClick={() => void onRemoveInvite(invite.email)}
									>
										<X className="hb-icon hb-icon-sm" aria-hidden="true" />
									</button>
								)}
							</li>
						))}
					</ul>
				</section>
				<section className={section} aria-label="General access">
					<h3 className={heading}>General access</h3>
					<GeneralAccess access={share.access} onChange={(access) => void onAccessChange(access)} />
				</section>
			</div>
			<footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
				<span className="min-w-0 text-sm text-muted">{ACCESS[share.access].hint}</span>
				<CopyLink access={share.access} onCopyLink={onCopyLink} />
			</footer>
		</>
	);
}

function ExportTab({ exports }: { exports: readonly ShareExport[] }) {
	return (
		<ul className={`${body} gap-1.5`}>
			{exports.map((option) => (
				<li key={option.id}>
					<button
						type="button"
						className="hb-focusable flex w-full cursor-pointer items-center gap-3 rounded-panel border-0 bg-transparent p-2 text-left text-fg [font:inherit] hover:bg-hover"
						onClick={option.run}
					>
						<span className={`${mark} rounded-control bg-active text-muted`} aria-hidden="true">
							{option.id === "pdf" ? (
								<FileDown className="hb-icon hb-icon-md" strokeWidth={1.75} />
							) : (
								<FileText className="hb-icon hb-icon-md" strokeWidth={1.75} />
							)}
						</span>
						<span className={who}>
							<span className={name}>{option.label}</span>
							<span className={secondary}>{option.hint}</span>
						</span>
					</button>
				</li>
			))}
		</ul>
	);
}

/** The Share popover: Share and Export tabs. Escape or a click outside closes it. */
export function SharePopover({ title, sharing, exports, onClose, initialTab = "share" }: SharePopoverProps) {
	const [chosen, setTab] = useState<"share" | "export">(initialTab);
	const tab = sharing === undefined ? "export" : chosen;
	const ref = useRef<HTMLDivElement>(null);
	const titleId = useId();
	// It hangs from its trigger's right edge, so on a narrow screen its width is what's left of that edge (the CSS takes
	// a gutter off), not the whole viewport, or it runs off the left. Focus goes to its first control as it opens.
	useLayoutEffect(() => {
		const popover = ref.current;
		const anchor = popover?.offsetParent;
		if (popover === null || popover === undefined || !(anchor instanceof HTMLElement)) return;
		const measure = () =>
			popover.style.setProperty("--hb-share-room", `${Math.round(anchor.getBoundingClientRect().right)}px`);
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, []);
	// As it closes, focus goes back to what opened it, unless the person has moved it elsewhere (clicked outside).
	useEffect(() => {
		const popover = ref.current;
		const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		popover?.querySelector<HTMLElement>(".hb-share-close")?.focus();
		return () => {
			const active = document.activeElement;
			const lost = active === null || active === document.body || (popover?.contains(active) ?? false);
			if (lost && opener?.isConnected === true) opener.focus();
		};
	}, []);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			onClose();
		};
		const onPointer = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (target !== null && ref.current?.contains(target)) return;
			// The trigger toggles the popover itself.
			if (target instanceof Element && target.closest("[data-share-trigger]") !== null) return;
			onClose();
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onPointer);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onPointer);
		};
	}, [onClose]);
	return (
		<div
			ref={ref}
			// --hb-share-room: the trigger's right edge from the viewport's left, measured as it opens, less a gutter.
			className="hb-share-popover absolute top-[calc(100%+var(--hb-space-3))] right-0 z-(--hb-z-overlay) flex w-[min(var(--hb-share-width),calc(var(--hb-share-room,100vw)_-_var(--hb-space-6)))] flex-col rounded-bubble bg-raised text-left text-md text-fg shadow-float"
			role="dialog"
			aria-labelledby={titleId}
		>
			<header className="flex items-center gap-2 px-5 pt-5 pb-3">
				<h2 id={titleId} className="m-0 min-w-0 flex-1 truncate text-lg leading-tight font-medium">
					{title}
				</h2>
				<button type="button" className={`hb-share-close ${iconButton}`} aria-label="Close" onClick={onClose}>
					<X className="hb-icon hb-icon-md" aria-hidden="true" />
				</button>
			</header>
			{sharing === undefined ? null : (
				<div className="flex px-5 [&_.hb-segment]:flex-1 [&_.hb-segment]:justify-center [&>.hb-segmented]:flex-1">
					<SegmentedControl
						label="Share or export"
						options={[
							{ value: "share", label: "Share" },
							{ value: "export", label: "Export" },
						]}
						value={tab}
						onChange={setTab}
					/>
				</div>
			)}
			{sharing?.error === undefined ? null : (
				<p className="mx-5 mt-2.5 mb-0 text-sm text-status-error" role="alert">
					{sharing.error}
				</p>
			)}
			{tab === "export" || sharing === undefined ? (
				<ExportTab exports={exports} />
			) : sharing.share === undefined ? (
				<div className={`${body} min-h-thumb gap-4`} aria-busy="true">
					<span className="hb-sr-only">Loading who has access</span>
				</div>
			) : (
				<ShareTab
					share={sharing.share}
					onAccessChange={sharing.onAccessChange}
					onInvite={sharing.onInvite}
					onRemoveInvite={sharing.onRemoveInvite}
					onCopyLink={sharing.onCopyLink}
				/>
			)}
		</div>
	);
}

/** The Share button that opens the popover beside it. */
export function ShareButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
	return (
		<Button
			variant="ghost"
			data-share-trigger=""
			aria-haspopup="dialog"
			aria-expanded={open}
			icon={<Share className="hb-icon hb-icon-sm" strokeWidth={1.75} aria-hidden="true" />}
			onClick={onToggle}
		>
			Share
		</Button>
	);
}
