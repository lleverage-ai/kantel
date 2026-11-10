// A labelled choice of several from a list, in the order they were picked: a new sandbox's environments, where the
// later one wins. The ones picked are a numbered list, each with a button that takes it out; under them the browser's
// own select and Add put one more at the end. Add is a button rather than the select's change, because a closed select
// changes on each arrow key, which would add every option the keyboard passed over.

import { useId, useRef, useState } from "react";
import { Button, IconButton } from "./button.tsx";
import { SelectField, type SelectOption } from "./controls.tsx";
import { describedBy, FormField, type FormFieldLayout } from "./form-layout.tsx";
import { PlusIcon, XIcon } from "./icons.tsx";

export type OrderedSelectFieldProps = {
	label: string;
	/** Everything that may be picked. One picked that isn't here any more is still listed, by its value. */
	options: readonly SelectOption[];
	/** The values picked, in order. */
	value: readonly string[];
	onChange: (value: readonly string[]) => void;
	hint?: string | undefined;
	error?: string | undefined;
	layout?: FormFieldLayout;
	/** What the select says before one is chosen: "Pick an environment". */
	placeholder?: string;
	/** At most this many: the select goes once it is reached. */
	max?: number;
	disabled?: boolean;
	className?: string;
	id?: string;
};

export function OrderedSelectField({
	label,
	options,
	value,
	onChange,
	hint,
	error,
	layout,
	placeholder = "Pick one",
	max,
	disabled = false,
	className,
	id: suppliedId,
}: OrderedSelectFieldProps) {
	const generatedId = useId();
	const id = suppliedId ?? generatedId;
	const [chosen, setChosen] = useState("");
	const select = useRef<HTMLSelectElement>(null);
	const labelOf = (picked: string) => options.find((option) => option.value === picked)?.label ?? picked;
	const left = options.filter((option) => !value.includes(option.value));
	const full = max !== undefined && value.length >= max;
	// A choice since taken out of the options (or picked already) can't be added.
	const addable = chosen !== "" && left.some((option) => option.value === chosen);
	const add = () => {
		if (!addable || full) return;
		onChange([...value, chosen]);
		setChosen("");
	};
	const remove = (at: number) => {
		onChange(value.filter((_, index) => index !== at));
		// The button that had focus is gone: the select is where a person goes on from.
		select.current?.focus();
	};
	return (
		<FormField id={id} label={label} {...{ hint, error, layout, className }}>
			<div className="flex min-w-0 flex-col gap-2">
				{value.length === 0 ? null : (
					<ol
						className="m-0 flex min-w-0 flex-col rounded-control border border-border bg-raised p-0"
						aria-describedby={describedBy(id, hint, error)}
					>
						{value.map((picked, at) => {
							const name = labelOf(picked);
							return (
								<li
									key={picked}
									className="flex min-h-control-md min-w-0 items-center gap-2 border-b border-border py-0.5 pr-1 pl-2.5 last:border-b-0"
								>
									<span className="w-4 flex-none text-right text-sm text-faint tabular-nums" aria-hidden="true">
										{at + 1}
									</span>
									<span className="min-w-0 flex-1 truncate text-md text-fg" title={name}>
										{name}
									</span>
									<IconButton
										size="xs"
										variant="ghost"
										icon={<XIcon size="sm" />}
										label={`Remove ${name}`}
										disabled={disabled}
										onClick={() => remove(at)}
									/>
								</li>
							);
						})}
					</ol>
				)}
				{full || left.length === 0 ? null : (
					<div className="flex min-w-0 items-start gap-2">
						<SelectField
							ref={select}
							className="min-w-0 flex-1"
							label={value.length === 0 ? label : `Add to ${label.toLowerCase()}`}
							hideLabel
							value={chosen}
							disabled={disabled}
							onChange={(event) => setChosen(event.currentTarget.value)}
							onKeyDown={(event) => {
								// Enter adds the one chosen, as Add does, rather than submitting the form around it.
								if (event.key === "Enter" && addable) {
									event.preventDefault();
									add();
								}
							}}
							options={[{ value: "", label: placeholder }, ...left]}
							{...(value.length === 0 ? { "aria-describedby": describedBy(id, hint, error) } : {})}
						/>
						<Button size="md" icon={<PlusIcon size="sm" />} disabled={disabled || !addable} onClick={add}>
							Add
						</Button>
					</div>
				)}
			</div>
		</FormField>
	);
}
