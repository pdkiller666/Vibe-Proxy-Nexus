/**
 * Serves the built React frontend from the same Express process.
 *
 * Used only in the all-in-one Amvera deployment, where the backend serves both
 * the API and the compiled frontend. Enabled by setting `STATIC_DIR` to the
 * directory containing the Vite build output (index.html + assets).
 *
 * In the Replit dev environment `STATIC_DIR` is unset, so this is a no-op and
 * the frontend is served by its own Vite dev server as before.
 */
import express, { type Express } from "express";
import path from "path";

export function mountStaticFrontend(app: Express): void {
  const dir = process.env["STATIC_DIR"];
  if (!dir) return;

  const indexHtml = path.join(dir, "index.html");

  app.use(express.static(dir));

  // SPA fallback: any non-API route serves index.html so client-side routing works.
  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/api")) {
      next();
      return;
    }
    res.sendFile(indexHtml);
  });
}
