/**
 * Connections in memory: records in a memory repository and secrets in a memory credential store. For tests, and for
 * a deployment with no database and no vault.
 */
import { KantelError } from "@kantel/contracts";
import type { CredentialStore, SecretOwner } from "./ports.ts";
import { createMemoryConnectionsRepository } from "./repository.ts";
import { type ConnectionsOptions, type ConnectionsService, createConnections } from "./service.ts";

export interface MemoryCredentialStore extends CredentialStore {
	/** Test only: every value ever opened, by ref, and what each holds now. Never for production use. */
	readonly inspect: () => ReadonlyMap<
		string,
		{ readonly owner: SecretOwner; readonly hosts: readonly string[]; readonly value?: string }
	>;
	readonly opened: { readonly ref: string; readonly host: string; readonly purpose: string }[];
}

export function memoryCredentials(): MemoryCredentialStore {
	const items = new Map<string, { owner: SecretOwner; hosts: readonly string[]; value?: string }>();
	const opened: { ref: string; host: string; purpose: string }[] = [];
	let next = 0;
	return {
		inspect: () => items,
		opened,
		async put(input) {
			next += 1;
			const ref = `item_${next}`;
			items.set(ref, { owner: input.owner, hosts: [...input.hosts], value: input.value });
			return ref;
		},
		async replace(ref, value) {
			const item = items.get(ref);
			if (item === undefined) throw new KantelError("not_found", `No item ${ref}`);
			item.value = value;
		},
		async open(input) {
			const item = items.get(input.ref);
			if (item === undefined || item.value === undefined)
				throw new KantelError("refused", `Item ${input.ref} has no value`);
			if (!item.hosts.includes(input.host))
				throw new KantelError("refused", `Item ${input.ref} is not bound to ${input.host}`);
			if (item.owner.kind !== "platform" && item.owner.organisationId !== input.organisationId) {
				throw new KantelError("refused", `Item ${input.ref} belongs to another organisation`);
			}
			opened.push({ ref: input.ref, host: input.host, purpose: input.purpose });
			return item.value;
		},
		async remove(ref) {
			const item = items.get(ref);
			if (item !== undefined) delete item.value;
		},
		async find(input) {
			const found: string[] = [];
			for (const ref of new Set(input.refs)) {
				const item = items.get(ref);
				if (item?.value === undefined || item.value.length < 8) continue;
				if (item.owner.kind !== "platform" && item.owner.organisationId !== input.organisationId) continue;
				const value = item.value;
				const forms = [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)];
				if (input.texts.some((text) => forms.some((form) => text.includes(form)))) found.push(ref);
			}
			return found;
		},
	};
}

export function createMemoryConnections(
	options: Omit<ConnectionsOptions, "repository" | "credentials"> & { readonly credentials?: CredentialStore },
): ConnectionsService {
	return createConnections({
		...options,
		repository: createMemoryConnectionsRepository(),
		credentials: options.credentials ?? memoryCredentials(),
	});
}
