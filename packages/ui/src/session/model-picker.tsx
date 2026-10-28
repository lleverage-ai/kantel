import {
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
import { CheckIcon, ChevronDownIcon, FolderIcon, ImageIcon, SearchIcon, SparkIcon } from "../primitives/icons.tsx";
import "./model-picker.css";
import type { ThinkingLevel } from "./thinking-model.ts";

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
		const provider = model.provider ?? "";
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
	readonly icon: (size: "sm" | "md") => ReactNode;
	/** "Model", as the trigger's accessible name starts. */
	readonly noun: string;
	/** "Models", the list's name. */
	readonly plural: string;
	readonly choose: string;
	readonly search: string;
	readonly none: (query: string) => string;
};

const MODEL_WORDS: PickerWords = {
	icon: (size) => <SparkIcon size={size} className="hb-model-trigger-icon" />,
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
 * The composer's model picker: a quiet toolbar button with the model's name that opens a searchable list above it,
 * grouped by provider, as T3 Code's ProviderModelPicker. Type to filter; Up and Down move, Enter chooses, Escape
 * closes. A model the session can't use now shows dimmed with its reason.
 */
export function ModelPicker(props: ModelPickerProps) {
	return <Picker {...props} words={MODEL_WORDS} />;
}

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
}: ModelPickerProps & { words: PickerWords }) {
	const [open, setOpenState] = useState(defaultOpen);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState<string | undefined>(undefined);
	const root = useRef<HTMLDivElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const listId = useId();
	const optionId = (id: string) => `${listId}-${id.replace(/[^\w-]/g, "_")}`;
	const chosen = selectedModel(models, value);

	const filtered = useMemo(() => filterModels(models, query), [models, query]);
	const enabled = useMemo(() => filtered.filter((model) => model.disabledReason === undefined), [filtered]);
	const groups = useMemo(() => groupByProvider(filtered), [filtered]);
	const showGroups = groups.length > 1 || (groups[0]?.provider ?? "") !== "";

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

	// Typing narrows the list; keep the active option on a visible one.
	const changeQuery = (next: string) => {
		setQuery(next);
		const visible = filterModels(models, next).filter((model) => model.disabledReason === undefined);
		if (!visible.some((model) => model.id === active)) setActive(visible[0]?.id);
	};

	const label = chosen?.label ?? words.choose;

	return (
		<div className={`hb-model-picker hb-model-picker-${size}`} ref={root}>
			<button
				ref={trigger}
				type="button"
				className="hb-model-trigger hb-focusable"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-label={`${words.noun}: ${label}`}
				title={chosen?.provider ? `${label}, ${chosen.provider}` : label}
				disabled={disabled || models.length === 0}
				onClick={() => (open ? close("trigger") : setOpen(true))}
				onKeyDown={onTriggerKey}
			>
				{words.icon(size === "xs" ? "sm" : "md")}
				<span className="hb-model-trigger-label">{label}</span>
				{chevron ? <ChevronDownIcon size="sm" className="hb-model-trigger-chevron" /> : null}
			</button>
			{open ? (
				<div className="hb-model-popover" role="dialog" aria-label={words.choose}>
					<div className="hb-model-search" data-focus-surface="">
						<SearchIcon size="sm" className="hb-model-search-icon" />
						<input
							ref={search}
							className="hb-model-search-input"
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
					<div className="hb-model-list" ref={list} id={listId} role="listbox" aria-label={words.plural}>
						{filtered.length === 0 ? (
							<p className="hb-model-empty">{words.none(query)}</p>
						) : (
							groups.map((group) => (
								// biome-ignore lint/a11y/useSemanticElements: a listbox's groups are ARIA groups; a fieldset isn't allowed in one.
								<div
									key={group.provider || "models"}
									role="group"
									aria-label={group.provider || words.plural}
									className="hb-model-group"
								>
									{showGroups && group.provider !== "" ? (
										<div className="hb-model-group-label" aria-hidden="true">
											{group.provider}
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
			className="hb-model-option"
			onClick={onChoose}
			onPointerMove={onHover}
			// Keep focus in the search field while choosing with the pointer.
			onMouseDown={(event) => event.preventDefault()}
		>
			<span className="hb-model-option-label">
				<span className="hb-model-option-name">{model.label}</span>
				{model.default ? <span className="hb-model-option-default">Default</span> : null}
			</span>
			{detail === undefined ? null : <span className="hb-model-option-detail">{detail}</span>}
			{model.capabilities?.images === true ? (
				<ImageIcon size="sm" className="hb-model-option-cap" label="Reads images" />
			) : null}
			<span className="hb-model-option-check">{selected ? <CheckIcon size="sm" /> : null}</span>
		</div>
	);
}
