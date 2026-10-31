import { KantelError } from "@kantel/contracts";

/** `owner/name`, or a github.com URL, as `[owner, name]`; anything else is not a GitHub repository Kantel reads. */
export function gitHubRepo(repo: string): [string, string] {
	const match =
		/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repo) ??
		/^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(repo);
	if (match === null || /^\.+$/.test(match[1]!) || /^\.+$/.test(match[2]!)) {
		throw new KantelError("not_supported", `the GitHub fetcher cannot fetch ${repo}`, { repo });
	}
	return [match[1]!, match[2]!];
}
