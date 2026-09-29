# Prompts

A step-by-step sequence of prompts for building this agent from scratch with an AI coding assistant.

Each prompt covers one step. It states the goal, the constraints, and how to check the result. Run the prompts in order, and confirm each step works before starting the next.

## Step 1: Scaffold the project

> Create a new Cloudflare Workers project for an AI chat agent in a folder named `cloudflare-agent`, using TypeScript, React 19 and Vite with `@cloudflare/vite-plugin`.
>
> Use the Cloudflare Agents SDK (`agents`) and `@cloudflare/ai-chat` for the agent, and the Vercel AI SDK (`ai`) with `workers-ai-provider` for model calls. Use Tailwind CSS 4 and `@cloudflare/kumo` for UI components.
>
> In `wrangler.jsonc`, set `main` to `src/server.ts`, enable the `nodejs_compat` flag, and set a current compatibility date. Serve static assets from `./public` with single-page-application fallback, and send `/agents/*` and `/oauth/*` to the Worker first.
>
> Add npm scripts for `dev`, `deploy`, `types`, `format`, `lint` and `check` (format check, lint and `tsc`). Do not add any application features yet.
>
> Done when `npm run dev` serves a placeholder page at `http://localhost:5173/` and `npm run check` passes.

## Step 2: Add the chat agent and model

> Add a `ChatAgent` class in `src/server.ts` that extends `AIChatAgent` and is stored in a Durable Object. Register it in `wrangler.jsonc` as a Durable Object binding named `ChatAgent`, with a `v1` migration using `new_sqlite_classes` so chat history is stored in SQLite.
>
> Add a Workers AI binding named `AI` with `remote: true`. In `onChatMessage`, stream responses from `@cf/meta/llama-3.3-70b-instruct-fp8-fast` using `streamText`, with a temperature of 0.2.
>
> Keep at most 100 messages per chat, enable chat recovery, and prune old tool calls and reasoning before sending history to the model. In the Worker's `fetch` handler, route requests with `routeAgentRequest` and return 404 otherwise.
>
> Write a short system prompt: a helpful assistant that answers concisely, does not repeat itself, and does not ask for clarification when a request is clear.
>
> Run `npm run types` after changing bindings. Done when a WebSocket connection to `/agents/chat-agent/<id>` is accepted and a chat message gets a streamed reply.

## Step 3: Build the chat interface

> Build the chat UI in `src/app.tsx` using `useAgent` from `agents/react` and `useAgentChat` from `@cloudflare/ai-chat/react`.
>
> It needs: a message list with user and assistant bubbles, streamed Markdown rendering with code highlighting (use `streamdown` with `@streamdown/code`), a text input that sends on Enter, a Stop button while a reply is streaming, and a button to clear the chat history.
>
> Add a light/dark theme toggle that remembers the choice in `localStorage`, and a debug toggle that shows the raw message parts. Show a tool call's name, input, state and output in a collapsible card.
>
> Done when a full conversation works in the browser, history survives a page reload, and the layout works at phone width.

## Step 4: Add weather and calculation tools

> Add two tools to the agent.
>
> `getWeather(city)`: look up the city with the Open-Meteo geocoding API, then fetch the current temperature and weather code from the Open-Meteo forecast API. No API key is needed. Return the city, country, temperature in Celsius and a readable condition (map the WMO weather codes to text). Return an `{ error }` object instead of throwing when the city isn't found or a request fails.
>
> `calculate(a, b, operator)`: support `+ - * / %`, validate the inputs with Zod, and return an error for division by zero.
>
> Update the system prompt: call `getWeather` once per weather request, and if a tool returns an error, explain it briefly and don't retry.
>
> Done when "What's the weather in Paris?" and "What is 12 \* 7?" both return correct answers, and an unknown city returns a clear error.

## Step 5: Add a browser-side timezone tool

> Add a `getUserTimezone` tool with no `execute` function on the server, so the browser runs it. In the UI's `onToolCall` handler, return the browser's timezone from `Intl.DateTimeFormat().resolvedOptions().timeZone` and the current local time.
>
> Tell the model in the system prompt to call `getUserTimezone` exactly once for questions about the user's own timezone or local time, then answer from the result.
>
> Done when "What is my timezone?" returns the browser's actual timezone and the tool is called only once.

## Step 6: Add public-source search

> Add a `searchPublicResources(query)` tool that queries the GitHub repository search API and the Wikipedia REST search API in parallel, with 5 results from each. Send a `User-Agent` header on both requests.
>
> Return a combined list with source, title, summary and URL, plus stars, language and license for GitHub results. If one source fails, still return the other's results together with an error message.
>
> In the system prompt, tell the model to cite the returned URLs and not to claim it searched the whole web or read full source code.
>
> Done when "Find open-source projects for Cloudflare Workers" returns cited links from both sources.

## Step 7: Add scheduled tasks

> Add `scheduleTask`, `getScheduledTasks` and `cancelScheduledTask` tools using the Agents SDK scheduler. Use `scheduleSchema` for the input and add `getSchedulePrompt({ date: new Date() })` to the system prompt so the model can convert phrases like "in 10 minutes" or "every Monday at 9am" into a date, delay or cron expression.
>
> When a task fires, `executeTask` should log it and `broadcast` a `scheduled-task` event to connected clients. Do not save it as a chat message, because the model would treat it as new input. Show the event as a toast in the UI.
>
> Done when "Remind me in 1 minute to stretch" shows a toast about a minute later, and listing and cancelling tasks both work.

## Step 8: Support MCP servers

> Let users connect external MCP servers from the UI. Add `addServer(name, url)` and `removeServer(id)` as `@callable()` methods on the agent, and pass `this.mcp.getAITools()` to the model with the other tools.
>
> Set `waitForMcpConnections = true` so MCP tools are available after the Durable Object wakes from hibernation. For servers that need OAuth, complete the flow in a popup that closes itself on success and shows an error message on failure.
>
> Add a panel that lists connected servers with their status and tools, and lets the user add or remove a server.
>
> Done when a public MCP server can be connected and one of its tools can be called from the chat.

## Step 9: Make responses reliable and save model quota

> Make the agent more reliable and use fewer Workers AI calls:
>
> - Answer simple two-number arithmetic ("what is 5 plus 3", "calculate 12 \* 7") directly in code, without calling the model.
> - Answer `weather in <city>` requests directly with the weather lookup, without calling the model.
> - For timezone and weather questions that do reach the model, use `prepareStep` to force the matching tool on the first step and disable tools afterwards, so the model can't call the same tool repeatedly.
> - Limit each reply to 20 steps with `stopWhen`, and pass the abort signal through so the Stop button cancels the model call.
>
> Done when those requests are answered without a model call, and no test prompt produces repeated tool calls.

## Step 10: Quality checks and CI

> Configure `oxfmt` for formatting and `oxlint` for linting, and make `npm run check` run the format check, lint and `tsc`. Fix everything it reports.
>
> Add a GitHub Actions workflow that runs `npm install` and `npm run check` on pushes and pull requests to `main`. Make sure `.gitignore` excludes `node_modules`, `dist`, `.wrangler` and `.dev.vars*`.
>
> Done when `npm run check` passes locally and in CI.

## Step 11: Deploy and document

> Deploy the agent to my Cloudflare account. Set `account_id` in `wrangler.jsonc`, enable observability and source map uploads, and run `npm run deploy`. Confirm the `workers.dev` URL loads and that the chat connects.
>
> Then write a `README.md` covering: what the agent can do (and its limits, such as search covering only GitHub and Wikipedia), requirements, how to run it locally and deploy it, how the Workers AI free quota affects it, the project structure, and the npm scripts.
>
> Done when someone new can clone the repo, follow the README, and have the agent running without asking questions.
