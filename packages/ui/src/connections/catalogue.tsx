// The catalogue (#325, #339): every service the viewer can connect, as a searchable grid of cards with logos and
// categories, and the two ways to connect something it doesn't list: a remote MCP server by URL (#338), or any API
// with a key (#330). A card says how the service connects: sign in, an API key, or an OAuth client still to set up.

import { type ReactNode, useId, useMemo, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { KeyRoundIcon, LucideSearchIcon, PlugIcon, ServerIcon } from "../primitives/lucide.tsx";
import { Skeleton } from "../primitives/spinner.tsx";
import { EmptyState, Notice } from "../primitives/surface.tsx";
import {
	type Connection,
	categoryCounts,
	connectionsFor,
	connectRoute,
	type ProviderTemplate,
	routeText,
	searchCatalogue,
} from "./connections-model.ts";
import { ProviderLogo } from "./provider-logo.tsx";

/** The grid: one column on a phone, two from 640px, three from 1280px. */
const grid = "m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 xl:grid-cols-3";
/** A card: the whole card is the button. */
const card =
	"hb-focusable group box-border flex h-full w-full min-w-0 cursor-pointer flex-col gap-3 rounded-panel border border-border bg-panel p-4 text-left text-fg transition-colors hover:border-border-strong hover:bg-raised";

export interface CatalogueProps {
	readonly templates: readonly ProviderTemplate[];
	/** The viewer's connections, to mark the services already connected. */
	readonly connections?: readonly Connection[];
	readonly loading?: boolean;
	readonly error?: string | undefined;
	readonly onRetry?: () => void;
	readonly onOpen: (template: ProviderTemplate) => void;
	readonly onAddMcpServer: () => void;
	readonly onAddKey: (name?: string) => void;
	/** A search to start with, for stories and a link from elsewhere. */
	readonly initialQuery?: string;
	readonly initialCategory?: string;
}

export function Catalogue({
	templates,
	connections = [],
	loading = false,
	error,
	onRetry,
	onOpen,
	onAddMcpServer,
	onAddKey,
	initialQuery = "",
	initialCategory,
}: CatalogueProps) {
	const [query, setQuery] = useState(initialQuery);
	const [category, setCategory] = useState<string | undefined>(initialCategory);
	const searchId = useId();
	const shown = useMemo(() => searchCatalogue(templates, query, category), [templates, query, category]);
	const categories = useMemo(() => categoryCounts(templates), [templates]);
	const searching = query.trim() !== "";

	return (
		<div className="flex min-w-0 flex-col gap-4">
			<div className="flex min-w-0 flex-col gap-3">
				<div className="relative min-w-0">
					<label htmlFor={searchId} className="hb-sr-only">
						Search services
					</label>
					<span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-faint">
						<LucideSearchIcon />
					</span>
					{/* `!`: the input's own padding (primitives/controls.css) is unlayered and would beat a utility. */}
					<input
						id={searchId}
						type="search"
						className="hb-input hb-focusable h-control-lg! pl-9!"
						placeholder="Search GitHub, Slack, Google Drive and more"
						value={query}
						autoComplete="off"
						spellCheck={false}
						onChange={(event) => setQuery(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Escape" && query !== "") {
								event.preventDefault();
								setQuery("");
							}
						}}
					/>
				</div>
				{categories.length > 1 ? (
					<fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
						<legend className="hb-sr-only">Category</legend>
						<CategoryChip
							label="All"
							count={templates.length}
							on={category === undefined}
							onClick={() => setCategory(undefined)}
						/>
						{categories.map((entry) => (
							<CategoryChip
								key={entry.category}
								label={entry.category}
								count={entry.count}
								on={category === entry.category}
								onClick={() => setCategory(category === entry.category ? undefined : entry.category)}
							/>
						))}
					</fieldset>
				) : null}
			</div>

			{error !== undefined ? (
				<Notice level="error" action={onRetry === undefined ? undefined : <Button onClick={onRetry}>Try again</Button>}>
					{error}
				</Notice>
			) : loading ? (
				<ul className={grid} aria-busy="true" aria-label="Loading services">
					{Array.from({ length: 6 }, (_, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: identical placeholder cards.
						<li key={index} className="flex flex-col gap-3 rounded-panel border border-border bg-panel p-4">
							<span className="block size-10 rounded-control bg-sunken" />
							<Skeleton lines={2} />
						</li>
					))}
				</ul>
			) : shown.length === 0 ? (
				<EmptyState
					title={searching ? `Nothing in the catalogue matches "${query.trim()}"` : "Nothing in this category yet"}
					action={
						<div className="flex flex-wrap justify-center gap-2">
							<Button icon={<ServerIcon size="sm" />} onClick={onAddMcpServer}>
								Add an MCP server
							</Button>
							<Button icon={<KeyRoundIcon size="sm" />} onClick={() => onAddKey(searching ? query.trim() : undefined)}>
								Connect with an API key
							</Button>
						</div>
					}
				>
					If it has a remote MCP server or an API, you can still connect it.
				</EmptyState>
			) : (
				<>
					<p className="hb-sr-only" role="status">
						{searching ? `${shown.length} services match` : `${shown.length} services`}
					</p>
					<ul className={grid}>
						{shown.map((template) => (
							<li key={template.id} className="min-w-0">
								<ServiceCard
									template={template}
									connected={connectionsFor(connections, template.id).length}
									onOpen={() => onOpen(template)}
								/>
							</li>
						))}
					</ul>
				</>
			)}

			{loading || error !== undefined ? null : (
				<section className="mt-4 flex min-w-0 flex-col gap-3" aria-labelledby={`${searchId}-custom`}>
					<div className="flex flex-col gap-0.5">
						<h2 id={`${searchId}-custom`} className="m-0 text-sm font-strong text-fg">
							Not in the catalogue
						</h2>
						<p className="m-0 text-xs text-muted">Connect a service Harbour doesn't list yet.</p>
					</div>
					<ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2">
						<li className="min-w-0">
							<CustomCard
								icon={<ServerIcon />}
								title="Custom MCP server"
								detail="Paste a remote MCP server's URL. Harbour signs in to it and holds the token."
								onClick={onAddMcpServer}
							/>
						</li>
						<li className="min-w-0">
							<CustomCard
								icon={<KeyRoundIcon />}
								title="Any API with a key"
								detail="Name the hosts and how the key is sent. You enter the key once; nobody sees it again."
								onClick={() => onAddKey()}
							/>
						</li>
					</ul>
				</section>
			)}
		</div>
	);
}

function CategoryChip({
	label,
	count,
	on,
	onClick,
}: {
	label: string;
	count: number;
	on: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={on}
			onClick={onClick}
			className={`hb-focusable inline-flex h-control-sm cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs transition-colors ${on ? "border-border-strong bg-selected text-fg" : "border-border bg-transparent text-muted hover:bg-hover hover:text-fg"}`}
		>
			{label}
			<span className={on ? "text-muted" : "text-faint"}>{count}</span>
		</button>
	);
}

/** One service: its logo and name, what it is, how it connects, and how many of the viewer's connections use it. */
export function ServiceCard({
	template,
	connected = 0,
	onOpen,
}: {
	template: ProviderTemplate;
	connected?: number;
	onOpen: () => void;
}) {
	const route = connectRoute(template);
	return (
		<button type="button" className={card} onClick={onOpen}>
			<span className="flex min-w-0 items-start justify-between gap-3">
				<ProviderLogo name={template.name} icon={template.icon} />
				{connected > 0 ? (
					<span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted">
						<span className="size-dot rounded-full bg-status-done" aria-hidden="true" />
						{connected === 1 ? "Connected" : `${connected} connected`}
					</span>
				) : null}
			</span>
			<span className="flex min-w-0 flex-col gap-1">
				<span className="text-md font-medium wrap-anywhere">{template.name}</span>
				<span className="line-clamp-2 text-xs leading-normal text-muted">{template.summary}</span>
			</span>
			<span className="mt-auto flex min-w-0 items-center justify-between gap-2 text-xs">
				<span className={`inline-flex items-center gap-1.5 ${route === "needs_client" ? "text-faint" : "text-muted"}`}>
					{route === "key" ? <KeyRoundIcon size="sm" /> : route === "needs_client" ? null : <PlugIcon size="sm" />}
					{routeText(template)}
				</span>
				<span className="truncate text-faint">{template.category}</span>
			</span>
		</button>
	);
}

function CustomCard({
	icon,
	title,
	detail,
	onClick,
}: {
	icon: ReactNode;
	title: string;
	detail: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className="hb-focusable box-border flex h-full w-full min-w-0 cursor-pointer items-start gap-3 rounded-panel border border-dashed border-border-strong bg-transparent p-4 text-left text-fg transition-colors hover:bg-hover"
		>
			<span className="box-border flex size-10 shrink-0 items-center justify-center rounded-control border border-border bg-sunken text-muted">
				{icon}
			</span>
			<span className="flex min-w-0 flex-col gap-1">
				<span className="font-medium">{title}</span>
				<span className="text-xs leading-normal text-muted">{detail}</span>
			</span>
		</button>
	);
}
