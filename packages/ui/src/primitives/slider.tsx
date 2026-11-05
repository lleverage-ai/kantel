import { type CSSProperties, type ReactNode, useId } from "react";
import { describedBy, FormField, type FormFieldLayout } from "./form-layout.tsx";
import "./controls.css";

// Styled with Tailwind utilities (src/tokens/tailwind.css, docs/tailwind.md).

/**
 * The range input, a touch target tall, across the field. Its track and thumb are drawn in controls.css (engine
 * pseudo-elements); the filled part runs to `--kt-slider-fill`.
 */
const rangeClass =
	"kt-slider kt-focusable m-0 block h-control-xs rounded-md w-full min-w-0 cursor-pointer disabled:cursor-default disabled:opacity-50";

/** A mark: a short tick under the track, where a stop worth knowing sits (a preset). */
const markClass = "kt-slider-mark absolute top-0 h-1.5 w-px -translate-x-1/2 bg-border-strong";

export interface SliderFieldProps {
	readonly label: ReactNode;
	readonly value: number;
	readonly min: number;
	readonly max: number;
	readonly step: number;
	/** Asked for the new value, already on a step and within min and max. */
	readonly onChange: (value: number) => void;
	/** The value in words, as shown beside the label and read by screen readers: "4 vCPU", "256 MB". */
	readonly format: (value: number) => string;
	/** Values worth marking under the track, such as the shapes a host keeps ready. */
	readonly marks?: readonly number[];
	readonly hint?: ReactNode;
	readonly error?: ReactNode;
	readonly layout?: FormFieldLayout;
	readonly disabled?: boolean;
	readonly id?: string;
	readonly className?: string;
}

/** Where `value` sits along the track, 0 to 100. */
export function sliderPercent(value: number, min: number, max: number): number {
	if (max <= min) return 0;
	return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

/** `value` on the nearest step from `min`, within `min` and `max`. */
export function onStep(value: number, min: number, max: number, step: number): number {
	if (max <= min) return min;
	const stepped = min + Math.round((value - min) / step) * step;
	return Math.min(Math.max(stepped, min), min + Math.floor((max - min) / step) * step);
}

/**
 * A number chosen along a range, such as a sandbox's vCPUs or memory: the browser's range input, so arrow keys, Home,
 * End and Page Up and Down work and a screen reader reads `format`'s words. The value shows beside the label; the
 * range's ends sit under the track, with a tick at each of `marks`.
 */
export function SliderField({
	label,
	value,
	min,
	max,
	step,
	onChange,
	format,
	marks,
	hint,
	error,
	layout,
	disabled = false,
	id: suppliedId,
	className,
}: SliderFieldProps) {
	const generatedId = useId();
	const id = suppliedId ?? generatedId;
	const shown = onStep(value, min, max, step);
	const ticks = (marks ?? []).filter((mark) => mark > min && mark < max);
	return (
		<FormField
			id={id}
			label={label}
			htmlFor={id}
			extra={
				<output
					htmlFor={id}
					className="kt-slider-value ml-auto text-sm font-medium text-fg tabular-nums"
					aria-hidden="true"
				>
					{format(shown)}
				</output>
			}
			{...{ hint, error, layout, className }}
		>
			<div className="kt-slider-frame flex min-w-0 flex-col gap-0.5">
				<input
					id={id}
					type="range"
					className={rangeClass}
					min={min}
					max={max}
					step={step}
					value={shown}
					disabled={disabled || max <= min}
					aria-valuetext={format(shown)}
					aria-invalid={error !== undefined || undefined}
					aria-describedby={describedBy(id, hint, error)}
					style={{ "--kt-slider-fill": `${sliderPercent(shown, min, max)}%` } as CSSProperties}
					onChange={(event) => onChange(onStep(Number(event.currentTarget.value), min, max, step))}
				/>
				<div className="kt-slider-scale relative flex justify-between text-xs text-faint tabular-nums">
					{/* Inset by half a thumb, as the thumb's centre is at either end. */}
					<span aria-hidden="true" className="absolute inset-x-2 top-0">
						{ticks.map((mark) => (
							<span
								key={mark}
								className={markClass}
								style={{ left: `${sliderPercent(mark, min, max)}%` } as CSSProperties}
							/>
						))}
					</span>
					<span className="pt-1.5">{format(min)}</span>
					<span className="pt-1.5">{format(max)}</span>
				</div>
			</div>
		</FormField>
	);
}
