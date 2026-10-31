import type { ReactNode } from "react";
import "../src/tokens/fonts.css";
import "../src/tokens/tokens.css";
import "../src/tokens/base.css";
import "../src/tokens/tailwind.css";
import "./workbench.css";

// Every story renders inside `kt-app`, on Kantel's canvas, as a host app would mount the library.
export const Provider = ({ children }: { children: ReactNode }) => (
	<div className="kt-app kt-workbench">{children}</div>
);
