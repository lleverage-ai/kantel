// Patches to just-bash's browser bundle, applied by the guest build (guest/build.ts) on top of the package patch
// (patches/just-bash@3.6.0.patch). Each pattern is matched against the minified bundle and must match exactly once:
// a just-bash upgrade that moves one fails the build rather than silently shipping without it. The same patch is
// in Lleverage's isolate guest; keep them in step.

/** The bundle these patches apply to. */
export const JUST_BASH_BROWSER_BUNDLE = /just-bash[\\/]dist[\\/]bundle[\\/]browser\.js$/;

function replaceOnce(
	source: string,
	pattern: RegExp,
	replacement: (...groups: string[]) => string,
	name: string,
): string {
	const matches = source.match(pattern) ?? [];
	if (matches.length !== 1) {
		throw new Error(
			`just-bash ${name} patch matched ${matches.length} times; review guest/just-bash-patches.ts for this just-bash version`,
		);
	}
	return source.replace(pattern, (...args) => replacement(...(args as string[])));
}

/**
 * just-bash 3.6 lets a filesystem error thrown while opening a redirection target (`echo x > /no/such/dir/f`) escape
 * `Bash.exec`, which abandons the rest of the script and its output. Real bash fails only that command. This turns
 * such an error into that command's stderr and exit status 1, through a hook the shell installs
 * (`globalThis.__justBashFsError(error)`, answering the message or undefined to rethrow).
 */
function redirectErrors(source: string): string {
	return replaceOnce(
		source,
		/catch\((\w+)\)\{if\((\w+)\?\.finish\(\),\1 instanceof (\w+)\)return (\w+)\(\1\.stderr\);throw \1\}\}async executeSimpleCommandInner/g,
		(_match, error, redirections, globError, failure) =>
			`catch(${error}){if(${redirections}?.finish(),${error} instanceof ${globError})return ${failure}(${error}.stderr);` +
			`{let __m=globalThis.__justBashFsError?.(${error});if(typeof __m=="string")return ${failure}(__m)}` +
			`throw ${error}}}async executeSimpleCommandInner`,
		"redirect-error",
	);
}

/** just-bash's browser bundle as the isolate runs it. */
export function patchJustBashBrowser(source: string): string {
	return redirectErrors(source);
}
