/**
 * Único punto de acceso al runtime de ComfyUI.
 *
 * OJO con el literal de la ruta: estos módulos van marcados como `external` en el
 * vite.config, así que Rollup **conserva la cadena tal cual** en el bundle. El bundle se
 * sirve plano en `/extensions/<pack>/nkd_timeline.js`, luego `../../scripts/app.js`
 * resuelve a `/scripts/app.js`. Escribir `../../../scripts/...` porque el fichero fuente
 * esté un nivel más hondo emite ESE literal y da 404 en el navegador — la profundidad del
 * fuente es irrelevante, manda la del fichero generado.
 *
 * Centralizarlo aquí también deja los `@ts-ignore` en un solo sitio: TypeScript no puede
 * resolver estas rutas porque el fichero no existe en disco desde el repo.
 */
// @ts-ignore -- lo sirve ComfyUI en runtime
export { app } from "../../scripts/app.js";
// @ts-ignore -- lo sirve ComfyUI en runtime
export { api } from "../../scripts/api.js";
