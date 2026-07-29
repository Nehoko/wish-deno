import { createApp } from "./app.ts";

const port = Number(Deno.env.get("PORT") ?? "8000");
const hostname = Deno.env.get("HOST") ?? "0.0.0.0";
const app = createApp();

console.log(JSON.stringify({
  level: "info",
  message: "Wish Deno listening",
  hostname,
  port,
}));

Deno.serve({ hostname, port }, app.handler);
