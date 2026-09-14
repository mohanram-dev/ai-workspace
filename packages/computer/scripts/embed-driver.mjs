// Regenerates src/drivers/windows-driver-script.ts from windows-driver.ps1.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../src/drivers/", import.meta.url));
const ps = readFileSync(`${dir}windows-driver.ps1`, "utf8");
const b64 = Buffer.from(ps, "utf8").toString("base64");
writeFileSync(
  `${dir}windows-driver-script.ts`,
  `// Auto-generated from windows-driver.ps1 (base64) so the driver ships inside the\n// bundle without a separate asset file. Regenerate with scripts/embed-driver.\nexport const WINDOWS_DRIVER_SCRIPT = Buffer.from(\n  "${b64}",\n  "base64",\n).toString("utf8");\n`,
);
console.log("Embedded", b64.length, "base64 chars.");
