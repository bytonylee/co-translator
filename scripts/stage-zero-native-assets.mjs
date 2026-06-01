import fs from "node:fs";
import path from "node:path";

const distDir = path.resolve("dist");
const rendererDir = path.join(distDir, "renderer");

for (const dirname of ["backend", "backend-go", "shared"]) {
  const source = path.join(distDir, dirname);
  if (!fs.existsSync(source)) continue;
  const destination = path.join(rendererDir, dirname);
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
}
