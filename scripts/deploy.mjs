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

async function createIfMissing(args) {
  try {
    await run(args);
  } catch (error) {
    const message = String(error).toLowerCase();
    if (!message.includes("already exists") && !message.includes("already taken")) throw error;
  }
}

async function ensureD1(name) {
  const databases = await jsonCommand(["d1", "list"]);
  const existing = databases.find((database) => database.name === name);
  if (existing) return existing.uuid || existing.id || existing.database_id;
  const created = await jsonCommand(["d1", "create", name]);
  const id = created.uuid || created.id || created.database_id;
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
const bucketName = `${workerName}-raw-mail`;
const queueName = `${workerName}-analyze`;
const databaseId = await ensureD1(d1Name);
await createIfMissing(["r2", "bucket", "create", bucketName]);
await createIfMissing(["queues", "create", queueName]);

const generated = {
  ...base,
  d1_databases: [{ binding: "DB", database_name: d1Name, database_id: databaseId }],
  r2_buckets: [{ binding: "RAW_MAIL", bucket_name: bucketName }],
  queues: {
    producers: [{ binding: "ANALYZE_QUEUE", queue: queueName }],
    consumers: [{ queue: queueName, max_batch_size: 10, max_batch_timeout: 10, max_retries: 3 }],
  },
  ratelimits: [
    { name: "CREATE_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } },
    { name: "READ_LIMITER", namespace_id: "1002", simple: { limit: 30, period: 60 } },
  ],
};
await writeFile(generatedConfigPath, `${JSON.stringify(generated, null, 2)}\n`);
await run(["deploy", "--config", ".wrangler.generated.jsonc"]);
await run(["d1", "execute", d1Name, "--remote", "--file", fileURLToPath(schemaPath)]);
await ensureSecret();
console.log("\nMail Score resources are ready. Set INBOUND_DOMAIN and attach the Email Routing rule to this Worker.");
