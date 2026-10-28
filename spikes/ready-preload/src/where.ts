/** Where the caller runs: the colo from Cloudflare's trace endpoint. Never called inside a timed phase. */
export async function where(): Promise<{ colo: string | undefined }> {
	const trace = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
	return { colo: /^colo=(.+)$/m.exec(trace)?.[1] };
}
