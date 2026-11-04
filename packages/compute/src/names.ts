/**
 * What a person is called wherever the compute plane names them: the members list, "created by", event actors, a
 * personal account. Gateways once named everyone by their user ID (`usr_…`), and the records they made still carry
 * it, so a name that is only an ID is passed over at read time for the person's email.
 */

/** Whether `name` tells nobody who the person is: empty, their own user ID, or any user ID (`usr_…`). */
export function isPlaceholderName(name: string | undefined, userId?: string): boolean {
	const trimmed = name?.trim() ?? "";
	return trimmed === "" || trimmed === userId || trimmed.startsWith("usr_");
}

/** A person's name, else their email, else their user ID: never an ID while a name or email is known. */
export function personName(person: {
	readonly userId: string;
	readonly name?: string | undefined;
	readonly email?: string | undefined;
}): string {
	const name = person.name?.trim() ?? "";
	if (!isPlaceholderName(name, person.userId)) return name;
	const email = person.email?.trim() ?? "";
	return email === "" ? person.userId : email;
}
