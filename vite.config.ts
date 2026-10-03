import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

// public/ のファイル（app.js, style.css など）はそのまま静的アセットとして配信される
export default defineConfig({
	plugins: [cloudflare()],
});
