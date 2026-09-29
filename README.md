# Cloudflare Agent

A streaming AI chat app built with Cloudflare Workers, the Agents SDK, and Workers AI. The agent uses Llama 3.3 for general questions and tools, Open-Meteo for live weather, and Durable Objects for persistent chat sessions.

## Requirements

- Node.js 20.19+ or 22.12+
- npm
- A Cloudflare account with Workers access
- Wrangler authenticated to the account configured in `wrangler.jsonc`

Workers AI is configured as a remote binding, so local development still calls Cloudflare and uses that account's Workers AI quota.

## Run locally

Install dependencies and authenticate once:

```powershell
npm ci
npx wrangler login
npx wrangler whoami
```

Start the app:

```powershell
npm run dev
```

Open <http://localhost:5173/>. `npm start` also starts the Vite development server.

## Deploy

Check the account target in `wrangler.jsonc`, then deploy:

```powershell
npm run check
npm run deploy
```

`npm run deploy` builds the frontend and Worker, then runs `wrangler deploy`. Wrangler prints the deployed `workers.dev` URL when it succeeds.

The `account_id` currently in `wrangler.jsonc` targets the account used for this project. To deploy a separate copy from another Cloudflare account, replace it with that account's ID and authenticate with a user or API token that has permission to deploy there. Each account gets its own Worker, Durable Object storage, and Workers AI quota; deployment does not move or share this account's chat history.

## What it can do

- Answer general questions using `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on Workers AI.
- Calculate simple two-number expressions directly, without an LLM request.
- Look up city weather directly using Open-Meteo geocoding and current conditions.
- Search public GitHub repository metadata and Wikipedia pages when the model requests the search tool. This is not a whole-web search.
- Read timezone and local time from the user's browser when the model requests the timezone tool.
- Schedule reminders using the Agents SDK scheduler. At the moment, a fired reminder is logged and broadcast to connected clients; it does not send email or perform an external action.
- Connect optional MCP servers from the chat UI.

## Workers AI quota

The model runs through the `AI` binding in `wrangler.jsonc`; no third-party model key is configured. Workers AI has a free daily neuron allocation. When the account reaches its limit, model-based questions and model-triggered tools (including timezone and public-resource search) cannot run until the quota resets or paid usage is enabled. Direct arithmetic and city-weather lookups do not use the model.

See [Workers AI pricing and quota details](https://developers.cloudflare.com/workers-ai/platform/pricing/).

## Project structure

```text
src/
  server.ts    Agent runtime, model, tools, and direct-response handlers
  app.tsx      React chat interface
  client.tsx   React application entry point
  styles.css   Tailwind and Kumo styles
wrangler.jsonc Worker bindings and Durable Object configuration
```

## Useful commands

| Command          | Purpose                                 |
| ---------------- | --------------------------------------- |
| `npm run dev`    | Start the local development server      |
| `npm start`      | Alias for the development server        |
| `npm run check`  | Check formatting, lint, and TypeScript  |
| `npm run format` | Format project files                    |
| `npm run deploy` | Build and deploy to Cloudflare          |
| `npm run types`  | Regenerate Cloudflare environment types |

## References

- [Cloudflare Agents documentation](https://developers.cloudflare.com/agents/)
- [Workers AI models](https://developers.cloudflare.com/workers-ai/models/)
- [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Open-Meteo API documentation](https://open-meteo.com/en/docs)
