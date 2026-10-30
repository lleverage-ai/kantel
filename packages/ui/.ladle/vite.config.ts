import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// The workbench's own Vite settings, on top of Ladle's (config.mjs points here): Tailwind, so the utilities in the
// components' classNames are built from src/tokens/tailwind.css as they are in the console. Ladle adds React itself.
export default defineConfig({
	plugins: [tailwindcss()],
});
