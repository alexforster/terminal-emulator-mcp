import { readFileSync } from "node:fs";

const { name, version, description } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { name: string; version: string; description: string };

export const packageInfo = { name, version, description };
