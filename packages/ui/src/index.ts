// @harbour/ui: Harbour's component library. Importing anything from it brings in the tokens and the base styles; put
// the `hb-app` class on the host's root element to opt the page into them. See README.md for what to use when.
// This file is listed in package.json's sideEffects: without it a bundler sees only re-exports here and drops the two
// imports below, and a production build ships the components without their tokens.

import "./tokens/tokens.css";
import "./tokens/base.css";

// The audit view.
export {
	type AuditDirectory,
	type AuditFilters,
	type AuditKind,
	type AuditLinks,
	type AuditRange,
	type AuditSource,
	type AuditViewQuery,
	describeEvent,
	matchesCredential,
	rangeBounds,
	readAll,
	toJsonl,
	toQuery,
} from "./audit/audit-model.ts";
export { AuditView, type AuditViewProps, type Choice } from "./audit/audit-view.tsx";
export { CredentialUsagePanel, type CredentialUsagePanelProps } from "./audit/credential-usage.tsx";
export { type CredentialUsage, credentialUsage } from "./audit/usage.ts";
export {
	Button,
	type ButtonProps,
	type ButtonSize,
	type ButtonVariant,
	IconButton,
	type IconButtonProps,
} from "./primitives/button.tsx";
export { clockListenerCounts, useNow } from "./primitives/clock.ts";
export { CopyButton, Disclosure, SegmentedControl, type SegmentOption, TextField } from "./primitives/controls.tsx";
export { clockTime, compactAge, duration, timeLeft } from "./primitives/format.ts";
export * from "./primitives/icons.tsx";
export { ListRow, type ListRowProps } from "./primitives/list-row.tsx";
export { Kbd, Skeleton, Spinner } from "./primitives/spinner.tsx";
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
export { ClockTime, Elapsed, RelativeTime } from "./primitives/time.tsx";
// Session components.
export { BrowserGrantCard, type BrowserGrantCardProps } from "./session/browser-grant-card.tsx";
export { Composer, type ComposerProps, ComposerSendHint } from "./session/composer.tsx";
export { type ComposerState, type PrimaryAction, primaryAction, shouldSend } from "./session/composer-model.ts";
export { DiffStat, diffStatLabel } from "./session/diff-stat.tsx";
export { Markdown, splitBlocks } from "./session/markdown.tsx";
export { AssistantMessage, NoticeRow, UserMessage } from "./session/message.tsx";
export { QuestionCard, type QuestionCardProps } from "./session/question-card.tsx";
export {
	ConnectionState,
	type ConnectionStateValue,
	SessionHeader,
	type SessionHeaderProps,
} from "./session/session-header.tsx";
export {
	SessionList,
	SessionListItem,
	type SessionListItemProps,
	type SessionListProps,
} from "./session/session-list.tsx";
export {
	type AttentionGroup,
	attentionGroup,
	groupSessions,
	type SessionGroup,
	type SessionSummary,
	sessionStatus,
} from "./session/session-model.ts";
export {
	ToolCallChip,
	type ToolCallChipProps,
	ToolCallGroup,
	type ToolCallGroupProps,
	toolIcon,
} from "./session/tool-call.tsx";
export { type RowRenderPhase, Transcript, type TranscriptProps } from "./session/transcript.tsx";
export { groupTranscript, type TranscriptRow } from "./session/transcript-model.ts";
export {
	BindingCodePicker,
	type BindingCodePickerProps,
	VaultApprovalCard,
	type VaultApprovalCardProps,
	VaultApprovalCardSkeleton,
} from "./session/vault-approval-card.tsx";
export { isRouteGrant, methodText, mustPickCode, vaultHost } from "./session/vault-model.ts";
export { type Status, statusLabel, token } from "./tokens/tokens.ts";
// The vault page.
export { ActiveGrantList, type ActiveGrantListProps } from "./vault/grant-list.tsx";
export {
	type DescribeRequester,
	type GrantSummary,
	loadActiveGrants,
	loadVaultRequest,
	type VaultPageApi,
} from "./vault/load.ts";
export {
	type PasskeyCheck,
	type PasskeyRequest,
	type WebAuthnPasskeyOptions,
	webAuthnPasskey,
} from "./vault/passkey.ts";
export {
	VaultPage,
	type VaultPageProps,
	VaultRequestSkeleton,
	VaultRequestView,
	type VaultRequestViewProps,
} from "./vault/vault-page.tsx";
export {
	type DecisionRefusal,
	decisionRefusal,
	draftNarrowing,
	initialDraft,
	isForwarded,
	type NarrowingDraft,
	previewTerms,
	type RequesterLabels,
	settledState,
	termsSentence,
	type VaultLifecycle,
	type VaultRequest,
	type Viewer,
} from "./vault/vault-page-model.ts";
// Workspace components.
export { FileTree, type FileTreeProps } from "./workspace/file-tree.tsx";
export { FileViewer, type FileViewerProps, type FileViewState } from "./workspace/file-viewer.tsx";
export { NoteViewer, type NoteViewerProps, type NoteViewState } from "./workspace/note-viewer.tsx";
export {
	compareEntries,
	type DirectoryState,
	entryName,
	fileExtension,
	fileKind,
	fileViewerLineCap,
	formatBytes,
	isNote,
	nextFocus,
	noteTitle,
	parentPath,
	placeholderPath,
	sortEntries,
	type TreeMove,
	type TreePlaceholderKind,
	type TreeRow,
	type TreeRowKind,
	textLines,
	visibleRows,
	type WorkspaceEntry,
	type WorkspaceEntryKind,
	type WorkspaceFileKind,
} from "./workspace/workspace-model.ts";
