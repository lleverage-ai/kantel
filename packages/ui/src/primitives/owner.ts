// Who owns a record, in words: the scope a schedule, skill or memory space belongs to. Shared by the schedules, skills
// and memory pages so each says it the same way.

import type { OwnerRef } from "@harbour/contracts";

/** Names from the host's identity directory. Absent or undefined falls back to the ID. */
export interface OwnerNames {
	person?(userId: string): string | undefined;
	project?(projectId: string): string | undefined;
}

export type OwnerScope = OwnerRef["kind"];

/** The scopes in the order pages list them: the widest first. */
export const OWNER_SCOPES: readonly OwnerScope[] = ["platform", "organisation", "project", "user"];

/** "Platform", "Organisation", "Billing project", "Tom Davies". */
export function ownerName(owner: OwnerRef, names: OwnerNames = {}): string {
	switch (owner.kind) {
		case "platform":
			return "Platform";
		case "organisation":
			return "Organisation";
		case "project":
			return `${names.project?.(owner.projectId) ?? owner.projectId} project`;
		case "user":
			return names.person?.(owner.userId) ?? owner.userId;
	}
}

/** A stable key per owner, for grouping. */
export function ownerKey(owner: OwnerRef): string {
	switch (owner.kind) {
		case "platform":
		case "organisation":
			return owner.kind;
		case "project":
			return `project:${owner.projectId}`;
		case "user":
			return `user:${owner.userId}`;
	}
}
