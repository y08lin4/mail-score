import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootConfigPath = new URL("../wrangler.jsonc", import.meta.url);
const generatedConfigPath = new URL("../.wrangler.generated.jsonc", import.meta.url);
const schemaPath = new URL("../schema.sql", import.meta.url);
const wranglerEntrypoint = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));

function run(args, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerEntrypoint, ...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(`wrangler ${args.join(" ")} failed (${code}): ${stderr || stdout}`)));
    child.stdin.end(input);
  });
}

function parseJSON(output) {
  const match = output.match(/([\[{][\s\S]*[\]}])\s*$/);
  if (!match) throw new Error("Wrangler did not return JSON output.");
  return JSON.parse(match[1]);
}

async function jsonCommand(args) {
  return parseJSON(await run([...args, "--json"]));
}

async function ensureD1(name) {
  const databases = await jsonCommand(["d1", "list"]);
  const existing = databases.find((database) => database.name === name);
  if (existing) return existing.uuid || existing.id || existing.database_id;
  // Wrangler 4 supports JSON output for `d1 list`, but not for `d1 create`.
  // Create in its normal human-readable form, then retrieve the ID from the
  // authoritative JSON list rather than parsing terminal presentation text.
  await run(["d1", "create", name]);
  const created = (await jsonCommand(["d1", "list"])).find((database) => database.name === name);
  const id = created?.uuid || created?.id || created?.database_id;
  if (!id) throw new Error("D1 database was created but its ID could not be determined.");
  return id;
}

async function ensureSecret() {
  const secrets = await jsonCommand(["secret", "list"]);
  if (secrets.some((secret) => secret.name === "TOKEN_SECRET")) return;
  await run(["secret", "put", "TOKEN_SECRET"], randomBytes(32).toString("base64url"));
}

const base = JSON.parse(await readFile(rootConfigPath, "utf8"));
if (process.argv.includes("--dry-run")) {
  await run(["deploy", "--dry-run"]);
  process.exit(0);
}

const workerName = base.name;
const d1Name = `${workerName}-db`;
const databaseId = await ensureD1(d1Name);

const generated = {
  ...base,
  d1_databases: [{ binding: "DB", database_name: d1Name, database_id: databaseId }],
};
await writeFile(generatedConfigPath, `${JSON.stringify(generated, null, 2)}\n`);
await run(["deploy", "--config", ".wrangler.generated.jsonc"]);
await run(["d1", "execute", d1Name, "--remote", "--file", fileURLToPath(schemaPath)]);
await ensureSecret();
console.log("\nMail Score resources are ready. Set INBOUND_DOMAIN and attach the Email Routing rule to this Worker.");
