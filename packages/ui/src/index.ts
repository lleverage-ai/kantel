// @kantel/ui: Kantel's component library. Importing anything from it brings in the tokens, the base styles and the
// Tailwind utilities its components use; put the `kt-app` class on the host's root element to opt the page into them.
// See README.md for what to use when. The utilities need Tailwind's Vite plugin (`@tailwindcss/vite`) in the host's
// build. This file is listed in package.json's sideEffects: without it a bundler sees only re-exports here and drops
// the imports below, and a production build ships the components without their tokens.

import "./tokens/fonts.css";
import "./tokens/tokens.css";
import "./tokens/base.css";
import "./tokens/tailwind.css";

// The audit view.
// The brand: Kantel's mark, wordmark and lockups, in the theme's ink.
export { KantelLockup, KantelMark, KantelWordmark } from "./brand/kantel.tsx";
// The compute console (experimental, the compute plane): sandboxes, snapshots, environments and their protected
// variables, the account's egress (its log, rules and proxy settings) and each sandbox's, keys, webhooks,
// OpenTelemetry, organisations, billing on hosted Kantel and a super-admin's hosts, through one `ComputeSource`. Its
// sample data is `@kantel/ui/compute/fixtures` until the public API lands.
export {
	COMPUTE_PAGES,
	ComputeConsole,
	type ComputeConsoleProps,
	type ComputePage,
	type ComputeRoute,
	computePath,
	parseComputePath,
} from "./compute/compute-console.tsx";
export type {
	AccountsSource,
	ApiKeysSource,
	BaseImage,
	BaseImagesOverview,
	BaseImagesSource,
	BaseImageTemplate,
	BaseImageVersion,
	BillingSource,
	BrowserDeviceSource,
	BrowserStanding,
	ComputeAccount,
	ComputeSource,
	ComputeViewer,
	DestinationBinding,
	DeviceLogin,
	DeviceLoginsSource,
	E2EMode,
	E2ESource,
	EgressEntry,
	EgressGrant,
	EgressSource,
	Environment,
	EnvironmentsSource,
	EnvironmentVariable,
	FilePart,
	FileRange,
	HostChoice,
	HostingMode,
	HostsSource,
	ImageBuildReason,
	ImageFinding,
	ImageScan,
	ImageSeverity,
	ProxySource,
	PublicUrlSource,
	SandboxBase,
	SandboxCreator,
	SandboxEgress,
	SandboxesSource,
	SandboxImage,
	SandboxProcess,
	SandboxShape,
	SandboxShapes,
	SandboxSshKey,
	ShapePreset,
	SnapshotsSource,
	SshTarget,
	TelemetrySource,
	Template,
	TemplateBaseChannel,
	TemplateSnapshot,
	TemplateSpec,
	TemplatesSource,
	TemplateVersion,
	UsageRange,
	UsageSeries,
	WebhooksSource,
} from "./compute/compute-model.ts";
export {
	CLI_INSTALL_COMMAND,
	cliLoginCommand,
	cliSshCommand,
	DEFAULT_SANDBOX_SHAPES,
	DeviceSetupError,
	FilesRefusedError,
	FileTooLargeError,
	sameProxySettings,
	sshWithoutCliCommand,
} from "./compute/compute-model.ts";
// Identity: who is signed in, and Kantel's own email-code sign-in.
export { SignInScreen, type SignInScreenProps } from "./identity/sign-in.tsx";
export {
	codeDigits,
	createSignInFlow,
	initialSignIn,
	type ProviderSignInProblem,
	SIGN_IN_CODE_DIGITS,
	SIGN_IN_CODE_TTL_MS,
	SIGN_IN_MAX_CODES,
	SIGN_IN_MAX_TRIES,
	type SignInApi,
	type SignInFlow,
	type SignInFlowOptions,
	type SignInProblem,
	type SignInProviderLink,
	type SignInState,
	signInProblem,
} from "./identity/sign-in-model.ts";
export { initials, SignedInAs, type SignedInAsProps } from "./identity/signed-in-as.tsx";
export { Breadcrumbs, type BreadcrumbsProps, type Crumb } from "./primitives/breadcrumbs.tsx";
export {
	Button,
	type ButtonProps,
	type ButtonSize,
	type ButtonVariant,
	IconButton,
	type IconButtonProps,
} from "./primitives/button.tsx";
export { clockListenerCounts, useNow } from "./primitives/clock.ts";
export {
	CheckboxField,
	CopyButton,
	Disclosure,
	SegmentedControl,
	type SegmentOption,
	SelectField,
	type SelectOption,
	TextAreaField,
	TextField,
} from "./primitives/controls.tsx";
export { Dialog, type DialogProps } from "./primitives/dialog.tsx";
export { type FileTypeKind, fileTypeIcon, fileTypeKind, fileTypeLabel } from "./primitives/file-icons.ts";
export {
	describedBy,
	FormActions,
	FormField,
	type FormFieldLayout,
	FormGrid,
	FormLayout,
	FormSection,
	PageHeader,
} from "./primitives/form-layout.tsx";
export { clockTime, compactAge, duration, timeLeft } from "./primitives/format.ts";
export * from "./primitives/icons.tsx";
export { ListRow, type ListRowProps } from "./primitives/list-row.tsx";
export * from "./primitives/lucide.tsx";
export { Menu, type MenuChoice, type MenuEntry, type MenuProps } from "./primitives/menu.tsx";
export { CommandBlock, OneTimeSecret, type OneTimeSecretProps } from "./primitives/one-time-secret.tsx";
export { type PageTab, PageTabs, type PageTabsProps } from "./primitives/page-tabs.tsx";
export { SideScroll, type SideScrollSurface } from "./primitives/side-scroll.tsx";
export {
	Sidebar,
	SidebarBrand,
	SidebarItem,
	type SidebarItemProps,
	SidebarProject,
	type SidebarProjectProps,
	type SidebarProps,
	SidebarSection,
	type SidebarSectionProps,
	SidebarToggle,
	type SidebarToggleProps,
	useSidebarCollapsed,
} from "./primitives/sidebar.tsx";
export { onStep, SliderField, type SliderFieldProps, sliderPercent } from "./primitives/slider.tsx";
export { Kbd, Skeleton, Spinner } from "./primitives/spinner.tsx";
export { SplitButton, type SplitButtonProps } from "./primitives/split-button.tsx";
export {
	isChunkLoadError,
	type ReloadForNewBuildOptions,
	reloadForNewBuild,
	STALE_BUILD_RELOAD_KEY,
	STALE_BUILD_RELOAD_WINDOW_MS,
} from "./primitives/stale-build.ts";
export { Badge, type BadgeTone, StatusDot, StatusLabel } from "./primitives/status.tsx";
export {
	EmptyState,
	Field,
	FieldList,
	Notice,
	type NoticeLevel,
	Panel,
	type PanelTone,
} from "./primitives/surface.tsx";
export { Switch, type SwitchProps } from "./primitives/switch.tsx";
export { TabBar, type TabBarItem, type TabBarProps } from "./primitives/tab-bar.tsx";
export { ClockTime, Elapsed, RelativeTime } from "./primitives/time.tsx";
export { HelpHint, Tooltip, type TooltipProps } from "./primitives/tooltip.tsx";
export { DEFAULT_THEME_PREFERENCE, THEME_STORAGE_KEY, themeBootScript } from "./theme/boot.ts";
export {
	createThemeController,
	readThemeCache,
	SYSTEM_THEME,
	type ThemeCache,
	type ThemeController,
	type ThemeControllerOptions,
	type ThemeState,
	themeController,
} from "./theme/controller.ts";
export { ThemeSwitch, type ThemeSwitchProps, useThemeMenuEntry, useThemeState } from "./theme/theme-switch.tsx";
export { contrast, distance } from "./tokens/colour.ts";
export { type Status, statusLabel, token } from "./tokens/tokens.ts";
