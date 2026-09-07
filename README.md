# AnswerHatch MCP

![License: MIT](https://img.shields.io/badge/license-MIT-blue) ![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen) ![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-black)

Put a cite-or-refuse answer box on your docs, from the chat where you already work. Ask your agent to add cited answers to a site and this server does the whole onboarding: register the domain, prove you own it, crawl the pages, and hand back a one-line embed. No dashboard, no operator.

## What AnswerHatch is

AnswerHatch answers your visitors from your own published pages, links the source on every answer, and refuses when it has no source. It never invents an API parameter, an endpoint, or a wrong command.

Every "AI on your docs" tool optimises for always answering. For documentation that is the wrong default: a confidently wrong answer is not a bad chat, it is a broken integration and a support ticket. AnswerHatch is built the other way round.

- Cite or refuse. Every answer carries the page it came from, or the widget declines and gives the reason. The refusal is a gate in the request path, not a line in a prompt that can be talked around.
- No third-party model in the path. Your docs and your users' questions are processed on AnswerHatch's own machines. They do not transit OpenAI or any other model API.
- A provenance registry. Every crawled document carries its source URL, the date it was fetched, and its hash, so a reviewer can audit exactly what the widget is allowed to say.

See it refuse a made-up question, live: https://answerhatch.com

## Install

Requires Node 20 or newer.

Claude Code, one line:

```
claude mcp add answerhatch -- npx -y answerhatch-mcp
```

Any MCP client, config form:

```json
{
  "mcpServers": {
    "answerhatch": {
      "command": "npx",
      "args": ["-y", "answerhatch-mcp"]
    }
  }
}
```

From source, to hack on it:

```
git clone https://github.com/answerhatch/answerhatch-mcp
cd answerhatch-mcp
npm install
claude mcp add answerhatch -- node /absolute/path/to/answerhatch-mcp/index.js
```

You need an AnswerHatch account. The agent can create one for you with `answerhatch_signup`, or sign up yourself at https://answerhatch.com (self-serve, a free trial) and use `answerhatch_login`. For non-interactive use, set `ANSWERHATCH_TOKEN` in the server's environment and skip both.

## Use it

In your agent, just ask:

```
You:    Sign me up and add cited answers to docs.example.com
Agent:  (answerhatch_signup, then answerhatch_create_tenant)
        Account created. Publish this TXT record to prove you own the domain:
          name:  _answerhatch.docs.example.com
          type:  TXT
          value: ah-verify-...
You:    published
Agent:  (answerhatch_start_crawl, then polls answerhatch_status)
        Live. Paste this into your site:
          <script async src="https://cdn.answerhatch.com/api/widget.js"
            data-agency="..." data-key="..." data-env="prod"></script>
You:    start a professional subscription
Agent:  (answerhatch_subscribe)
        Open this link to enter your card and start the 14-day trial:
          https://checkout.stripe.com/...
```

The tools enforce the order the API requires (register, prove ownership, then crawl) and each one tells the agent what to do next, so the agent drives the whole flow without you touching a console.

## Tools

| Tool | What it does |
|---|---|
| `answerhatch_signup` | Create a new account and sign in, so onboarding runs without leaving the agent. Use `answerhatch_login` instead if you already have one. |
| `answerhatch_login` | Sign in with email and password; holds the bearer token for the session. Skip it if `ANSWERHATCH_TOKEN` is set. |
| `answerhatch_create_tenant` | Register one domain and return its DNS TXT record. The crawl does not start here. |
| `answerhatch_start_crawl` | Start the crawl once the TXT record is published. If it is not visible yet, returns the record again to retry. |
| `answerhatch_status` | Report lifecycle stage, pages crawled, and verification. When the site is live it returns the embed snippet. |
| `answerhatch_subscribe` | Start a paid subscription and return a Stripe checkout link. The card is entered on Stripe's page, never in the agent. 14-day free trial. |

## Security

The bearer token lives in memory for the session only. It is never written to disk, never logged, and it is scrubbed from tool output even if an API response tried to echo it back.

## Links

- Product and the live refusal demo: https://answerhatch.com
- Pricing: https://answerhatch.com/pricing

## License

MIT. See [LICENSE](LICENSE).
