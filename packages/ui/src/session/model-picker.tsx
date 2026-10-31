import {
	type CSSProperties,
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	BranchIcon,
	CheckIcon,
	ChevronDownIcon,
	FolderIcon,
	ImageIcon,
	RepoIcon,
	SearchIcon,
} from "../primitives/icons.tsx";
import { popoverRoom, popoverSide, usePopoverPlacement } from "../primitives/popover-placement.ts";
import { orderModels, providerKey, providerOrder } from "./model-order.ts";
import { ProviderIcon } from "./provider-icon.tsx";
import type { ThinkingLevel } from "./thinking-model.ts";

// The composer's model picker, after T3 Code's ProviderModelPicker: a quiet toolbar button, a list that opens upward,
// or downward when there's more room below (a new session's composer, in the middle of the window).
//
// Styled with Tailwind utilities (src/tokens/tailwind.css). The hb-model- classes carry no style of their own: they
// are hooks for composer.tsx (which sizes .hb-model-picker in the toolbar), loop/align.ts, the stories and tests.
// The provider's initial (provider-icon.tsx's .hb-provider-initial) is styled from here, through `initialTile`.

/**
 * Trimmed to its capitals, as a Button's label is (docs/components.md), so centring it centres the letters, not a line
 * box whose space below them is deeper than above. The even padding gives descenders room inside the clip.
 */
const trimmed = "py-(--hb-trim-room) [text-box:trim-both_cap_alphabetic]";
/** The quiet toolbar button: muted, lit on hover and while open, faded when disabled. */
const triggerClass =
	"hb-model-trigger hb-focusable inline-flex min-w-0 max-w-full cursor-pointer items-center border border-transparent bg-transparent py-0 [font-family:inherit] [font-feature-settings:inherit] font-medium leading-none whitespace-nowrap text-muted transition-[background-color,color] duration-(--hb-duration-fast) ease-standard enabled:hover:bg-hover enabled:hover:text-fg aria-expanded:bg-hover aria-expanded:text-fg disabled:cursor-default disabled:opacity-50";
/** The button's size: `sm` in the composer's toolbar, `xs` in its resting strip. */
const triggerSize = {
	sm: "h-control-sm gap-1.5 rounded-control px-2 text-md",
	xs: "h-control-xs gap-1 rounded-sm px-1.5 text-xs",
} as const;
/**
 * The popover, a raised panel above the button (or below it: `popoverSide`), never taller than the room on that side
 * (`popoverRoom`): the list shrinks and scrolls, the search field and the rail's marks stay.
 */
const popoverClass = `hb-model-popover absolute left-0 z-(--hb-z-overlay) flex cursor-default overflow-hidden rounded-panel bg-raised text-md text-fg shadow-float ${popoverRoom}`;
/** Without the rail: one column, the popover's width (less a margin on a narrow window). */
const popoverPlain = "flex-col w-[min(var(--hb-popover-width),calc(100vw_-_var(--hb-step-8)))]";
/**
 * Provider first, after T3 Code's ModelPickerSidebar: the providers' marks down the popover's left side, the chosen
 * provider's models beside them. The popover is the plain one's width plus the rail.
 */
const popoverRail =
	"hb-model-popover-rail flex-row w-[min(calc(var(--hb-popover-width)+var(--hb-control-lg)+var(--hb-step-2)),calc(100vw_-_var(--hb-step-8)))]";
/**
 * The search row; the magnifier sits on the field's baseline, then moves up onto the middle of its capitals. The
 * field's focus shows on the row: a quiet inset edge, as the composer's field does on its surface.
 */
const searchRow =
	"hb-model-search flex flex-none items-baseline gap-1.5 border-b border-border px-3 py-2 text-faint has-[.hb-model-search-input:focus-visible]:outline has-[.hb-model-search-input:focus-visible]:-outline-offset-1 has-[.hb-model-search-input:focus-visible]:outline-focus";
/** The search field, bare: its row draws the focus. */
const searchInput =
	"hb-model-search-input m-0 h-control-xs min-w-0 flex-1 border-0 bg-transparent p-0 [font-family:inherit] [font-feature-settings:inherit] [line-height:inherit] text-md text-fg outline-none placeholder:text-faint";
/**
 * The list. With the rail it keeps one height (the longest provider's list, up to --hb-popover-height) so the rail
 * doesn't move under the pointer as the provider changes. Either way it gives up height when the popover is capped.
 */
const listClass = "hb-model-list min-h-0 overflow-y-auto overscroll-contain p-1 [scrollbar-width:thin]";
const listPlain = "max-h-(--hb-popover-height)";
const listRail =
	"h-[min(var(--hb-popover-height),calc(var(--hb-model-rows)*var(--hb-control-md)+var(--hb-step-8)+var(--hb-step-2)))] max-h-none flex-[0_1_auto]";
/** The providers' marks, a column down the popover's side. */
const railClass =
	"hb-model-rail flex flex-none flex-col gap-1 overflow-y-auto border-r border-border p-1 [scrollbar-width:none]";
/**
 * A provider's button on the rail: lit on hover, selected when it is the provider shown, with a short accent bar on
 * the rail's inner edge (T3 Code's selection indicator). While searching, a provider without a match fades; clicking
 * it still shows its models.
 */
const railButton =
	"hb-model-rail-button relative grid size-control-lg flex-none cursor-pointer place-items-center rounded-sm border-0 bg-transparent p-0 text-muted transition-[background-color,color,opacity] duration-(--hb-duration-fast) ease-standard hover:bg-hover hover:text-fg aria-pressed:bg-selected aria-pressed:text-fg data-unmatched:opacity-40 aria-pressed:after:absolute aria-pressed:after:top-1/2 aria-pressed:after:-right-1 aria-pressed:after:h-icon-md aria-pressed:after:w-0.5 aria-pressed:after:-translate-y-1/2 aria-pressed:after:rounded-full aria-pressed:after:bg-accent-text";
/**
 * A provider without a mark (ProviderIcon's `fallback="initial"`): its initial, in a mark-sized tile. Only on the
 * initial's span, so a provider's svg mark is left alone.
 */
const initialTile =
	"[&.hb-provider-initial]:inline-grid [&.hb-provider-initial]:place-items-center [&.hb-provider-initial]:rounded-xs [&.hb-provider-initial]:bg-selected [&.hb-provider-initial]:text-xs [&.hb-provider-initial]:font-strong [&.hb-provider-initial]:leading-none";
/** The rail's mark, a step over the icon size. `!` beats icons.css's .hb-icon-md width and height (unlayered). */
const railMark = `hb-model-rail-mark size-[calc(var(--hb-icon-md)+--spacing(0.5))]! ${initialTile}`;
/** A provider's heading in the list. */
const groupLabel = "hb-model-group-label flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-xs font-medium text-faint";
/**
 * A row is a grid: the name's line (name, Default, the image icon and the tick) on top, the description under it. The
 * name is trimmed to its capitals, so centring the first line's parts centres them on the letters, and a one-line row
 * centres the letters in the row.
 */
const optionClass =
	"hb-model-option grid min-h-control-md cursor-pointer grid-cols-[minmax(0,1fr)_auto_auto] content-center items-center gap-x-2 gap-y-0.5 rounded-sm px-2 py-1.5 text-fg data-active:bg-hover aria-disabled:cursor-default";
/** The description (or the reason it can't be chosen), under the name across the row. */
const optionDetail = "hb-model-option-detail col-span-full row-2 min-w-0 truncate text-xs leading-tight text-faint";
/** The tick's slot, kept on rows without one so the names line up. */
const optionCheck = "hb-model-option-check col-3 row-1 grid w-icon-sm place-items-center text-accent-text";

/**
 * One model a session may run with, as the host's model catalogue lists it. The organisation's or project's
 * configuration decides the list; the composer only shows it and reports the choice.
 */
export type ComposerModelOption = {
	/** What `onModelChange` reports: the host's id for the route, such as `anthropic/claude-sonnet-4-5`. */
	id: string;
	/** What the person reads: "Claude Sonnet 4.5". */
	label: string;
	/** Groups the list, and shows under the label when there is no description: "Anthropic". */
	provider?: string;
	/** One short line under the label: "Fast, for small edits". */
	description?: string;
	/** What the model can take. Leave a field out when it's unknown; the composer only acts on `false`. */
	capabilities?: {
		/** Reads images. With `false`, an image in the draft blocks sending, with the reason. */
		images?: boolean;
		/**
		 * The thinking levels it supports, such as `["off", "low", "medium", "high"]`. The composer's thinking picker
		 * offers them, and hides for a model without any but `off`.
		 */
		thinking?: readonly ThinkingLevel[];
	};
	/** The catalogue's default, chosen when the host passes no `model`. */
	default?: boolean;
	/** Set when the model can't be chosen now; the list shows it, dimmed, with this reason. */
	disabledReason?: string;
};

/** The model the picker shows as chosen: `value`, else the catalogue's default, else the first. */
export function selectedModel(
	models: readonly ComposerModelOption[],
	value: string | undefined,
): ComposerModelOption | undefined {
	return (
		models.find((model) => model.id === value) ??
		models.find((model) => model.default === true) ??
		models.find((model) => model.disabledReason === undefined) ??
		models[0]
	);
}

/** The models whose label, provider or description has every word of the query, in the catalogue's order. */
export function filterModels(models: readonly ComposerModelOption[], query: string): ComposerModelOption[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return [...models];
	return models.filter((model) => {
		const haystack = `${model.label} ${model.provider ?? ""} ${model.description ?? ""} ${model.id}`.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}

type Group = { provider: string; models: ComposerModelOption[] };

function groupByProvider(models: readonly ComposerModelOption[]): Group[] {
	const groups: Group[] = [];
	for (const model of models) {
		const provider = providerKey(model);
		const group = groups.find((entry) => entry.provider === provider);
		if (group) group.models.push(model);
		else groups.push({ provider, models: [model] });
	}
	return groups;
}

export type ModelPickerProps = {
	models: readonly ComposerModelOption[];
	/** The chosen model's id. Without it, the catalogue's default shows as chosen. */
	value?: string;
	onChange: (id: string) => void;
	disabled?: boolean;
	/** `sm` in the composer's toolbar; `xs` in its resting strip. */
	size?: "xs" | "sm";
	/** Told when the list opens and closes, so the composer stays expanded while it's open. */
	onOpenChange?: (open: boolean) => void;
	/** Where focus goes after a choice or Escape: the composer's field. */
	returnFocus?: () => void;
	/** Open on mount, for a story or a test. */
	defaultOpen?: boolean;
	/**
	 * Ends the button with a chevron. Default true; the composer leaves it out so the thinking level reads on from the
	 * model's name ("Sonnet 5.5 High"), as T3 Code's does.
	 */
	chevron?: boolean;
};

/** The words and icon of one kind of picker: the composer's models, or a new session's projects. */
type PickerWords = {
	/** The trigger's icon, given the chosen option (a model's provider mark, say). */
	readonly icon: (size: "sm" | "md", chosen?: ComposerModelOption) => ReactNode;
	/** "Model", as the trigger's accessible name starts. */
	readonly noun: string;
	/** "Models", the list's name. */
	readonly plural: string;
	readonly choose: string;
	readonly search: string;
	readonly none: (query: string) => string;
};

const MODEL_WORDS: PickerWords = {
	// The chosen model's provider mark, as T3 Code's trigger shows the provider's icon; the spark for any other.
	icon: (size, chosen) => <ProviderIcon provider={chosen?.provider} size={size} className="hb-model-trigger-icon" />,
	noun: "Model",
	plural: "Models",
	choose: "Choose a model",
	search: "Search models",
	none: (query) => `No model matches "${query}".`,
};

const PROJECT_WORDS: PickerWords = {
	icon: (size) => <FolderIcon size={size} className="hb-model-trigger-icon" />,
	noun: "Project",
	plural: "Projects",
	choose: "Choose a project",
	search: "Search projects",
	none: (query) => `No project matches "${query}".`,
};

const REPO_WORDS: PickerWords = {
	icon: (size) => <RepoIcon size={size} className="hb-model-trigger-icon" />,
	noun: "Repository",
	plural: "Repositories",
	choose: "Choose a repository",
	search: "owner/name or a GitHub link",
	none: (query) => `"${query}" isn't a repository. Type it as owner/name.`,
};

const BRANCH_WORDS: PickerWords = {
	icon: (size) => <BranchIcon size={size} className="hb-model-trigger-icon" />,
	noun: "Branch",
	plural: "Branches",
	choose: "Choose a branch",
	search: "Search branches",
	none: (query) => `No branch matches "${query}".`,
};

/** The option that means a new session starts with an empty workspace. Its id is `""`. */
export const NO_REPOSITORY: ComposerModelOption = { id: "", label: "No repository" };

/**
 * `owner/name` from what a person typed: `owner/name`, `owner/name.git` or a github.com link. Undefined for anything
 * else.
 */
export function repositoryFrom(text: string): string | undefined {
	const trimmed = text.trim().replace(/\/+$/, "");
	const match =
		/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(trimmed) ??
		/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/.exec(trimmed);
	if (match === null) return undefined;
	const [, owner, name] = match;
	if (owner === undefined || name === undefined || /^\.+$/.test(owner) || /^\.+$/.test(name)) return undefined;
	return `${owner}/${name}`;
}

export type RepoPickerProps = Omit<ModelPickerProps, "models" | "value" | "onChange"> & {
	/** The chosen repository as `owner/name`, or `""` (the default) for none. */
	value?: string;
	onChange: (repo: string) => void;
	/** Repositories to offer before anything is typed, such as the ones this person used last. */
	recent?: readonly string[];
};

/**
 * Which repository a new session's workspace starts from: the model picker's button and list, with a repository icon.
 * The list offers "No repository" and the `recent` ones; typing `owner/name` or pasting a GitHub link offers that one.
 * For the composer's `footer` on a new-session page, beside the project, with `BranchPicker` after it once one is
 * chosen.
 */
export function RepoPicker({ value = "", onChange, recent = [], ...rest }: RepoPickerProps) {
	const options = useMemo<ComposerModelOption[]>(() => {
		const seen = new Set<string>();
		const listed: ComposerModelOption[] = [NO_REPOSITORY];
		for (const repo of value === "" ? recent : [value, ...recent]) {
			if (seen.has(repo)) continue;
			seen.add(repo);
			listed.push({ id: repo, label: repo });
		}
		return listed;
	}, [value, recent]);
	const custom = useCallback((query: string): ComposerModelOption | undefined => {
		const repo = repositoryFrom(query);
		return repo === undefined ? undefined : { id: repo, label: repo, description: "Start from this repository" };
	}, []);
	return <Picker {...rest} models={options} value={value} onChange={onChange} custom={custom} words={REPO_WORDS} />;
}

/** A branch `BranchPicker` lists. */
export type BranchOption = {
	name: string;
	/** The repository's default branch, marked Default. */
	default?: boolean;
};

export type BranchPickerProps = Omit<ModelPickerProps, "models"> & {
	branches: readonly BranchOption[];
	/** The branches are being fetched: the button says so and can't open. */
	loading?: boolean;
};

/**
 * Which branch of the chosen repository a new session starts from: the model picker's button and searchable list, with
 * a branch icon. The default branch is marked and chosen when `value` is absent.
 */
export function BranchPicker({ branches, loading = false, disabled, ...rest }: BranchPickerProps) {
	const options = useMemo<ComposerModelOption[]>(
		() =>
			branches.map((branch) => ({
				id: branch.name,
				label: branch.name,
				...(branch.default === true ? { default: true } : {}),
			})),
		[branches],
	);
	return (
		<Picker
			{...rest}
			models={loading ? [] : options}
			disabled={disabled === true || loading}
			words={BRANCH_WORDS}
			{...(loading ? { placeholder: "Loading branches" } : {})}
		/>
	);
}

/** A project a new session can start in, as `ProjectPicker` lists it. */
export type ProjectOption = {
	id: string;
	label: string;
	/** One short line under the name. */
	description?: string;
	/** Set when the person can't start a session there; the list shows it, dimmed, with this reason. */
	disabledReason?: string;
};

export type ProjectPickerProps = Omit<ModelPickerProps, "models"> & { projects: readonly ProjectOption[] };

/**
 * Which project a new session starts in: the model picker's button and searchable list, with a folder for the spark.
 * For the composer's `footer` on a new session, as T3 Code puts the project beside a new thread's model. A project the
 * person can't start a session in shows dimmed with its reason.
 */
export function ProjectPicker({ projects, ...rest }: ProjectPickerProps) {
	return <Picker {...rest} models={projects} words={PROJECT_WORDS} />;
}

/**
 * The model picker, provider first, as T3 Code's ProviderModelPicker: a quiet button with the chosen model's provider
 * mark and name opens a popover above it (below, when there's more room there) with the providers' marks down its side and the chosen provider's models
 * beside them, newest and largest first (`orderModels`). Click a mark, or press Left and Right in the empty search, to
 * change provider; Up and Down move through its models, Enter chooses, Escape closes. Typing searches every provider's
 * models at once. A catalogue with one provider has no side rail. A model the session can't use now shows dimmed with
 * its reason.
 */
export function ModelPicker({ models, ...rest }: ModelPickerProps) {
	const ordered = useMemo(() => orderModels(models), [models]);
	return <Picker {...rest} models={ordered} words={MODEL_WORDS} rail />;
}

/** What a provider is called in the picker: its name, or "Other" for models without one. */
const providerName = (key: string): string => (key === "" ? "Other" : key);

function Picker({
	models,
	value,
	onChange,
	disabled = false,
	size = "sm",
	onOpenChange,
	returnFocus,
	defaultOpen = false,
	chevron = true,
	words,
	custom,
	placeholder,
	rail = false,
}: ModelPickerProps & {
	words: PickerWords;
	/** An option made from the query, offered first when the list doesn't already have it (a typed repository). */
	custom?: (query: string) => ComposerModelOption | undefined;
	/** The button's words when nothing is chosen. Default `words.choose`. */
	placeholder?: string;
	/** Provider first: a rail of the providers' marks beside the list, which shows one provider's options at a time. */
	rail?: boolean;
}) {
	const [open, setOpenState] = useState(defaultOpen);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState<string | undefined>(undefined);
	/** The provider the rail shows; undefined until the list opens, then the chosen model's. */
	const [railChoice, setRailChoice] = useState<string | undefined>(undefined);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const popover = useRef<HTMLDivElement>(null);
	const place = usePopoverPlacement(open, root, popover);
	const listId = useId();
	const optionId = (id: string) => `${listId}-${id.replace(/[^\w-]/g, "_")}`;
	const chosen = selectedModel(models, value);

	const optionsFor = useCallback(
		(text: string): ComposerModelOption[] => {
			const matching = filterModels(models, text);
			const made = custom?.(text);
			if (made === undefined || models.some((model) => model.id === made.id)) return matching;
			return [made, ...matching];
		},
		[models, custom],
	);
	const providers = useMemo(() => (rail ? providerOrder(models) : []), [rail, models]);
	const showRail = providers.length > 1;
	const railProvider =
		railChoice !== undefined && providers.includes(railChoice)
			? railChoice
			: chosen === undefined
				? providers[0]
				: providerKey(chosen);
	/** What the list shows for a query: with the rail and no query, only the rail's provider's options. */
	const visibleFor = useCallback(
		(text: string, provider: string | undefined): ComposerModelOption[] => {
			const matching = optionsFor(text);
			if (!showRail || text.trim() !== "") return matching;
			return matching.filter((model) => providerKey(model) === provider);
		},
		[optionsFor, showRail],
	);
	const searching = query.trim() !== "";
	const filtered = useMemo(() => visibleFor(query, railProvider), [visibleFor, query, railProvider]);
	const enabled = useMemo(() => filtered.filter((model) => model.disabledReason === undefined), [filtered]);
	const groups = useMemo(() => groupByProvider(filtered), [filtered]);
	const showGroups = groups.length > 1 || (groups[0]?.provider ?? "") !== "" || showRail;
	/** While searching, the providers with a match: the rail dims the rest. */
	const matched = useMemo(() => new Set(groups.map((group) => group.provider)), [groups]);
	/** The longest provider's list, so the popover keeps one height as the rail changes provider. */
	const railRows = useMemo(() => {
		if (!showRail) return 0;
		const counts = new Map<string, number>();
		for (const model of models) counts.set(providerKey(model), (counts.get(providerKey(model)) ?? 0) + 1);
		return Math.max(providers.length, ...counts.values());
	}, [showRail, models, providers]);

	const onOpenChangeRef = useRef(onOpenChange);
	onOpenChangeRef.current = onOpenChange;
	const setOpen = useCallback((next: boolean) => {
		setOpenState(next);
		onOpenChangeRef.current?.(next);
	}, []);

	// Tell the composer about an open-on-mount picker too.
	useEffect(() => {
		if (defaultOpen) onOpenChangeRef.current?.(true);
	}, [defaultOpen]);

	// Opening starts from the chosen model with an empty query, and puts the caret in the search field. Only on
	// opening: a new `chosen` while open must not reset the query.
	const chosenRef = useRef(chosen);
	chosenRef.current = chosen;
	useLayoutEffect(() => {
		if (!open) return;
		const current = chosenRef.current;
		setQuery("");
		setRailChoice(current === undefined ? undefined : providerKey(current));
		setActive(current?.disabledReason === undefined ? current?.id : undefined);
		search.current?.focus({ preventScroll: true });
	}, [open]);

	// The active option stays in view as the keyboard moves it.
	useLayoutEffect(() => {
		if (!open || active === undefined) return;
		const element = list.current?.querySelector<HTMLElement>(`[data-model-id="${CSS.escape(active)}"]`);
		element?.scrollIntoView({ block: "nearest" });
	}, [open, active]);

	// A pointer down outside closes it.
	useEffect(() => {
		if (!open) return;
		const onPointer = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false);
		};
		document.addEventListener("pointerdown", onPointer);
		return () => document.removeEventListener("pointerdown", onPointer);
	}, [open, setOpen]);

	const close = (focus: "trigger" | "field") => {
		setOpen(false);
		if (focus === "field" && returnFocus) returnFocus();
		else trigger.current?.focus();
	};

	const choose = (model: ComposerModelOption) => {
		if (model.disabledReason !== undefined) return;
		onChange(model.id);
		close("field");
	};

	/**
	 * Shows a provider's models, from the rail or Left and Right: the active option is the chosen model when it is
	 * that provider's, else its first that can be chosen. Clears a search.
	 */
	const openProvider = (provider: string) => {
		setRailChoice(provider);
		setQuery("");
		const visible = visibleFor("", provider).filter((model) => model.disabledReason === undefined);
		setActive((visible.find((model) => model.id === chosen?.id) ?? visible[0])?.id);
	};

	const stepProvider = (step: number) => {
		const index = providers.indexOf(railProvider ?? "");
		const next = providers[(Math.max(index, 0) + step + providers.length) % providers.length];
		if (next !== undefined) openProvider(next);
	};

	const move = (step: number) => {
		if (enabled.length === 0) return;
		const index = enabled.findIndex((model) => model.id === active);
		const next = index === -1 ? (step > 0 ? 0 : enabled.length - 1) : (index + step + enabled.length) % enabled.length;
		setActive(enabled[next]?.id);
	};

	const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				move(1);
				break;
			case "ArrowUp":
				event.preventDefault();
				move(-1);
				break;
			case "Home":
				if (query !== "") break;
				event.preventDefault();
				setActive(enabled[0]?.id);
				break;
			case "End":
				if (query !== "") break;
				event.preventDefault();
				setActive(enabled.at(-1)?.id);
				break;
			// With the rail and an empty search, Left and Right change provider; with a query they move the caret.
			case "ArrowLeft":
			case "ArrowRight":
				if (!showRail || query !== "" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) break;
				event.preventDefault();
				stepProvider(event.key === "ArrowRight" ? 1 : -1);
				break;
			case "Enter": {
				event.preventDefault();
				const model = enabled.find((entry) => entry.id === active) ?? enabled[0];
				if (model) choose(model);
				break;
			}
			case "Escape":
				event.preventDefault();
				event.stopPropagation();
				close("trigger");
				break;
			case "Tab":
				setOpen(false);
				break;
		}
	};

	const onTriggerKey = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key === "ArrowUp" || event.key === "ArrowDown") {
			event.preventDefault();
			setOpen(true);
		}
	};

	// Typing narrows the list; keep the active option on a visible one. Clearing a search goes back to the rail's
	// view on the provider of the option it had reached, so arrowing to a match and clearing stays there.
	const changeQuery = (next: string) => {
		setQuery(next);
		let provider = railProvider;
		if (showRail && next.trim() === "") {
			const reached = models.find((model) => model.id === active);
			if (reached !== undefined) {
				provider = providerKey(reached);
				setRailChoice(provider);
			}
		}
		const visible = visibleFor(next, provider).filter((model) => model.disabledReason === undefined);
		if (!visible.some((model) => model.id === active)) setActive(visible[0]?.id);
	};

	const label = placeholder ?? chosen?.label ?? words.choose;

	return (
		<div className="hb-model-picker relative flex min-w-0" ref={root}>
			<button
				ref={trigger}
				type="button"
				className={`${triggerClass} ${triggerSize[size]}`}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={`${words.noun}: ${label}`}
				title={chosen?.provider ? `${label}, ${chosen.provider}` : label}
				disabled={disabled || models.length === 0}
				onClick={() => (open ? close("trigger") : setOpen(true))}
				onKeyDown={onTriggerKey}
			>
				{words.icon(size === "xs" ? "sm" : "md", chosen)}
				<span className={`hb-model-trigger-label min-w-0 overflow-hidden text-ellipsis ${trimmed}`}>{label}</span>
				{chevron ? <ChevronDownIcon size="sm" className="hb-model-trigger-chevron text-faint" /> : null}
			</button>
			{open ? (
				<div
					ref={popover}
					className={`${popoverClass} ${popoverSide[place.side]} ${showRail ? popoverRail : popoverPlain}`}
					role="dialog"
					aria-label={words.choose}
					data-side={place.side}
					style={{ ...place.style, ...(showRail ? ({ "--hb-model-rows": railRows } as CSSProperties) : {}) }}
				>
					{showRail ? (
						// biome-ignore lint/a11y/useSemanticElements: a set of toggle buttons, not a form's fieldset.
						<div className={railClass} role="group" aria-label="Providers">
							{providers.map((provider) => {
								const name = providerName(provider);
								const count = models.filter((model) => providerKey(model) === provider).length;
								const current = !searching && provider === railProvider;
								return (
									<button
										key={provider || "other"}
										type="button"
										className={railButton}
										// The search field owns the keyboard: Left and Right there change provider.
										tabIndex={-1}
										aria-pressed={current}
										aria-label={`${name}, ${count === 1 ? "1 model" : `${count} models`}`}
										title={name}
										data-provider={provider}
										data-unmatched={(searching && !matched.has(provider)) || undefined}
										onClick={() => {
											openProvider(provider);
											search.current?.focus({ preventScroll: true });
										}}
										// Keep focus in the search field while choosing a provider with the pointer.
										onMouseDown={(event) => event.preventDefault()}
									>
										<ProviderIcon provider={provider} fallback="initial" className={railMark} />
									</button>
								);
							})}
						</div>
					) : null}
					<div className="hb-model-main flex min-h-0 min-w-0 flex-1 flex-col">
						<div className={`${searchRow} ${showRail ? "rounded-tr-panel" : "rounded-t-panel"}`} data-focus-surface="">
							<SearchIcon size="sm" className="hb-model-search-icon flex-none translate-y-(--hb-on-cap)" />
							<input
								ref={search}
								className={searchInput}
								type="text"
								role="combobox"
								aria-label={words.search}
								aria-expanded="true"
								aria-controls={listId}
								aria-autocomplete="list"
								aria-activedescendant={active === undefined ? undefined : optionId(active)}
								placeholder={words.search}
								value={query}
								onChange={(event) => changeQuery(event.target.value)}
								onKeyDown={onSearchKey}
								autoComplete="off"
								spellCheck={false}
							/>
						</div>
						<div
							className={`${listClass} ${showRail ? listRail : listPlain}`}
							ref={list}
							id={listId}
							role="listbox"
							aria-label={words.plural}
						>
							{filtered.length === 0 ? (
								<p className="hb-model-empty m-0 p-3 text-sm text-muted">{words.none(query)}</p>
							) : (
								groups.map((group) => (
									// biome-ignore lint/a11y/useSemanticElements: a listbox's groups are ARIA groups; a fieldset isn't allowed in one.
									<div
										key={group.provider || "models"}
										role="group"
										aria-label={group.provider || words.plural}
										className="hb-model-group not-first:mt-1"
									>
										{showGroups && (group.provider !== "" || showRail) ? (
											<div className={groupLabel} aria-hidden="true">
												{showRail ? (
													<ProviderIcon
														provider={group.provider}
														fallback="initial"
														size="sm"
														className={`hb-model-group-mark ${initialTile}`}
													/>
												) : null}
												<span className="hb-model-group-name">{providerName(group.provider)}</span>
											</div>
										) : null}
										{group.models.map((model) => (
											<ModelOption
												key={model.id}
												id={optionId(model.id)}
												model={model}
												selected={model.id === chosen?.id}
												active={model.id === active}
												showProvider={!showGroups}
												onChoose={() => choose(model)}
												onHover={() => model.disabledReason === undefined && setActive(model.id)}
											/>
										))}
									</div>
								))
							)}
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}

function ModelOption({
	id,
	model,
	selected,
	active,
	showProvider,
	onChoose,
	onHover,
}: {
	id: string;
	model: ComposerModelOption;
	selected: boolean;
	active: boolean;
	showProvider: boolean;
	onChoose: () => void;
	onHover: () => void;
}) {
	const disabled = model.disabledReason !== undefined;
	const detail = model.disabledReason ?? model.description ?? (showProvider ? model.provider : undefined);
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the search field owns the keyboard (aria-activedescendant).
		<div
			id={id}
			role="option"
			// Reachable only through the search field's aria-activedescendant, never by Tab.
			tabIndex={-1}
			aria-selected={selected}
			aria-disabled={disabled || undefined}
			data-model-id={model.id}
			data-active={active || undefined}
			className={optionClass}
			onClick={onChoose}
			onPointerMove={onHover}
			// Keep focus in the search field while choosing with the pointer.
			onMouseDown={(event) => event.preventDefault()}
		>
			{/* A model that can't be chosen has a muted name. */}
			<span
				className={`hb-model-option-label col-1 row-1 flex min-w-0 items-baseline gap-1.5 text-md leading-tight ${disabled ? "text-muted" : ""}`}
			>
				<span className={`hb-model-option-name min-w-0 truncate ${trimmed}`}>{model.label}</span>
				{/* On the active row's tint the faint grey falls just short of 4.5:1; muted keeps "Default" readable there. */}
				{model.default ? (
					<span
						className={`hb-model-option-default flex-none text-xs ${trimmed} ${active ? "text-muted" : "text-faint"}`}
					>
						Default
					</span>
				) : null}
			</span>
			{detail === undefined ? null : <span className={optionDetail}>{detail}</span>}
			{model.capabilities?.images === true ? (
				<ImageIcon size="sm" className="hb-model-option-cap col-2 row-1 text-faint" label="Reads images" />
			) : null}
			<span className={optionCheck}>{selected ? <CheckIcon size="sm" /> : null}</span>
		</div>
	);
}
