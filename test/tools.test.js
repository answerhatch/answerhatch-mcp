// Tool-level tests for answerhatch-mcp. global fetch is stubbed, so nothing
// here touches the live API. Every tool result is pushed onto `transcript`,
// and the last test asserts no token value ever reached it.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { callTool, createServer, resetSession, TOOLS } from "../index.js";

const API = "https://api.test.local";
const SESSION_TOKEN = "sess_tok_must_not_appear_a1b2c3";
const ENV_TOKEN = "env_tok_must_not_appear_d4e5f6";
const VERIFY_VALUE = "ah-verify-7c1e9d";

const transcript = [];
const realFetch = global.fetch;

/** Stub global fetch with a {"METHOD /path": {status, body}} table and
 * return the list of requests it saw. */
function stubFetch(routes) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const key = init.method + " " + new URL(url).pathname;
    calls.push({
      url,
      key,
      headers: init.headers || {},
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const route = routes[key];
    if (!route) throw new Error("unstubbed request: " + key);
    return { status: route.status, json: async () => route.body };
  };
  return calls;
}

/** Call a tool and record its text, so the leak test sees everything. */
async function run(name, args) {
  const result = await callTool(name, args);
  transcript.push(result.content[0].text);
  return result;
}

const text = (result) => result.content[0].text;

beforeEach(() => {
  resetSession();
  delete process.env.ANSWERHATCH_TOKEN;
  process.env.ANSWERHATCH_API = API;
  global.fetch = async () => {
    throw new Error("fetch called before the test stubbed it");
  };
});

after(() => {
  global.fetch = realFetch;
  delete process.env.ANSWERHATCH_API;
});

test("login stores the token and never echoes it", async () => {
  const calls = stubFetch({
    "POST /api/v1/login": { status: 200, body: { token: SESSION_TOKEN } },
    "POST /api/v1/tenants": {
      status: 200,
      body: {
        tenant_id: "t-101",
        verify: { record: "_answerhatch.example.com", type: "TXT", value: VERIFY_VALUE },
        next: "add the TXT record then POST /api/v1/tenants/t-101/crawl",
      },
    },
  });

  const result = await run("answerhatch_login", {
    email: "ops@example.com",
    password: "hunter2-correct-horse",
  });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /Signed in as ops@example\.com/);
  assert.ok(!text(result).includes(SESSION_TOKEN));
  assert.ok(!text(result).includes("hunter2-correct-horse"));
  assert.deepEqual(calls[0].body, {
    email: "ops@example.com",
    password: "hunter2-correct-horse",
  });

  // The stored token is what authorises the next call.
  await run("answerhatch_create_tenant", { domain: "example.com" });
  assert.equal(calls[1].headers.authorization, "Bearer " + SESSION_TOKEN);
});

test("login failure returns the API error string", async () => {
  stubFetch({
    "POST /api/v1/login": { status: 401, body: { error: "wrong email or password" } },
  });
  const result = await run("answerhatch_login", {
    email: "ops@example.com",
    password: "wrong",
  });
  assert.equal(result.isError, true);
  assert.equal(text(result), "wrong email or password");
});

test("create_tenant returns the tenant id and the exact TXT record", async () => {
  process.env.ANSWERHATCH_TOKEN = ENV_TOKEN;
  const calls = stubFetch({
    "POST /api/v1/tenants": {
      status: 200,
      body: {
        tenant_id: "t-204",
        verify: { record: "_answerhatch.example.com", type: "TXT", value: VERIFY_VALUE },
        next: "add the TXT record then POST /api/v1/tenants/t-204/crawl",
      },
    },
  });

  const result = await run("answerhatch_create_tenant", {
    domain: "example.com",
    pages: 250,
  });
  const body = text(result);
  assert.equal(result.isError, undefined);
  assert.match(body, /Tenant t-204 registered for example\.com/);
  assert.match(body, /name: {2}_answerhatch\.example\.com/);
  assert.match(body, /type: {2}TXT/);
  assert.ok(body.includes(VERIFY_VALUE));
  assert.match(body, /answerhatch_start_crawl/);
  assert.deepEqual(calls[0].body, { domain: "example.com", pages: 250 });
  assert.equal(calls[0].url, API + "/api/v1/tenants");
});

test("create_tenant omits pages when the caller did not set it", async () => {
  process.env.ANSWERHATCH_TOKEN = ENV_TOKEN;
  const calls = stubFetch({
    "POST /api/v1/tenants": {
      status: 200,
      body: {
        tenant_id: "t-205",
        verify: { record: "_answerhatch.example.org", type: "TXT", value: VERIFY_VALUE },
      },
    },
  });
  await run("answerhatch_create_tenant", { domain: "example.org" });
  assert.deepEqual(calls[0].body, { domain: "example.org" });
});

test("start_crawl queues the crawl on 202", async () => {
  process.env.ANSWERHATCH_TOKEN = ENV_TOKEN;
  const calls = stubFetch({
    "POST /api/v1/tenants/t-204/crawl": { status: 202, body: { queued: true } },
  });
  const result = await run("answerhatch_start_crawl", { tenant_id: "t-204" });
  assert.equal(result.isError, undefined);
  assert.match(text(result), /Crawl queued for tenant t-204/);
  assert.match(text(result), /answerhatch_status/);
  assert.equal(calls[0].headers.authorization, "Bearer " + ENV_TOKEN);
});

test("start_crawl on 409 returns the record and publish-then-retry", async () => {
  process.env.ANSWERHATCH_TOKEN = ENV_TOKEN;
  stubFetch({
    "POST /api/v1/tenants/t-204/crawl": {
      status: 409,
      body: {
        error: "domain not verified",
        record: "_answerhatch.example.com",
        type: "TXT",
        value: VERIFY_VALUE,
      },
    },
  });
  const result = await run("answerhatch_start_crawl", { tenant_id: "t-204" });
  const body = text(result);
  assert.equal(result.isError, undefined, "409 is an expected state, not a tool failure");
  assert.match(body, /domain not verified/);
  assert.match(body, /Publish this record, then retry answerhatch_start_crawl/);
  assert.match(body, /name: {2}_answerhatch\.example\.com/);
  assert.ok(body.includes(VERIFY_VALUE));
  assert.match(body, /Do not register the domain a second time/);
});

test("status reports progress while the crawl runs", async () => {
  process.env.ANSWERHATCH_TOKEN = ENV_TOKEN;
  stubFetch({
    "GET /api/v1/tenants/t-204": {
      status: 200,
      body: {
        stage: "draft",
        phase: "running",
        detail: "crawled 42 of 120",
        pages_crawled: 42,
        verified: true,
      },
    },
  });
  const result = await run("answerhatch_status", { tenant_id: "t-204" });
  const body = text(result);
  assert.match(body, /stage: +draft/);
  assert.match(body, /phase: +running/);
  assert.match(body, /pages crawled: 42/);
  assert.match(body, /verified: +yes/);
  assert.match(body, /crawled 42 of 120/);
  assert.match(body, /Poll again in 20 to 30 seconds/);
});

test("status returns the snippet and instructions once live", async () => {
  process.env.ANSWERHATCH_TOKEN = ENV_TOKEN;
  stubFetch({
    "GET /api/v1/tenants/t-204": {
      status: 200,
      body: {
        stage: "live",
        phase: "done",
        detail: "",
        pages_crawled: 118,
        verified: true,
        snippet: '<script src="https://cdn.answerhatch.com/t-204.js" async></script>',
        instructions: "1. Copy the snippet in this response.\n2. Paste it before </body>.",
      },
    },
  });
  const result = await run("answerhatch_status", { tenant_id: "t-204" });
  const body = text(result);
  assert.match(body, /stage: +live/);
  assert.ok(body.includes('<script src="https://cdn.answerhatch.com/t-204.js" async></script>'));
  assert.match(body, /1\. Copy the snippet in this response\./);
});

test("status without a token asks for sign-in and makes no request", async () => {
  const calls = stubFetch({});
  const result = await run("answerhatch_status", { tenant_id: "t-204" });
  assert.equal(result.isError, true);
  assert.match(text(result), /not signed in: call answerhatch_login first/);
  assert.match(text(result), /ANSWERHATCH_TOKEN/);
  assert.equal(calls.length, 0);
});

test("a tenant id with URL-unsafe characters is encoded, not injected", async () => {
  process.env.ANSWERHATCH_TOKEN = ENV_TOKEN;
  const calls = stubFetch({
    "GET /api/v1/tenants/t-204%2F..%2Fadmin": {
      status: 403,
      body: { error: "no such tenant on this account" },
    },
  });
  const result = await run("answerhatch_status", { tenant_id: "t-204/../admin" });
  assert.equal(result.isError, true);
  assert.equal(text(result), "no such tenant on this account");
  assert.equal(calls[0].url, API + "/api/v1/tenants/t-204%2F..%2Fadmin");
});

test("an unreachable API is reported as a reachability problem", async () => {
  process.env.ANSWERHATCH_TOKEN = ENV_TOKEN;
  global.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const result = await run("answerhatch_status", { tenant_id: "t-204" });
  assert.equal(result.isError, true);
  assert.match(text(result), /cannot reach the AnswerHatch API at https:\/\/api\.test\.local/);
});

test("the API base falls back to production when ANSWERHATCH_API is unset", async () => {
  delete process.env.ANSWERHATCH_API;
  process.env.ANSWERHATCH_TOKEN = ENV_TOKEN;
  const calls = stubFetch({
    "GET /api/v1/tenants/t-9": {
      status: 200,
      body: { stage: "draft", phase: "idle", detail: "", pages_crawled: 0, verified: false },
    },
  });
  await run("answerhatch_status", { tenant_id: "t-9" });
  assert.equal(calls[0].url, "https://api.answerhatch.com/api/v1/tenants/t-9");
});

test("the server registers all four tools and serves a call over MCP", async () => {
  process.env.ANSWERHATCH_TOKEN = ENV_TOKEN;
  stubFetch({
    "GET /api/v1/tenants/t-77": {
      status: 200,
      body: { stage: "draft", phase: "idle", detail: "", pages_crawled: 0, verified: false },
    },
  });
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  const server = await createServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((t) => t.name).sort(),
    TOOLS.map((t) => t.name).sort()
  );
  for (const tool of listed.tools) {
    assert.ok(tool.description.length > 40, tool.name + " needs a description for the agent");
  }

  const called = await client.callTool({
    name: "answerhatch_status",
    arguments: { tenant_id: "t-77" },
  });
  transcript.push(called.content[0].text);
  assert.match(called.content[0].text, /Tenant t-77/);
  assert.match(called.content[0].text, /publish the TXT record/);
  await client.close();
  await server.close();
});

test("no tool output in this run contained a token value", () => {
  assert.ok(transcript.length >= 12, "expected every tool result to be recorded");
  const everything = transcript.join("\n");
  assert.ok(!everything.includes(SESSION_TOKEN), "session token leaked into tool output");
  assert.ok(!everything.includes(ENV_TOKEN), "environment token leaked into tool output");
  // The scrubber would have masked a leak, which would hide it from the two
  // assertions above; nothing should have needed masking in the first place.
  assert.ok(!everything.includes("[redacted]"), "output needed scrubbing, so something leaked");
});
