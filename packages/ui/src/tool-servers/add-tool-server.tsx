import {
	type CreatedToolServer,
	type CreateToolServerInput,
	TOOL_SERVER_TOOL_SEPARATOR,
	type ToolServer,
	type ToolServerTransport,
	toolServerNameProblem,
} from "@harbour/contracts";
import { type FormEvent, useState } from "react";
import { Button } from "../primitives/button.tsx";
import { SegmentedControl, SelectField, TextField } from "../primitives/controls.tsx";
import { FormActions, FormField, FormLayout } from "../primitives/form-layout.tsx";
import { Notice } from "../primitives/surface.tsx";
import type { ToolServerProject } from "./tool-servers-model.ts";
import { TunnelTokenReveal } from "./tunnel-token.tsx";

const ORGANISATION_SCOPE = "organisation";

const TRANSPORT_OPTIONS: readonly { value: ToolServerTransport; label: string; disabled?: boolean }[] = [
	{ value: "tunnel", label: "Tunnel" },
	{ value: "http", label: "HTTP, coming next", disabled: true },
];

/**
 * Add tool server: a name, who owns it, and how Harbour reaches it (a tunnel, for now). A tunnel server is made with
 * its first token, shown once with the command to run; the person says it's stored, then goes to the server's page.
 */
export function AddToolServer({
	organisation,
	projects,
	project,
	origin,
	onCreate,
	onDone,
	onCancel,
	initialCreated,
}: {
	organisation: string;
	/** The projects the person may add a server to. */
	projects: readonly ToolServerProject[];
	/** A project's page: the server is that project's, and the scope isn't asked. */
	project?: ToolServerProject | undefined;
	origin: string;
	onCreate: (input: CreateToolServerInput) => Promise<CreatedToolServer>;
	/** After the token is stored, or at once for a server with none. */
	onDone: (server: ToolServer) => void;
	onCancel: () => void;
	/** A server just made, its token on screen: for stories. */
	initialCreated?: CreatedToolServer | undefined;
}) {
	const [name, setName] = useState("");
	const [scope, setScope] = useState(project?.id ?? ORGANISATION_SCOPE);
	const [transport, setTransport] = useState<ToolServerTransport>("tunnel");
	const [checked, setChecked] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState<string>();
	const [created, setCreated] = useState(initialCreated);

	if (created?.token !== undefined) {
		return (
			<TunnelTokenReveal
				server={created.server}
				issued={created.token}
				origin={origin}
				onAcknowledge={() => onDone(created.server)}
			/>
		);
	}

	const problem = toolServerNameProblem(name);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		setChecked(true);
		if (problem !== undefined || busy) return;
		setBusy(true);
		setFailure(undefined);
		try {
			const made = await onCreate({
				name,
				transport,
				...(scope === ORGANISATION_SCOPE ? {} : { projectId: scope }),
			});
			if (made.token === undefined) onDone(made.server);
			else setCreated(made);
		} catch (caught) {
			setFailure(caught instanceof Error ? caught.message : "Harbour couldn't add the server. Try again.");
		} finally {
			setBusy(false);
		}
	};

	const example = `${name === "" ? "name" : name}${TOOL_SERVER_TOOL_SEPARATOR}search`;
	return (
		<form onSubmit={submit} noValidate className="max-w-content">
			<FormLayout>
				<TextField
					label="Name"
					name="name"
					mono
					autoComplete="off"
					spellCheck={false}
					// The person came to add a server; its name is the first thing it needs.
					autoFocus
					value={name}
					disabled={busy}
					onChange={(event) => setName(event.target.value.trim())}
					onBlur={() => setChecked(name !== "")}
					{...(checked && problem !== undefined
						? { error: problem }
						: {
								hint: `Lower-case letters, digits and hyphens. It starts each of its tools' names, as ${example}, and can't be changed.`,
							})}
				/>
				{project === undefined ? (
					<SelectField
						label="Scope"
						name="scope"
						value={scope}
						disabled={busy}
						onChange={(event) => setScope(event.target.value)}
						options={[
							{ value: ORGANISATION_SCOPE, label: `${organisation}, every project` },
							...projects.map((candidate) => ({ value: candidate.id, label: `${candidate.name} project` })),
						]}
						hint={
							scope === ORGANISATION_SCOPE
								? "Sessions in every project can use its tools."
								: "Only this project's sessions see it."
						}
					/>
				) : (
					<FormField id="hb-tool-server-scope" label="Scope" hint="Only this project's sessions see it.">
						<span className="text-sm text-fg">{project.name} project</span>
					</FormField>
				)}
				<FormField
					id="hb-tool-server-transport"
					label="Transport"
					hint="Tunnel: a small client next to your server dials out to Harbour, so nothing on your side is exposed. HTTP, for a public MCP server, is coming next."
				>
					<SegmentedControl label="Transport" options={TRANSPORT_OPTIONS} value={transport} onChange={setTransport} />
				</FormField>
				{failure === undefined ? null : <Notice level="error">{failure}</Notice>}
				<FormActions>
					<Button variant="primary" size="sm" type="submit" busy={busy}>
						Add tool server
					</Button>
					<Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
						Cancel
					</Button>
				</FormActions>
			</FormLayout>
		</form>
	);
}
