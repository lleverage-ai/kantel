import { Check, ChevronDown, FileDown, FileText, Globe, Link, Lock, Share, X } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { initials } from "../identity/signed-in-as.tsx";
import { Button } from "../primitives/button.tsx";
import { SegmentedControl } from "../primitives/controls.tsx";
import "./share-popover.css";

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

function GeneralAccess({ access, onChange }: { access: ShareAccess; onChange: (access: ShareAccess) => void }) {
	const id = useId();
	const Icon = access === "link" ? Globe : Lock;
	return (
		<div className="hb-share-access">
			<span className="hb-share-access-icon" aria-hidden="true">
				<Icon className="hb-icon hb-icon-md" strokeWidth={1.75} />
			</span>
			<label className="hb-sr-only" htmlFor={id}>
				General access
			</label>
			<span className="hb-share-access-select">
				<select
					id={id}
					className="hb-share-access-native hb-focusable"
					value={access}
					onChange={(event) => onChange(event.target.value as ShareAccess)}
				>
					<option value="restricted">{ACCESS.restricted.label}</option>
					<option value="link">{ACCESS.link.label}</option>
				</select>
				<ChevronDown className="hb-icon hb-icon-sm hb-share-access-chevron" aria-hidden="true" />
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
			<div className="hb-share-body">
				<form className="hb-share-invite" onSubmit={(event) => void submit(event)}>
					<label className="hb-sr-only" htmlFor={inviteId}>
						Invite people by email
					</label>
					<input
						id={inviteId}
						className="hb-input hb-focusable hb-share-invite-input"
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
				<section className="hb-share-section" aria-label="People with access">
					<h3 className="hb-share-heading">People with access</h3>
					<ul className="hb-share-people">
						<li className="hb-share-person">
							<span className="hb-share-avatar" aria-hidden="true">
								{initials(share.owner.name)}
							</span>
							<span className="hb-share-who">
								<span className="hb-share-name">
									{share.owner.name} <span className="hb-share-you">(you)</span>
								</span>
								{share.owner.email === undefined ? null : <span className="hb-share-email">{share.owner.email}</span>}
							</span>
							<span className="hb-share-role">Owner</span>
						</li>
						{share.invites.map((invite) => (
							<li key={invite.email} className="hb-share-person">
								<span className="hb-share-avatar hb-share-avatar-invited" aria-hidden="true">
									{initials(invite.email)}
								</span>
								<span className="hb-share-who">
									<span className="hb-share-name">{invite.email}</span>
									<span className="hb-share-email">Invited</span>
								</span>
								<span className="hb-share-role">Can view</span>
								{onRemoveInvite === undefined ? null : (
									<button
										type="button"
										className="hb-share-remove hb-focusable"
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
				<section className="hb-share-section" aria-label="General access">
					<h3 className="hb-share-heading">General access</h3>
					<GeneralAccess access={share.access} onChange={(access) => void onAccessChange(access)} />
				</section>
			</div>
			<footer className="hb-share-footer">
				<span className="hb-share-hint">{ACCESS[share.access].hint}</span>
				<CopyLink access={share.access} onCopyLink={onCopyLink} />
			</footer>
		</>
	);
}

function ExportTab({ exports }: { exports: readonly ShareExport[] }) {
	return (
		<ul className="hb-share-body hb-share-exports">
			{exports.map((option) => (
				<li key={option.id}>
					<button type="button" className="hb-share-export hb-focusable" onClick={option.run}>
						<span className="hb-share-export-icon" aria-hidden="true">
							{option.id === "pdf" ? (
								<FileDown className="hb-icon hb-icon-md" strokeWidth={1.75} />
							) : (
								<FileText className="hb-icon hb-icon-md" strokeWidth={1.75} />
							)}
						</span>
						<span className="hb-share-who">
							<span className="hb-share-name">{option.label}</span>
							<span className="hb-share-email">{option.hint}</span>
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
	useEffect(() => {
		ref.current?.querySelector<HTMLElement>(".hb-share-close")?.focus();
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
		<div ref={ref} className="hb-share-popover" role="dialog" aria-labelledby={titleId}>
			<header className="hb-share-header">
				<h2 id={titleId} className="hb-share-title">
					{title}
				</h2>
				<button type="button" className="hb-share-close hb-focusable" aria-label="Close" onClick={onClose}>
					<X className="hb-icon hb-icon-md" aria-hidden="true" />
				</button>
			</header>
			{sharing === undefined ? null : (
				<div className="hb-share-tabs">
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
				<p className="hb-share-error" role="alert">
					{sharing.error}
				</p>
			)}
			{tab === "export" || sharing === undefined ? (
				<ExportTab exports={exports} />
			) : sharing.share === undefined ? (
				<div className="hb-share-body hb-share-loading" aria-busy="true">
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
