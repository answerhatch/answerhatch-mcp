#!/usr/bin/env node
// answerhatch-mcp: the AnswerHatch self-serve onboarding API as MCP tools, so
// an agent can take a customer from sign-in to a live answer box without a
// console and without an operator. Every tool is a thin client of
// https://api.answerhatch.com/api/v1; the ordering rules the API enforces
// (register a domain, publish the TXT record, then crawl) are stated in the
// tool descriptions, because the agent reading them is the one that has to
// follow them.

import { pathToFileURL } from "node:url";
import { z } from "zod";

const DEFAULT_API = "https://api.answerhatch.com";
const NO_AUTH =
  "not signed in: call answerhatch_login first, or start this server with " +
  "ANSWERHATCH_TOKEN set in its environment";

// The bearer token for this stdio session. Memory only: never written to
// disk, never logged, never returned in tool output.
let sessionToken = "";

/** Forget the session token. Exported for tests and for re-login. */
export function resetSession() {
  sessionToken = "";
}

class ToolError extends Error {}

function apiBase() {
  return (process.env.ANSWERHATCH_API || DEFAULT_API).replace(/\/+$/, "");
}

function bearer() {
  return sessionToken || process.env.ANSWERHATCH_TOKEN || "";
}

// Last line of defence on output: a token must not reach the transcript even
// if a future edit puts an API response body somewhere it does not belong.
function scrub(text) {
  const secret = bearer();
  return secret ? text.split(secret).join("[redacted]") : text;
}

async function call(method, path, { body, auth = true } = {}) {
  const headers = { "content-type": "application/json" };
  if (auth) {
    const token = bearer();
    if (!token) throw new ToolError(NO_AUTH);
    headers.authorization = "Bearer " + token;
  }
  let res;
  try {
    res = await fetch(apiBase() + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ToolError(
      "cannot reach the AnswerHatch API at " + apiBase() + ": " + err.message
    );
  }
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data: data && typeof data === "object" ? data : {} };
}

function fault(data, status, fallback) {
  // The API's own error string is the useful one; the status code is only a
  // fallback for a body that did not carry one.
  return new ToolError(data.error || fallback + " (HTTP " + status + ")");
}

function recordBlock(record, type, value) {
  return [
    "  name:  " + record,
    "  type:  " + (type || "TXT"),
    "  value: " + value,
  ].join("\n");
}

// ----- tool bodies -----

async function login({ email, password }) {
  const { status, data } = await call("POST", "/api/v1/login", {
    body: { email, password },
    auth: false,
  });
  if (status !== 200 || !data.token) throw fault(data, status, "login failed");
  sessionToken = data.token;
  return (
    "Signed in as " + email + " at " + apiBase() + ".\n" +
    "The token is held in memory for this session and is never shown in tool " +
    "output. Continue with answerhatch_create_tenant."
  );
}

async function createTenant({ domain, pages }) {
  const body = { domain };
  if (pages !== undefined && pages !== null) body.pages = pages;
  const { status, data } = await call("POST", "/api/v1/tenants", { body });
  if (status !== 200 || !data.tenant_id) {
    throw fault(data, status, "could not register that domain");
  }
  const verify = data.verify || {};
  return [
    "Tenant " + data.tenant_id + " registered for " + domain + ".",
    "",
    "The crawl has not started. Prove domain control first: publish this DNS " +
      "record at whoever hosts DNS for " + domain + ".",
    recordBlock(verify.record, verify.type, verify.value),
    "",
    "Leave TTL at the provider default. The record is usually visible within " +
      "a few minutes.",
    "Then call answerhatch_start_crawl with tenant_id \"" + data.tenant_id + "\".",
  ].join("\n");
}

async function startCrawl({ tenant_id }) {
  const path = "/api/v1/tenants/" + encodeURIComponent(tenant_id) + "/crawl";
  const { status, data } = await call("POST", path);
  if (status === 409) {
    // Expected, not a failure: the record is missing or has not propagated.
    // Returned as ordinary content so the agent acts on it rather than
    // treating the step as broken.
    return [
      "Not started: " + (data.error || "domain not verified") + ".",
      "",
      "Publish this record, then retry answerhatch_start_crawl:",
      recordBlock(data.record, data.type, data.value),
      "",
      "If it is already published, DNS has not propagated yet. Wait a minute " +
        "and call answerhatch_start_crawl again. Do not register the domain " +
        "a second time.",
    ].join("\n");
  }
  if (status !== 202) throw fault(data, status, "could not start the crawl");
  return (
    "Crawl queued for tenant " + tenant_id + ".\n" +
    "It runs in the background. Poll answerhatch_status every 20 to 30 " +
    "seconds until the stage reads live."
  );
}

async function tenantStatus({ tenant_id }) {
  const path = "/api/v1/tenants/" + encodeURIComponent(tenant_id);
  const { status, data } = await call("GET", path);
  if (status !== 200) throw fault(data, status, "could not read that tenant");
  const lines = [
    "Tenant " + tenant_id,
    "  stage:         " + (data.stage || "unknown"),
    "  phase:         " + (data.phase || "idle"),
    "  pages crawled: " + (data.pages_crawled ?? 0),
    "  verified:      " + (data.verified ? "yes" : "no"),
  ];
  if (data.detail) lines.push("  detail:        " + data.detail);
  lines.push("");
  if (data.snippet) {
    lines.push("Live. Paste this snippet into the site:", "", data.snippet, "");
    if (data.instructions) lines.push(data.instructions);
  } else if (!data.verified && (data.phase || "idle") === "idle") {
    lines.push(
      "Next: publish the TXT record from answerhatch_create_tenant, then call " +
        "answerhatch_start_crawl."
    );
  } else if (data.phase === "failed") {
    lines.push("The crawl failed. Call answerhatch_start_crawl again to retry.");
  } else if (["queued", "planning", "running"].includes(data.phase)) {
    lines.push("Crawl in progress. Poll again in 20 to 30 seconds.");
  } else {
    lines.push("Next: call answerhatch_start_crawl if no crawl has run yet.");
  }
  return lines.join("\n");
}

// ----- tool table -----

const TENANT_ARG = {
  tenant_id: z.string().describe("tenant id returned by answerhatch_create_tenant"),
};

export const TOOLS = [
  {
    name: "answerhatch_login",
    title: "Sign in to AnswerHatch",
    description:
      "Sign in and hold the bearer token for the rest of this session. Call " +
      "this once before any other answerhatch tool. Skip it when the server " +
      "was started with ANSWERHATCH_TOKEN set. This tool does not create " +
      "accounts: sign up first at answerhatch.com/signup. Never print the " +
      "password back to the user.",
    inputSchema: {
      email: z.string().describe("account email address"),
      password: z.string().describe("account password"),
    },
    impl: login,
  },
  {
    name: "answerhatch_create_tenant",
    title: "Register a domain",
    description:
      "Register one domain and return its tenant id plus the DNS TXT record " +
      "that proves the customer controls it. The crawl does not start here. " +
      "Give the record to the user verbatim, wait for them to publish it, " +
      "then call answerhatch_start_crawl. Call this once per site; if a crawl " +
      "will not start, retry the crawl rather than registering again.",
    inputSchema: {
      domain: z
        .string()
        .describe("bare hostname such as example.com, no scheme and no path"),
      pages: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .describe("crawl budget in pages, default 120, maximum 2000"),
    },
    impl: createTenant,
  },
  {
    name: "answerhatch_start_crawl",
    title: "Start the crawl",
    description:
      "Start the crawl for a registered tenant. Call it only after the TXT " +
      "record from answerhatch_create_tenant is published. If the record is " +
      "not visible yet the tool returns the record again with instructions to " +
      "publish and retry: wait about a minute and call this tool again. The " +
      "crawl is asynchronous, so poll answerhatch_status afterwards.",
    inputSchema: TENANT_ARG,
    impl: startCrawl,
  },
  {
    name: "answerhatch_status",
    title: "Check tenant status",
    description:
      "Report a tenant's lifecycle stage, worker phase, pages crawled and " +
      "domain verification. Poll this every 20 to 30 seconds while a crawl " +
      "runs. When the stage reaches live it also returns the embed snippet " +
      "and the steps for pasting it into the site, which is the end of " +
      "onboarding.",
    inputSchema: TENANT_ARG,
    impl: tenantStatus,
  },
];

function content(text, isError) {
  const out = { content: [{ type: "text", text: scrub(text) }] };
  if (isError) out.isError = true;
  return out;
}

/** Run a tool by name and return MCP content. The server and the tests both
 * go through here, so error shaping is tested rather than assumed. */
export async function callTool(name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return content("unknown tool: " + name, true);
  try {
    return content(await tool.impl(args), false);
  } catch (err) {
    return content(err instanceof ToolError ? err.message : String(err), true);
  }
}

export async function createServer() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const server = new McpServer({ name: "answerhatch", version: "0.1.0" });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      (args) => callTool(tool.name, args)
    );
  }
  return server;
}

async function main() {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const server = await createServer();
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // stderr only: stdout is the MCP transport.
    process.stderr.write("answerhatch-mcp failed to start: " + err.message + "\n");
    process.exit(1);
  });
}
