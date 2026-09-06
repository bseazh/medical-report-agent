import { access } from "node:fs/promises";
const required = ["MINERU_API_TOKEN", "DEEPSEEK_API_KEY"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}
await access("server.mjs");
console.log("Environment check passed");
