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
	credentialChoices,
	describeEvent,
	eventItemId,
	rangeBounds,
	readAll,
	toJsonl,
	toQuery,
} from "./audit/audit-model.ts";
export { AuditView, type AuditViewProps, type Choice } from "./audit/audit-view.tsx";
export { CredentialUsagePanel, type CredentialUsagePanelProps } from "./audit/credential-usage.tsx";
export { type CredentialUsage, credentialUsage } from "./audit/usage.ts";
// Identity: a host app's API keys.
export { ApiKeysPage, type ApiKeysPageProps } from "./identity/api-keys.tsx";
export {
	type ApiKeysApi,
	type ApiKeysFlow,
	type ApiKeysProblem,
	type ApiKeysState,
	administeredProjects,
	apiKeysProblem,
	createApiKeysFlow,
	type KeyDraft,
	type KeyExpiry,
	type KeyProject,
} from "./identity/api-keys-model.ts";
// Identity: who is signed in, and Harbour's own email-code sign-in.
export { SignInScreen, type SignInScreenProps } from "./identity/sign-in.tsx";
export {
	codeDigits,
	createSignInFlow,
	initialSignIn,
	SIGN_IN_CODE_DIGITS,
	SIGN_IN_CODE_TTL_MS,
	SIGN_IN_MAX_CODES,
	SIGN_IN_MAX_TRIES,
	type SignInApi,
	type SignInFlow,
	type SignInFlowOptions,
	type SignInProblem,
	type SignInState,
	signInProblem,
} from "./identity/sign-in-model.ts";
export { initials, SignedInAs, type SignedInAsProps } from "./identity/signed-in-as.tsx";
// The memory page.
export { ConceptChange, type ConceptChangeProps } from "./memory/concept-change.tsx";
export { ConceptDetail, type ConceptDetailProps } from "./memory/concept-detail.tsx";
export {
	applyAsPerson,
	bindMemory,
	conceptHistory,
	groupConcepts,
	type MemoryApi,
	type MemoryPageSource,
	writeSentence,
} from "./memory/memory-model.ts";
export { MemoryPage, type MemoryPageProps, type MemoryView } from "./memory/memory-page.tsx";
export { MemoryProposals, type MemoryProposalsProps } from "./memory/memory-proposals.tsx";
export { MemoryRecall, type MemoryRecallProps } from "./memory/memory-recall.tsx";
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
	CopyButton,
	Disclosure,
	SegmentedControl,
	type SegmentOption,
	SelectField,
	type SelectOption,
	TextField,
} from "./primitives/controls.tsx";
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
// The schedules page.
export {
	bindSchedules,
	recurrenceText,
	type SchedulesApi,
	type SchedulesSource,
	timingText,
} from "./schedules/schedules-model.ts";
export {
	ScheduleDetail,
	type ScheduleDetailProps,
	SchedulesPage,
	type SchedulesPageProps,
} from "./schedules/schedules-page.tsx";
// Session components.
export { BrowserGrantCard, type BrowserGrantCardProps } from "./session/browser-grant-card.tsx";
export { Composer, type ComposerProps, ComposerSendHint } from "./session/composer.tsx";
export {
	type AttachSource,
	attachmentKind,
	type ComposerAttachment,
	type ComposerAttachmentKind,
	type ComposerAttachments,
	type Upload,
	type UploadContext,
	useComposerAttachments,
} from "./session/composer-attachments.tsx";
export {
	type AttachmentLimits,
	type ComposerState,
	checkFiles,
	DEFAULT_PASTE_FOLD,
	limitsSummary,
	type PasteFold,
	type PrimaryAction,
	primaryAction,
	type RejectedFile,
	shouldSend,
} from "./session/composer-model.ts";
export { DiffStat, diffStatLabel } from "./session/diff-stat.tsx";
export { Markdown, splitBlocks } from "./session/markdown.tsx";
export { AssistantMessage, NoticeRow, UserMessage } from "./session/message.tsx";
export {
	MessageAction,
	type MessageActionProps,
	MessageActions,
	type MessageActionsProps,
} from "./session/message-actions.tsx";
export {
	type ComposerModelOption,
	filterModels,
	ModelPicker,
	type ModelPickerProps,
	type ProjectOption,
	ProjectPicker,
	type ProjectPickerProps,
	selectedModel,
} from "./session/model-picker.tsx";
export { NewSessionRow, type NewSessionRowProps } from "./session/new-session.tsx";
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
	chosenThinking,
	clampThinking,
	isThinkingLevel,
	offeredLevels,
	stepThinking,
	THINKING_LABELS,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "./session/thinking-model.ts";
export { ThinkingPicker, type ThinkingPickerProps } from "./session/thinking-picker.tsx";
export {
	ToolCallChip,
	type ToolCallChipProps,
	ToolCallGroup,
	type ToolCallGroupProps,
	toolIcon,
} from "./session/tool-call.tsx";
export {
	type RowRenderPhase,
	Transcript,
	type TranscriptProps,
	type TranscriptWorking,
} from "./session/transcript.tsx";
export { finalAnswerIds, groupTranscript, type TranscriptRow } from "./session/transcript-model.ts";
export {
	BindingCodePicker,
	type BindingCodePickerProps,
	VaultApprovalCard,
	type VaultApprovalCardProps,
	VaultApprovalCardSkeleton,
} from "./session/vault-approval-card.tsx";
export { isRouteGrant, methodText, mustPickCode, vaultHost } from "./session/vault-model.ts";
export { WorkingIndicator, type WorkingIndicatorProps } from "./session/working-indicator.tsx";
// The skills page.
export { SkillEditor, type SkillEditorProps, type SkillEditorTarget } from "./skills/skill-editor.tsx";
export {
	bindSkills,
	bindSkillsAuthor,
	type OwnerChoice,
	type SkillsApi,
	type SkillsAuthor,
	type SkillsAuthorApi,
	type SkillsSource,
} from "./skills/skills-model.ts";
export { SkillDetail, type SkillDetailProps, SkillsPage, type SkillsPageProps } from "./skills/skills-page.tsx";
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
