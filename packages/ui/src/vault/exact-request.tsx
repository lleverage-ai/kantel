import type { ApprovalRequest } from "@harbour/contracts";
import { useId, useState } from "react";
import { CopyButton, SegmentedControl } from "../primitives/controls.tsx";
import { Badge } from "../primitives/status.tsx";
import { Field, FieldList, Notice } from "../primitives/surface.tsx";
import { vaultMuted } from "../session/vault-styles.ts";
import { byteSize, hiddenCount, markHidden, readableBody, requestUrl } from "./exact-request-model.ts";

// Styled with Tailwind utilities (src/tokens/tailwind.css). The request is the page's one loud thing: set in the mono
// face on a sunken well, every character a person can't see drawn as a boxed name in the approval colour, so what
// they read is what goes out.

const section = "flex min-w-0 flex-col gap-2.5 border-t border-border pt-4";
const sectionTitle = "m-0 text-sm font-medium text-fg";
const hint = "m-0 text-xs text-muted wrap-anywhere";
/** The request line and the body: the mono well. */
const well =
	"hb-selectable m-0 min-w-0 overflow-x-auto rounded-control border border-border bg-sunken px-3 py-2.5 font-mono text-sm leading-relaxed text-fg whitespace-pre-wrap wrap-anywhere";
/** A character no one can see, drawn as its name. */
const hiddenMark =
	"mx-px inline-block rounded-xs border border-status-approval-line bg-status-approval-soft px-1 align-baseline font-mono text-2xs leading-tight text-status-approval";
const methodMark = "mr-2 font-medium text-accent-text";

/** `text` with each hidden character drawn as its name; the name is read out too. */
function Marked({ text }: { text: string }) {
	return (
		<>
			{markHidden(text).map((run, index) =>
				run.kind === "text" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: runs have no identity beyond their place.
					<span key={index}>{run.text}</span>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: as above.
					<abbr key={index} className={hiddenMark} title={`Hidden character ${run.code}`}>
						{run.name}
					</abbr>
				),
			)}
		</>
	);
}

export type ExactRequestProps = {
	request: ApprovalRequest;
};

/**
 * One exact request a rule asked about (#333), in full: the connection, the method and URL as they go out, the headers
 * that count, the body (formatted when it is JSON, with the bytes as sent a click away) and the digest. Hidden
 * characters anywhere are marked and counted. Nothing here is editable: an exact request is approved as it is, or
 * denied.
 */
export function ExactRequest({ request }: ExactRequestProps) {
	const id = useId();
	const url = requestUrl(request);
	const contentType = request.headers.find((header) => header.name === "content-type")?.value;
	const body = request.body ?? "";
	const readable = readableBody(body, contentType);
	const [view, setView] = useState<"formatted" | "sent">("formatted");
	const shown = view === "formatted" ? readable.text : body;
	const hidden =
		hiddenCount(url) +
		request.headers.reduce((sum, header) => sum + hiddenCount(header.name + header.value), 0) +
		hiddenCount(body);

	return (
		<section className={section} aria-labelledby={`${id}-request`}>
			<div className="flex min-h-control-xs items-center justify-between gap-2">
				<h2 id={`${id}-request`} className={sectionTitle}>
					The request
				</h2>
				<Badge tone="accent">Exact</Badge>
			</div>
			<p className={hint}>
				Nothing has been sent. Approving lets this request out once, exactly as shown; if the agent changes anything it
				asks again.
			</p>

			{hidden === 0 ? null : (
				<Notice level="warning">
					{hidden === 1 ? "One character" : `${hidden} characters`} in this request can't be seen, so{" "}
					{hidden === 1 ? "it is" : "they are"} drawn by name. Check {hidden === 1 ? "it" : "them"} before you approve.
				</Notice>
			)}

			<FieldList>
				<Field label="Connection">{request.connectionName}</Field>
				{request.tool === undefined ? null : (
					<Field label="Tool">
						<code className="hb-mono hb-selectable wrap-anywhere">
							<Marked text={request.tool} />
						</code>
					</Field>
				)}
				<Field label="Rules">
					<span className={vaultMuted}>Version</span>{" "}
					<code className="hb-mono wrap-anywhere">{request.rulesVersion}</code>{" "}
					<span className={vaultMuted}>asked for this approval; a change to them asks again</span>
				</Field>
			</FieldList>

			<pre className={well}>
				<span className={methodMark}>{request.method}</span>
				<Marked text={url} />
			</pre>

			{request.headers.length === 0 ? (
				<p className={hint}>
					No headers beyond the transport's. The credential is added on the way out and never shown.
				</p>
			) : (
				<div className="flex min-w-0 flex-col gap-1.5">
					<h3 className="m-0 text-xs font-medium text-muted">Headers</h3>
					<dl className={`${well} grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5`}>
						{request.headers.map((header) => (
							<div key={`${header.name}:${header.value}`} className="contents">
								<dt className="text-muted">
									<Marked text={header.name} />
								</dt>
								<dd className="m-0 min-w-0 wrap-anywhere">
									<Marked text={header.value} />
								</dd>
							</div>
						))}
					</dl>
					<p className={hint}>The credential is added on the way out and never shown.</p>
				</div>
			)}

			{body === "" ? (
				<p className={hint}>No body.</p>
			) : (
				<div className="flex min-w-0 flex-col gap-1.5">
					<div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
						<h3 className="m-0 text-xs font-medium text-muted">
							Body <span className="font-normal text-faint">{byteSize(body)}</span>
						</h3>
						{readable.formatted ? (
							<SegmentedControl
								label="How the body is shown"
								options={[
									{ value: "formatted", label: "Formatted" },
									{ value: "sent", label: "As sent" },
								]}
								value={view}
								onChange={setView}
							/>
						) : null}
					</div>
					<pre className={`${well} max-h-112 overflow-y-auto`}>
						<Marked text={shown} />
					</pre>
				</div>
			)}

			<div className="flex min-w-0 flex-col gap-1">
				<h3 className="m-0 text-xs font-medium text-muted">Digest</h3>
				<div className="flex min-w-0 items-center gap-2">
					<code className="hb-mono hb-selectable min-w-0 text-xs text-muted wrap-anywhere">{request.digest}</code>
					<CopyButton text={request.digest} label="Copy digest" iconOnly variant="ghost" />
				</div>
				<p className={hint}>
					Only a request with this digest can use the approval: the same connection, agent, session, method, URL,
					headers, body and rules.
				</p>
			</div>
		</section>
	);
}
