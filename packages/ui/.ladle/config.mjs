/** @type {import('@ladle/react').UserConfig} */
export default {
	stories: "src/**/*.stories.tsx",
	defaultStory: "workbench--overview",
	outDir: "build",
	// Tailwind's Vite plugin: see vite.config.ts.
	viteConfig: ".ladle/vite.config.ts",
	addons: {
		a11y: { enabled: true },
		action: { enabled: true },
		control: { enabled: true },
		ladle: { enabled: true },
		mode: { enabled: true },
		rtl: { enabled: false },
		source: { enabled: false },
		msw: { enabled: false },
		theme: { enabled: false, defaultState: "dark" },
		width: {
			enabled: true,
			options: { mobile: 420, desktop: 1280 },
			defaultState: 0,
		},
	},
};
