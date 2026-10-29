// Components import their own stylesheet; Vite (and Ladle) bundle it.
declare module "*.css";
// A Vite asset as its URL, such as pdf.js's worker (`presented/pdf-view.tsx`).
declare module "*?url" {
	const url: string;
	export default url;
}
