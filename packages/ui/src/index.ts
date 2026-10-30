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
// Documents the agent writes (`create_document`): streamed in, edited in place, exported and shared.
export { documentSlug, draftDocument } from "./documents/document-model.ts";
export {
	DocumentPanel,
	type DocumentPanelProps,
	type DocumentPanelStatus,
	type DocumentSaveState,
} from "./documents/document-panel.tsx";
export { exportMarkdown, printDocument } from "./documents/export.ts";
export {
	type ShareAccess,
	ShareButton,
	type ShareControls,
	type ShareExport,
	type ShareInvite,
	SharePopover,
	type SharePopoverProps,
	type ShareState,
} from "./documents/share-popover.tsx";
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
// Identity: the organisation's members, and an admin's passkey reset (#132).
export { MembersPage, type MembersPageProps } from "./identity/members.tsx";
export {
	createMembersFlow,
	type MemberRow,
	type MembersApi,
	type MembersFlow,
	type MembersProblem,
	type MembersState,
	membersProblem,
} from "./identity/members-model.ts";
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
export { FilePanel, type FilePanelProps, type FilePanelState, saveFile } from "./presented/file-panel.tsx";
export { framedHtml, HTML_FRAME_POLICY, HTML_FRAME_SANDBOX } from "./presented/html-frame.ts";
// Files the agent presents (`present_files`): their cards in the transcript, and the viewer they open.
export {
	PresentedFileCard,
	type PresentedFileCardProps,
	PresentedFiles,
	type PresentedFilesProps,
} from "./presented/presented-file-card.tsx";
export {
	fileToOpen,
	type PresentedKind,
	presentedFiles,
	presentedKey,
	presentedKind,
	presentedKindLabel,
} from "./presented/presented-file-model.ts";
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
// The schedule create and edit form, used by the page and on its own.
export { ScheduleForm, type ScheduleFormProps } from "./schedules/form/schedule-form.tsx";
export {
	createScheduleFormFlow,
	type DraftErrors,
	draftFromSchedule,
	emptyDraft,
	previewDraft,
	readDraft,
	type ScheduleAgent,
	type ScheduleDraft,
	type ScheduleFormFlow,
	type ScheduleFormProblem,
	type ScheduleFormState,
} from "./schedules/form/schedule-form-model.ts";
export {
	type CheckPayload,
	type FormKind,
	isFormKind,
	readCheckPayload,
	readTaskPayload,
	type ScheduleWrites,
	type TaskPayload,
	taskPayload,
} from "./schedules/form/schedule-writes.ts";
// The schedules page, and the one client it reads and writes through.
export {
	bindSchedules,
	recurrenceText,
	runSession,
	type SchedulesApi,
	type SchedulesSource,
	type ScheduleUpdate,
	timingText,
} from "./schedules/schedules-model.ts";
export {
	ScheduleDetail,
	type ScheduleDetailProps,
	type ScheduleFormSettings,
	type ScheduleLinks,
	SchedulesPage,
	type SchedulesPageProps,
} from "./schedules/schedules-page.tsx";
export {
	AccessPicker,
	type AccessPickerProps,
	type ComposerAccessOption,
	chosenAccess,
} from "./session/access-picker.tsx";
// Session components.
export { BrowserGrantCard, type BrowserGrantCardProps } from "./session/browser-grant-card.tsx";
export {
	type BrowserFrame,
	type BrowserFrameSink,
	type BrowserLiveSource,
	type BrowserLiveStatus,
	BrowserLiveView,
	type BrowserLiveViewProps,
	embeddable,
} from "./session/browser-live-view.tsx";
export { BrowserPanel, type BrowserPanelProps } from "./session/browser-panel.tsx";
export {
	BrowsingGroup,
	type BrowsingGroupProps,
	browsingBrowser,
	browsingSummary,
} from "./session/browsing-group.tsx";
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
	type MessageActionHandlers,
	type MessageActionProps,
	MessageActions,
	MessageActionsContext,
	type MessageActionsProps,
	MessageEditor,
	type MessageEditorProps,
} from "./session/message-actions.tsx";
export { orderModels } from "./session/model-order.ts";
export {
	type BranchOption,
	BranchPicker,
	type BranchPickerProps,
	type ComposerModelOption,
	filterModels,
	ModelPicker,
	type ModelPickerProps,
	NO_REPOSITORY,
	type ProjectOption,
	ProjectPicker,
	type ProjectPickerProps,
	RepoPicker,
	type RepoPickerProps,
	repositoryFrom,
	selectedModel,
} from "./session/model-picker.tsx";
export { NewSessionRow, type NewSessionRowProps } from "./session/new-session.tsx";
export { ProviderIcon, providerInitial, providerMark } from "./session/provider-icon.tsx";
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
	DeleteSessionDialog,
	RenameSessionDialog,
	type SessionAction,
	SessionFilterMenu,
	type SessionMenuActions,
	SessionRowMenu,
} from "./session/session-menu.tsx";
export {
	type AttentionGroup,
	arrangeSessions,
	attentionGroup,
	defaultSessionListView,
	groupSessions,
	type SessionActivityFilter,
	type SessionGroup,
	type SessionGroupBy,
	type SessionListView,
	type SessionSection,
	type SessionSortBy,
	type SessionStatusFilter,
	type SessionSummary,
	sessionListViewOf,
	sessionStatus,
	sessionViewChoices,
} from "./session/session-model.ts";
export { SubagentCard, type SubagentCardProps } from "./session/subagent-card.tsx";
export { isSubagentCall, plainText, SUBAGENT_TOOL, subagentOf } from "./session/subagent-model.ts";
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
	ToolImages,
	type ToolImagesProps,
	toolIcon,
	toolImageSrc,
} from "./session/tool-call.tsx";
export {
	type RowRenderPhase,
	Transcript,
	type TranscriptProps,
	type TranscriptWorking,
} from "./session/transcript.tsx";
export {
	activeBrowsingRow,
	type BrowserViewSlot,
	type BrowsingStep,
	browserViewSlots,
	finalAnswerIds,
	findTurn,
	groupTranscript,
	isBrowserCall,
	isTurn,
	rowOfTurn,
	type SessionBrowsers,
	sessionBrowsers,
	type TranscriptRow,
	turnAnchor,
	workingPlacement,
} from "./session/transcript-model.ts";
export {
	BindingCodePicker,
	type BindingCodePickerProps,
	VaultApprovalCard,
	type VaultApprovalCardProps,
	VaultApprovalCardSkeleton,
} from "./session/vault-approval-card.tsx";
export { isRouteGrant, methodText, mustPickCode, vaultHost } from "./session/vault-model.ts";
export {
	LiveActivity,
	type LiveActivityProps,
	WorkingIndicator,
	type WorkingIndicatorProps,
} from "./session/working-indicator.tsx";
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
