import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const aiProxyTarget = process.env.LILTCALL_AI_PROXY_TARGET ?? "http://127.0.0.1:7860";
if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(aiProxyTarget)) {
  throw new Error("LILTCALL_AI_PROXY_TARGET must be a loopback HTTP endpoint");
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL("../../dist/web", import.meta.url)),
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5187,
    strictPort: true,
    proxy: {
      "/ai-api": {
        target: aiProxyTarget,
        rewrite: (path) => path.replace(/^\/ai-api/, ""),
      },
    },
  },
});
