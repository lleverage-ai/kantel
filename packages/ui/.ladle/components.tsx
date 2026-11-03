import type { GlobalProvider } from "@ladle/react";
import { useLayoutEffect, useRef } from "react";
import "../src/tokens/fonts.css";
import "../src/tokens/tokens.css";
import "../src/tokens/base.css";
import "../src/tokens/tailwind.css";
import "./workbench.css";

// Every story renders inside `kt-app`, on Kantel's canvas, as a host app would mount the library. The toolbar's theme
// button picks dark or light (auto follows the device, as the console's System does) and sets `data-kt-theme` on
// <html>, as the console's theme controller does.
export const Provider: GlobalProvider = ({ children, globalState }) => {
	const theme =
		globalState.theme === "auto"
			? globalThis.matchMedia?.("(prefers-color-scheme: light)").matches === true
				? "light"
				: "dark"
			: globalState.theme;
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		// The story's own document: the width addon renders a story in an iframe.
		(ref.current?.ownerDocument ?? document).documentElement.setAttribute("data-kt-theme", theme);
	}, [theme]);
	return (
		<div ref={ref} className="kt-app kt-workbench">
			{children}
		</div>
	);
};
