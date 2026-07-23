export default {
	extensions: {
		ts: "module",
	},
	files: [
		"test/**/*.test.ts",
	],
	nodeArguments: [
		"--import",
		"tsx/esm",
	],
};
