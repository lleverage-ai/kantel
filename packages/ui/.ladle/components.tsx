import type { ReactNode } from "react";
import "../src/tokens/tokens.css";
import "../src/tokens/base.css";
import "../src/tokens/tailwind.css";
import "./workbench.css";

// Every story renders inside `hb-app`, on Harbour's canvas, as a host app would mount the library.
export const Provider = ({ children }: { children: ReactNode }) => (
	<div className="hb-app hb-workbench">{children}</div>
);
