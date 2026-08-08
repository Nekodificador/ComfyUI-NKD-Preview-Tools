import { defineConfig } from "vite";

/**
 * Construye el widget de timeline en js/nkd_timeline.js.
 *
 * Sin Vue y sin plugin de CSS a propósito: el timeline es un canvas, y el CSS se inyecta
 * a mano como un <style> con id (ver src/timeline/styles.ts). Eso evita de raíz la trampa
 * de los scope-id de los SFC desincronizados que documenta la skill nkd-node.
 *
 * emptyOutDir: false es OBLIGATORIO — js/ contiene popup_preview.js y viewer.html, que
 * están escritos a mano y el build no debe tocar.
 */
export default defineConfig({
  build: {
    lib: {
      entry: "./src/main.ts",
      formats: ["es"],
      fileName: "nkd_timeline",
    },
    rollupOptions: {
      external: ["../../scripts/app.js", "../../scripts/api.js"],
      output: {
        dir: "js",
        entryFileNames: "nkd_timeline.js",
      },
    },
    emptyOutDir: false,
    sourcemap: false,
    minify: false, // legible para depurar
  },
});
