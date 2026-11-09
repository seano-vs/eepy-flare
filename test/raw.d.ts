// Vite's ?raw imports (used by tests to read a file's source as a string).
declare module "*?raw" {
	const content: string;
	export default content;
}
