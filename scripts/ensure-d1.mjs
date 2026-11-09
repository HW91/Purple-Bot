// Finds the "purple-bot-db" D1 database in your Cloudflare account (creating it the first time)
// and writes its id into wrangler.jsonc on the build machine, so nobody has to paste an id.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const NAME = "purple-bot-db";
const run = (args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
const find = () => {
  const out = run(["d1", "list", "--json"]);
  // wrangler may print a banner line before the JSON, so take just the [...] part
  const list = JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1));
  return list.find((d) => d.name === NAME)?.uuid;
};

let id;
try {
  id = find();
} catch (e) {
  console.error("\nCould not talk to Cloudflare. Check the GitHub secrets CLOUDFLARE_API_TOKEN (needs Workers + D1 edit permission) and CLOUDFLARE_ACCOUNT_ID (the 32-character Account ID).");
  throw e;
}
if (!id) {
  console.log(`Creating D1 database ${NAME}…`);
  run(["d1", "create", NAME]);
  id = find();
}
if (!id) throw new Error(`Could not find or create the D1 database ${NAME}`);

const file = new URL("../wrangler.jsonc", import.meta.url);
const text = fs.readFileSync(file, "utf8");
const next = text.replace(/("database_id":\s*")[^"]*(")/, `$1${id}$2`);
if (next === text && !text.includes(id)) throw new Error("Could not update database_id in wrangler.jsonc");
fs.writeFileSync(file, next);
console.log(`Using D1 database ${NAME} (${id})`);
