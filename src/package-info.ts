import { readFileSync } from "node:fs";

const { name, version, description, engines } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { name: string; version: string; description: string; engines: { node: string } };

export const packageInfo = { name, version, description, engines };
