import type { PresentedFile, ToolItem, TranscriptItem } from "@harbour/protocol";
import { assistant, tool, user } from "./fixtures.ts";

// A turn that made four posters with generate_image and presented them (present_files): the transcript as a session
// left it on 30 Oct 2026, for the stories and the tool renderer registry's screenshots. Each poster is a small SVG in
// the shape gpt-image makes a portrait (2:3), base64 encoded, so the library needs no image assets: an isometric
// box ("BACK OFFICE"), a screen-print skyline ("LOGISTICS HUB"), a Bauhaus tower (READS, DECIDES, LEARNS, ACTS) and
// a neon warehouse ("NIGHT SHIFT").

const svg = (base64: string): string => `data:image/svg+xml;base64,${base64}`;

const POSTERS: readonly { readonly slug: string; readonly picture: string }[] = [
	{
		slug: "poster-illustration-dark-navy-background-with-mvv1x9uw",
		picture: svg(
			"PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MTIiIGhlaWdodD0iNzY4IiB2aWV3Qm94PSIw" +
				"IDAgNTEyIDc2OCI+PHJlY3Qgd2lkdGg9IjUxMiIgaGVpZ2h0PSI3NjgiIGZpbGw9IiMxMzIxM2YiLz48cG9seWdvbiBwb2ludHM9" +
				"IjI1NiwyNTAgMzk2LDMzMCAyNTYsNDEwIDExNiwzMzAiIGZpbGw9IiNmMDdhMmEiLz48cG9seWdvbiBwb2ludHM9IjExNiwzMzAg" +
				"MjU2LDQxMCAyNTYsNTQwIDExNiw0NjAiIGZpbGw9IiNjNDVhMTciLz48cG9seWdvbiBwb2ludHM9IjM5NiwzMzAgMjU2LDQxMCAy" +
				"NTYsNTQwIDM5Niw0NjAiIGZpbGw9IiNlMmU4ZjUiLz48cmVjdCB4PSIzMDAiIHk9IjE2MCIgd2lkdGg9IjYwIiBoZWlnaHQ9IjQw" +
				"IiByeD0iNiIgZmlsbD0iI2UyZThmNSIgdHJhbnNmb3JtPSJyb3RhdGUoLTEyIDMzMCAxODApIi8+PHJlY3QgeD0iMTQwIiB5PSIx" +
				"OTAiIHdpZHRoPSI1NCIgaGVpZ2h0PSIzNiIgcng9IjYiIGZpbGw9IiNmMDdhMmEiIHRyYW5zZm9ybT0icm90YXRlKDEwIDE2NyAy" +
				"MDgpIi8+PHRleHQgeD0iMjU2IiB5PSI2NDAiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJIZWx2ZXRpY2EsIEFy" +
				"aWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjQ4IiBmb250LXdlaWdodD0iODAwIiBmaWxsPSIjZTJlOGY1Ij5CQUNLIE9GRklD" +
				"RTwvdGV4dD48dGV4dCB4PSIyNTYiIHk9IjY5MCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9IkhlbHZldGljYSwg" +
				"QXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjgiIGZvbnQtd2VpZ2h0PSI1MDAiIGZpbGw9IiNmMDdhMmEiPnJ1bnMgaXRz" +
				"ZWxmPC90ZXh0Pjwvc3ZnPg==",
		),
	},
	{
		slug: "retro-1960s-screen-print-travel-poster-mvv1xc4c",
		picture: svg(
			"PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MTIiIGhlaWdodD0iNzY4IiB2aWV3Qm94PSIw" +
				"IDAgNTEyIDc2OCI+PGRlZnM+PHBhdHRlcm4gaWQ9ImRvdHMiIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCIgcGF0dGVyblVuaXRzPSJ1" +
				"c2VyU3BhY2VPblVzZSI+PGNpcmNsZSBjeD0iNSIgY3k9IjUiIHI9IjIiIGZpbGw9IiNkOWM3YTAiLz48L3BhdHRlcm4+PC9kZWZz" +
				"PjxyZWN0IHdpZHRoPSI1MTIiIGhlaWdodD0iNzY4IiBmaWxsPSIjZjNlNmM4Ii8+PHJlY3Qgd2lkdGg9IjUxMiIgaGVpZ2h0PSI3" +
				"NjgiIGZpbGw9InVybCgjZG90cykiIG9wYWNpdHk9IjAuNiIvPjxjaXJjbGUgY3g9IjI1NiIgY3k9IjI1MCIgcj0iMTIwIiBmaWxs" +
				"PSIjZTg2NDJjIi8+PHJlY3QgeD0iMCIgeT0iMzgwIiB3aWR0aD0iNTEyIiBoZWlnaHQ9IjIwMCIgZmlsbD0iIzFmNGU1ZiIvPjxy" +
				"ZWN0IHg9IjgwIiB5PSIzMzAiIHdpZHRoPSI5MCIgaGVpZ2h0PSI5MCIgZmlsbD0iIzJjNmI3ZiIvPjxyZWN0IHg9IjIwMCIgeT0i" +
				"MzAwIiB3aWR0aD0iMTIwIiBoZWlnaHQ9IjEyMCIgZmlsbD0iIzJjNmI3ZiIvPjxyZWN0IHg9IjM1MCIgeT0iMzQwIiB3aWR0aD0i" +
				"ODAiIGhlaWdodD0iODAiIGZpbGw9IiMyYzZiN2YiLz48dGV4dCB4PSIyNTYiIHk9IjY1MCIgdGV4dC1hbmNob3I9Im1pZGRsZSIg" +
				"Zm9udC1mYW1pbHk9IkhlbHZldGljYSwgQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iNDQiIGZvbnQtd2VpZ2h0PSI4MDAi" +
				"IGZpbGw9IiMxZjRlNWYiPkxPR0lTVElDUyBIVUI8L3RleHQ+PHRleHQgeD0iMjU2IiB5PSI3MDAiIHRleHQtYW5jaG9yPSJtaWRk" +
				"bGUiIGZvbnQtZmFtaWx5PSJIZWx2ZXRpY2EsIEFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjI0IiBmb250LXdlaWdodD0i" +
				"NjAwIiBmaWxsPSIjZTg2NDJjIj5WaXNpdCB0aGUgZnV0dXJlIG9mIHdvcms8L3RleHQ+PC9zdmc+",
		),
	},
	{
		slug: "minimalist-geometric-bauhaus-style-poster-a-mvv1x3f7",
		picture: svg(
			"PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MTIiIGhlaWdodD0iNzY4IiB2aWV3Qm94PSIw" +
				"IDAgNTEyIDc2OCI+PHJlY3Qgd2lkdGg9IjUxMiIgaGVpZ2h0PSI3NjgiIGZpbGw9IiNlZmU5ZGMiLz48cmVjdCB4PSI5NiIgeT0i" +
				"MTIwIiB3aWR0aD0iMzIwIiBoZWlnaHQ9IjkwIiBmaWxsPSIjZDIzYzJhIi8+PHRleHQgeD0iMjU2IiB5PSIxODIiIHRleHQtYW5j" +
				"aG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJIZWx2ZXRpY2EsIEFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjQ0IiBmb250" +
				"LXdlaWdodD0iODAwIiBmaWxsPSIjZWZlOWRjIj5SRUFEUzwvdGV4dD48cmVjdCB4PSI5NiIgeT0iMjIwIiB3aWR0aD0iMzIwIiBo" +
				"ZWlnaHQ9IjkwIiBmaWxsPSIjZjJiNjMyIi8+PHRleHQgeD0iMjU2IiB5PSIyODIiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQt" +
				"ZmFtaWx5PSJIZWx2ZXRpY2EsIEFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjQ0IiBmb250LXdlaWdodD0iODAwIiBmaWxs" +
				"PSIjMWMxYzFjIj5ERUNJREVTPC90ZXh0PjxyZWN0IHg9Ijk2IiB5PSIzMjAiIHdpZHRoPSIzMjAiIGhlaWdodD0iOTAiIGZpbGw9" +
				"IiMyYTViYTgiLz48dGV4dCB4PSIyNTYiIHk9IjM4MiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9IkhlbHZldGlj" +
				"YSwgQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iNDQiIGZvbnQtd2VpZ2h0PSI4MDAiIGZpbGw9IiNlZmU5ZGMiPkxFQVJO" +
				"UzwvdGV4dD48cmVjdCB4PSI5NiIgeT0iNDIwIiB3aWR0aD0iMzIwIiBoZWlnaHQ9IjkwIiBmaWxsPSIjMWMxYzFjIi8+PHRleHQg" +
				"eD0iMjU2IiB5PSI0ODIiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJIZWx2ZXRpY2EsIEFyaWFsLCBzYW5zLXNl" +
				"cmlmIiBmb250LXNpemU9IjQ0IiBmb250LXdlaWdodD0iODAwIiBmaWxsPSIjZWZlOWRjIj5BQ1RTPC90ZXh0Pjx0ZXh0IHg9IjI1" +
				"NiIgeT0iNjEwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlseT0iSGVsdmV0aWNhLCBBcmlhbCwgc2Fucy1zZXJpZiIg" +
				"Zm9udC1zaXplPSIyNiIgZm9udC13ZWlnaHQ9IjYwMCIgZmlsbD0iIzFjMWMxYyI+Tm9ib2R5IGNsb2NrZWQgaW4uPC90ZXh0Pjx0" +
				"ZXh0IHg9IjI1NiIgeT0iNjUwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlseT0iSGVsdmV0aWNhLCBBcmlhbCwgc2Fu" +
				"cy1zZXJpZiIgZm9udC1zaXplPSIyNiIgZm9udC13ZWlnaHQ9IjYwMCIgZmlsbD0iIzFjMWMxYyI+RXZlcnl0aGluZyBnb3QgZG9u" +
				"ZS48L3RleHQ+PC9zdmc+",
		),
	},
	{
		slug: "cinematic-neon-noir-illustration-wide-night-mvv1x677",
		picture: svg(
			"PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MTIiIGhlaWdodD0iNzY4IiB2aWV3Qm94PSIw" +
				"IDAgNTEyIDc2OCI+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJza3kiIHgxPSIwIiB5MT0iMCIgeDI9IjAiIHkyPSIxIj48c3Rv" +
				"cCBvZmZzZXQ9IjAiIHN0b3AtY29sb3I9IiMxMjBhMmEiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMzYTE0NTAiLz48" +
				"L2xpbmVhckdyYWRpZW50PjwvZGVmcz48cmVjdCB3aWR0aD0iNTEyIiBoZWlnaHQ9Ijc2OCIgZmlsbD0idXJsKCNza3kpIi8+PHJl" +
				"Y3QgeD0iNDAiIHk9IjMwMCIgd2lkdGg9IjQzMiIgaGVpZ2h0PSIyMjAiIGZpbGw9IiMxYjEwMzMiIHN0cm9rZT0iI2ZmM2ZhNCIg" +
				"c3Ryb2tlLXdpZHRoPSI0Ii8+PHJlY3QgeD0iODAiIHk9IjM2MCIgd2lkdGg9IjgwIiBoZWlnaHQ9IjE2MCIgZmlsbD0iIzBmMDgy" +
				"MCIgc3Ryb2tlPSIjMzhlMWZmIiBzdHJva2Utd2lkdGg9IjMiLz48cmVjdCB4PSIyMDAiIHk9IjM2MCIgd2lkdGg9IjgwIiBoZWln" +
				"aHQ9IjE2MCIgZmlsbD0iIzBmMDgyMCIgc3Ryb2tlPSIjMzhlMWZmIiBzdHJva2Utd2lkdGg9IjMiLz48cmVjdCB4PSIzMjAiIHk9" +
				"IjM2MCIgd2lkdGg9IjExMCIgaGVpZ2h0PSIxNjAiIGZpbGw9IiMwZjA4MjAiIHN0cm9rZT0iIzM4ZTFmZiIgc3Ryb2tlLXdpZHRo" +
				"PSIzIi8+PHJlY3QgeD0iMCIgeT0iNTIwIiB3aWR0aD0iNTEyIiBoZWlnaHQ9IjI0OCIgZmlsbD0iIzBiMDYxOCIvPjxsaW5lIHgx" +
				"PSI0MCIgeTE9IjU2MCIgeDI9IjQ3MiIgeTI9IjU2MCIgc3Ryb2tlPSIjZmYzZmE0IiBzdHJva2Utd2lkdGg9IjIiIG9wYWNpdHk9" +
				"IjAuNiIvPjxsaW5lIHgxPSI4MCIgeTE9IjYwMCIgeDI9IjQzMiIgeTI9IjYwMCIgc3Ryb2tlPSIjMzhlMWZmIiBzdHJva2Utd2lk" +
				"dGg9IjIiIG9wYWNpdHk9IjAuNSIvPjx0ZXh0IHg9IjI1NiIgeT0iNjgwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWls" +
				"eT0iSGVsdmV0aWNhLCBBcmlhbCwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSI1MCIgZm9udC13ZWlnaHQ9IjgwMCIgZmlsbD0iI2Zm" +
				"M2ZhNCI+TklHSFQgU0hJRlQ8L3RleHQ+PHRleHQgeD0iMjU2IiB5PSI3MjAiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFt" +
				"aWx5PSJIZWx2ZXRpY2EsIEFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjIyIiBmb250LXdlaWdodD0iNTAwIiBmaWxsPSIj" +
				"MzhlMWZmIj50aGUgd2FyZWhvdXNlIG5ldmVyIHNsZWVwczwvdGV4dD48L3N2Zz4=",
		),
	},
];

/** The four posters as the files `present_files` presented. */
export const posterFiles: readonly PresentedFile[] = POSTERS.map(({ slug }) => ({
	workspaceId: "ws-posters",
	path: `images/${slug}.png`,
	name: `${slug}.png`,
	mimeType: "image/png",
	size: 1_600_000,
}));

/** A story's `previewImage`: each poster's picture, after a moment, as a host reading the workspace would. */
export function previewPoster(file: PresentedFile): Promise<string | undefined> {
	const picture = POSTERS.find(({ slug }) => file.name === `${slug}.png`)?.picture;
	return new Promise((resolve) => setTimeout(() => resolve(picture), 120));
}

const generate = (id: string, prompt: string, secondsAgo: number): ToolItem =>
	tool(id, "generate_image", "Calling generate_image", {
		args: { prompt, aspect: "portrait" },
		output: "Saved the image. It is too large to show here.",
		seconds: 7,
		secondsAgo,
	});

const presenting: ToolItem = {
	...tool("t-present", "present_files", "Presenting 4 files", {
		args: { filepaths: posterFiles.map((file) => `/workspace/${file.path}`) },
		output: "Presented 4 files",
		seconds: 0.2,
		secondsAgo: 128,
	}),
	files: posterFiles,
};

/** The turn: four images made, a thought, the four presented, and the answer about them. */
export const posterTurn: readonly TranscriptItem[] = [
	user("u-posters", "Make me four more poster iterations, each with a different image model.", 200),
	assistant(
		"a-posters-plan",
		"I can't choose the image model, because this tool has no model parameter. I'll generate 4 distinct variations instead, each taking a different stylistic direction on the theme.",
		{ secondsAgo: 190 },
	),
	generate("t-gen-1", "Isometric flat vector poster, navy and orange", 185),
	generate("t-gen-2", "Retro 1960s screen-print travel poster", 177),
	generate("t-gen-3", "Minimalist geometric Bauhaus poster", 169),
	generate("t-gen-4", "Cinematic neon-noir illustration, wide night", 161),
	assistant("a-posters-thought", "", { thinking: "All four are saved; present them together.", secondsAgo: 130 }),
	presenting,
	assistant(
		"a-posters-answer",
		"I generated 4 new poster iterations. They all came from the same model, `gpt-image-2.5-flare`, because the image tool has no model option. They differ in style, not in model.\n\n1. **Isometric flat vector.** Navy and orange, with flying documents and delivery drones.\n2. **Retro screen-print.** A 1960s travel-poster look with halftone grain, a logistics hub and an orange moon.\n3. **Bauhaus geometric.** A block tower labelled READS / DECIDES / LEARNS / ACTS.\n4. **Neon-noir cinematic.** A wide night view of a warehouse with robot arms and forklifts.",
		{ secondsAgo: 120 },
	),
];
