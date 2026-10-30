import { useEffect, useState } from "react";

/** An object URL for some bytes, made once per bytes and revoked when they change or the body goes. */
export function useObjectUrl(bytes: Uint8Array, type: string): string | undefined {
	const [made, setMade] = useState<{ readonly bytes: Uint8Array; readonly url: string }>();
	useEffect(() => {
		const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
		setMade({ bytes, url });
		return () => URL.revokeObjectURL(url);
	}, [bytes, type]);
	return made !== undefined && made.bytes === bytes ? made.url : undefined;
}
