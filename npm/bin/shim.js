#!/usr/bin/env node
/**
 * `npx veritap-locker` — stdio MCP shim for clients that can't speak
 * Streamable HTTP. Bridges stdio <-> https://locker.veritap.dev/mcp via
 * mcp-remote. Any extra args are passed through.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require.resolve("mcp-remote/package.json");
const binRel = require(pkg).bin["mcp-remote"];
const proxy = new URL(binRel, `file://${pkg.slice(0, pkg.lastIndexOf("/") + 1)}`).pathname;

const child = spawn(process.execPath, [proxy, "https://locker.veritap.dev/mcp", ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
