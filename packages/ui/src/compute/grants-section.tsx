// Egress grants as a section of a page: an environment's, or one sandbox's own (with its environment's shown above
// them, read-only). Each rule allows or denies a host, optionally for some methods and paths only, with no one asked.
// Add grant opens a dialog; Remove takes one out. Every change saves the whole list through `onSave`.

import { useState } from "react";
import { Button, IconButton } from "../primitives/button.tsx";
import { CheckboxField, SegmentedControl, TextField } from "../primitives/controls.tsx";
import { Dialog } from "../primitives/dialog.tsx";
import { FormField } from "../primitives/form-layout.tsx";
import { PlusIcon } from "../primitives/icons.tsx";
import { TrashIcon } from "../primitives/lucide.tsx";
import { Badge } from "../primitives/status.tsx";
import { type EgressGrant, HTTP_METHODS, type HttpMethod } from "./compute-model.ts";
import { hostProblem, pathProblem, splitList } from "./egress-rules.ts";
import { cellMono, cellSub, messageOf, SectionHeading, TableFrame, table, td, th } from "./parts.tsx";

let newGrants = 0;

export function GrantsSection({
	id,
	title,
	description,
	grants,
	inherited,
	inheritedFrom,
	onSave,
}: {
	/** The heading's id, which labels the table. */
	id: string;
	title: string;
	description: string;
	grants: readonly EgressGrant[];
	/** Grants this list sits on top of (a sandbox's environment's): shown, not editable here. */
	inherited?: readonly EgressGrant[];
	/** Where `inherited` come from, for their rows: "backend-dev". */
	inheritedFrom?: string;
	onSave: (grants: readonly EgressGrant[]) => Promise<void>;
}) {
	const [adding, setAdding] = useState(false);
	const [failure, setFailure] = useState<string>();
	const [busy, setBusy] = useState<string>();
	// Every change replaces the whole list from the `grants` it was made against, so one waits for the last: two at once
	// would each write a list missing the other's change.
	const saving = busy !== undefined;
	const save = async (next: readonly EgressGrant[], what: string) => {
		if (saving) throw new Error("Kantel is still saving the last change.");
		setFailure(undefined);
		setBusy(what);
		try {
			await onSave(next);
		} catch (caught) {
			setFailure(messageOf(caught, "Kantel couldn't save the grants. Try again."));
			throw caught;
		} finally {
			setBusy(undefined);
		}
	};
	const rows = [
		...(inherited ?? []).map((grant) => ({ grant, inherited: true })),
		...grants.map((grant) => ({ grant, inherited: false })),
	];
	return (
		<section className="flex min-w-0 flex-col gap-2" aria-labelledby={id}>
			<SectionHeading
				id={id}
				title={title}
				actions={
					<Button size="sm" icon={<PlusIcon size="sm" />} disabled={saving} onClick={() => setAdding(true)}>
						Add grant
					</Button>
				}
			/>
			<p className="m-0 text-sm text-muted">{description}</p>
			{failure === undefined ? null : <p className="m-0 text-sm text-status-error">{failure}</p>}
			{rows.length === 0 ? (
				<p className="m-0 text-sm text-muted">No grants: the account's proxy settings decide.</p>
			) : (
				// The frame takes focus: inherited rows have nothing that does, and on a phone it scrolls sideways.
				<TableFrame className="kt-focusable" role="region" tabIndex={0} aria-label={`${title} table`}>
					<table className={table}>
						<thead>
							<tr>
								<th className={th} scope="col">
									Rule
								</th>
								<th className={th} scope="col">
									Host
								</th>
								<th className={th} scope="col">
									Methods
								</th>
								<th className={th} scope="col">
									Paths
								</th>
								<th className={th} scope="col">
									<span className="kt-sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map(({ grant, inherited: fromEnvironment }) => (
								<tr key={`${fromEnvironment ? "env" : "own"}-${grant.id}`} data-grant={grant.id}>
									<td className={td}>
										{grant.action === "allow" ? <Badge tone="done">Allow</Badge> : <Badge tone="error">Deny</Badge>}
										{fromEnvironment ? (
											<span className={cellSub}>From {inheritedFrom ?? "the environment"}</span>
										) : null}
									</td>
									<td className={td}>
										<span className={`${cellMono} text-fg`}>{grant.host}</span>
									</td>
									<td className={td}>
										<span className={cellMono}>{grant.methods.length === 0 ? "Any" : grant.methods.join(", ")}</span>
									</td>
									<td className={td}>
										<span className={cellMono}>{grant.paths.length === 0 ? "Any" : grant.paths.join(", ")}</span>
									</td>
									<td className={`${td} w-0 text-right`}>
										{fromEnvironment ? null : (
											<IconButton
												size="xs"
												variant="ghost"
												icon={<TrashIcon />}
												label={`Remove the grant for ${grant.host}`}
												busy={busy === grant.id}
												disabled={saving}
												onClick={() =>
													void save(
														grants.filter((entry) => entry.id !== grant.id),
														grant.id,
													).catch(() => {})
												}
											/>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</TableFrame>
			)}
			{adding ? (
				<GrantDialog
					onClose={() => setAdding(false)}
					onAdd={async (grant) => {
						await save([...grants, grant], "add");
						setAdding(false);
					}}
				/>
			) : null}
		</section>
	);
}

/** Add grant: allow or deny, a host, and optionally methods and paths. */
function GrantDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (grant: EgressGrant) => Promise<void> }) {
	const methodsId = "grant-methods";
	const [action, setAction] = useState<EgressGrant["action"]>("allow");
	const [host, setHost] = useState("");
	const [methods, setMethods] = useState<readonly HttpMethod[]>([]);
	const [paths, setPaths] = useState("");
	const [tried, setTried] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const hostError = hostProblem(host);
	const pathList = splitList(paths);
	const pathError = pathList.map(pathProblem).find((problem) => problem !== undefined);
	const submit = () => {
		setTried(true);
		if (hostError !== undefined || pathError !== undefined || busy) return;
		newGrants += 1;
		setBusy(true);
		setFailure(undefined);
		onAdd({ id: `grt_new_${newGrants}`, action, host: host.trim().toLowerCase(), methods, paths: pathList }).then(
			() => setBusy(false),
			(caught: unknown) => {
				setBusy(false);
				setFailure(messageOf(caught, "Kantel couldn't add the grant. Try again."));
			},
		);
	};
	return (
		<Dialog
			open
			title="Add grant"
			onClose={onClose}
			onSubmit={submit}
			actions={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<Button type="submit" variant="primary" busy={busy}>
						Add grant
					</Button>
				</>
			}
		>
			<div className="flex w-(--kt-card-width) max-w-full flex-col gap-4 pt-2">
				<FormField id="grant-action" label="Rule">
					<SegmentedControl
						label="Rule"
						options={[
							{ value: "allow", label: "Allow" },
							{ value: "deny", label: "Deny" },
						]}
						value={action}
						onChange={setAction}
					/>
				</FormField>
				<TextField
					label="Host"
					hint="*.example.com covers every subdomain."
					value={host}
					onChange={(event) => setHost(event.currentTarget.value)}
					placeholder="api.github.com"
					mono
					spellCheck={false}
					{...(tried && hostError !== undefined ? { error: hostError } : {})}
				/>
				<FormField
					id={methodsId}
					label="Methods"
					hint="None ticked: every method. Naming methods or paths makes the proxy look inside this host's HTTPS."
				>
					<div className="flex flex-wrap gap-x-4 gap-y-2">
						{HTTP_METHODS.map((method) => (
							<CheckboxField
								key={method}
								label={method}
								checked={methods.includes(method)}
								onChange={(event) => {
									const on = event.currentTarget.checked;
									setMethods((current) =>
										HTTP_METHODS.filter((each) => (each === method ? on : current.includes(each))),
									);
								}}
							/>
						))}
					</div>
				</FormField>
				<TextField
					label="Paths"
					hint="Optional. Comma-separated; * matches one segment, ** the rest: /repos/lleverage-ai/**."
					value={paths}
					onChange={(event) => setPaths(event.currentTarget.value)}
					placeholder="/repos/lleverage-ai/**"
					mono
					spellCheck={false}
					{...(tried && pathError !== undefined ? { error: pathError } : {})}
				/>
			</div>
			{failure === undefined ? null : <p className="kt-dialog-error">{failure}</p>}
		</Dialog>
	);
}
