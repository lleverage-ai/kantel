import { HarbourError } from "@harbour/contracts";

/** `owner/name`, or a github.com URL, as `[owner, name]`; anything else is not a GitHub repository Harbour reads. */
export function gitHubRepo(repo: string): [string, string] {
	const match =
		/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo) ??
		/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repo);
	if (match === null || /^\.+$/.test(match[1]!) || /^\.+$/.test(match[2]!)) {
		throw new HarbourError("not_supported", `the GitHub fetcher cannot fetch ${repo}`, { repo });
	}
	return [match[1]!, match[2]!];
}
