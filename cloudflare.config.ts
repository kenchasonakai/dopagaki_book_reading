import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "rsvp-reader",
		compatibilityDate: "2026-10-01",
		entrypoint,
		env: {
			// 本の置き場。デプロイ前に `npx cf r2 buckets create rsvp-books` で作る
			BOOKS: bindings.r2({ name: "rsvp-books" }),
		},
	},
});
