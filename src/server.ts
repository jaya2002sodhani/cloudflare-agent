import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest, type Schedule } from "agents";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage
} from "ai";
import { z } from "zod";

function parseDirectCalculation(
  text: string
): { expression: string; result: number } | undefined {
  const expression = text
    .replace(/^\s*(?:calculate|compute|evaluate|what\s+is|what's)\s+/i, "")
    .replace(/\b(?:plus)\b/gi, "+")
    .replace(/\b(?:minus)\b/gi, "-")
    .replace(/\b(?:times|multiplied\s+by)\b/gi, "*")
    .replace(/\b(?:divided\s+by|over)\b/gi, "/")
    .trim();
  const match = expression.match(
    /^(-?(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+))\s*([+*/%-])\s*(-?(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+))[?.!]*$/
  );
  if (!match) return undefined;

  const first = Number(match[1].replaceAll(",", ""));
  const second = Number(match[3].replaceAll(",", ""));
  const operator = match[2];
  if (!Number.isFinite(first) || !Number.isFinite(second)) return undefined;
  if ((operator === "/" || operator === "%") && second === 0) {
    return { expression: match[0], result: Number.NaN };
  }

  const result = {
    "+": first + second,
    "-": first - second,
    "*": first * second,
    "/": first / second,
    "%": first % second
  }[operator];
  return typeof result === "number" && Number.isFinite(result)
    ? { expression: `${first} ${operator} ${second}`, result }
    : undefined;
}

type WeatherResult =
  | {
      city: string;
      country?: string;
      temperature: number;
      condition: string;
      unit: "celsius";
    }
  | { error: string };

async function lookupWeather(city: string): Promise<WeatherResult> {
  try {
    const geocodingUrl = new URL(
      "https://geocoding-api.open-meteo.com/v1/search"
    );
    geocodingUrl.search = new URLSearchParams({
      name: city,
      count: "1",
      language: "en",
      format: "json"
    }).toString();
    const geocodingResponse = await fetch(geocodingUrl);
    if (!geocodingResponse.ok) {
      return {
        error: `Weather location lookup failed (HTTP ${geocodingResponse.status}).`
      };
    }
    const geocodingData = (await geocodingResponse.json()) as {
      results?: Array<{
        name: string;
        country?: string;
        latitude: number;
        longitude: number;
      }>;
    };
    const location = geocodingData.results?.[0];
    if (!location) return { error: `No matching location found for ${city}.` };

    const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
    forecastUrl.search = new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: "temperature_2m,weather_code",
      temperature_unit: "celsius"
    }).toString();
    const forecastResponse = await fetch(forecastUrl);
    if (!forecastResponse.ok) {
      return {
        error: `Current weather lookup failed (HTTP ${forecastResponse.status}).`
      };
    }
    const forecastData = (await forecastResponse.json()) as {
      current?: { temperature_2m: number; weather_code: number };
    };
    const current = forecastData.current;
    if (!current) return { error: "Current weather is unavailable." };

    const conditions: Record<number, string> = {
      0: "clear sky",
      1: "mostly clear",
      2: "partly cloudy",
      3: "overcast",
      45: "foggy",
      48: "foggy",
      51: "light drizzle",
      53: "drizzle",
      55: "heavy drizzle",
      61: "light rain",
      63: "rain",
      65: "heavy rain",
      71: "light snow",
      73: "snow",
      75: "heavy snow",
      80: "rain showers",
      81: "rain showers",
      82: "heavy rain showers",
      95: "thunderstorm",
      96: "thunderstorm with hail",
      99: "thunderstorm with heavy hail"
    };
    return {
      city: location.name,
      country: location.country,
      temperature: current.temperature_2m,
      condition: conditions[current.weather_code] ?? "unknown conditions",
      unit: "celsius"
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { error: `Weather lookup failed: ${detail}` };
  }
}

function createAssistantTextResponse(
  text: string,
  originalMessages: UIMessage[]
): Response {
  const stream = createUIMessageStream({
    originalMessages,
    execute: ({ writer }) => {
      const id = crypto.randomUUID();
      writer.write({ type: "text-start", id });
      writer.write({ type: "text-delta", id, delta: text });
      writer.write({ type: "text-end", id });
    }
  });
  return createUIMessageStreamResponse({ stream });
}

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;
  // Wait for MCP connections to be re-established after hibernation before
  // processing a message, so MCP tools aren't intermittently missing.
  waitForMcpConnections = true;

  onStart() {
    // Configure OAuth popup behavior for MCP servers that require authentication
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }
        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          { headers: { "content-type": "text/plain" }, status: 400 }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const mcpTools = this.mcp.getAITools();
    const workersai = createWorkersAI({ binding: this.env.AI });
    const latestUserText =
      [...this.messages]
        .reverse()
        .find((message) => message.role === "user")
        ?.parts.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(" ") ?? "";
    const asksForOwnTimezone =
      /\b(?:what|which)\b.*\btime[ -]?zone\b/i.test(latestUserText) &&
      /\b(?:my|am i|i am)\b/i.test(latestUserText);
    const asksForCityWeather =
      /\b(?:weather|forecast)\b/i.test(latestUserText) &&
      /\b(?:in|for|at)\s+[\p{L}]/iu.test(latestUserText);
    const weatherCity = latestUserText
      .match(/\b(?:weather|forecast)\b.*?\b(?:in|for|at)\s+(.+?)[?.!]*$/i)?.[1]
      ?.trim();

    const calculation = parseDirectCalculation(latestUserText);
    if (calculation) {
      const answer = Number.isNaN(calculation.result)
        ? "Division or modulo by zero is undefined."
        : `${calculation.expression} = ${calculation.result}`;
      return createAssistantTextResponse(answer, this.messages);
    }

    if (asksForCityWeather && weatherCity) {
      const weather = await lookupWeather(weatherCity);
      const answer =
        "error" in weather
          ? weather.error
          : `${weather.city}${weather.country ? `, ${weather.country}` : ""}: ${weather.temperature} °C, ${weather.condition}. Source: Open-Meteo.`;
      return createAssistantTextResponse(answer, this.messages);
    }

    const result = streamText({
      model: workersai("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        sessionAffinity: this.sessionAffinity
      }),
      temperature: 0.2,
      system: `You are a helpful assistant. You can look up current weather and public reference information, get the user's timezone, run calculations, and schedule tasks. When a user asks for their own timezone or local time, call getUserTimezone exactly once, then answer from its result without calling it again. Use getWeather once per weather request. If a tool returns an error, explain it briefly and do not retry the same tool. Do not ask for clarification when the request is clear. Use searchPublicResources for public-source research and cite the URLs it returns. It searches Wikipedia pages and public GitHub repository metadata only; do not claim it searched the whole web or inspected full source code. Answer direct questions concisely and do not repeat words or sentences. Summarize tool results accurately.

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the schedule tool to schedule the task.`,
      // Prune old tool calls and reasoning to save tokens on long conversations
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      prepareStep: ({ stepNumber }) => {
        if (asksForOwnTimezone) {
          return {
            toolChoice:
              stepNumber === 0
                ? { type: "tool", toolName: "getUserTimezone" }
                : "none"
          };
        }
        if (asksForCityWeather) {
          return {
            toolChoice:
              stepNumber === 0
                ? { type: "tool", toolName: "getWeather" }
                : "none"
          };
        }
        return { toolChoice: "auto" };
      },
      tools: {
        // MCP tools from connected servers
        ...mcpTools,

        searchPublicResources: tool({
          description:
            "Search Wikipedia reference pages and public GitHub repositories. Use for sourced public information and open-source project discovery; include the returned URLs when answering.",
          inputSchema: z.object({
            query: z.string().trim().min(2).max(200).describe("Search terms")
          }),
          execute: async ({ query }) => {
            const githubUrl = new URL(
              "https://api.github.com/search/repositories"
            );
            githubUrl.search = new URLSearchParams({
              q: `${query} in:name,description,readme`,
              sort: "stars",
              order: "desc",
              per_page: "5"
            }).toString();

            const wikipediaUrl = new URL(
              "https://en.wikipedia.org/w/rest.php/v1/search/page"
            );
            wikipediaUrl.search = new URLSearchParams({
              q: query,
              limit: "5"
            }).toString();

            const [githubResult, wikipediaResult] = await Promise.allSettled([
              fetch(githubUrl, {
                headers: {
                  Accept: "application/vnd.github+json",
                  "X-GitHub-Api-Version": "2022-11-28",
                  "User-Agent": "CloudflareAgent/1.0"
                }
              }),
              fetch(wikipediaUrl, {
                headers: { "User-Agent": "CloudflareAgent/1.0" }
              })
            ]);

            const resources: Array<Record<string, unknown>> = [];
            const errors: string[] = [];

            if (githubResult.status === "fulfilled" && githubResult.value.ok) {
              const data = (await githubResult.value.json()) as {
                items?: Array<{
                  full_name: string;
                  html_url: string;
                  description: string | null;
                  stargazers_count: number;
                  language: string | null;
                  license?: { spdx_id: string } | null;
                }>;
              };
              resources.push(
                ...(data.items ?? []).map((repository) => ({
                  source: "GitHub",
                  title: repository.full_name,
                  summary: repository.description,
                  url: repository.html_url,
                  stars: repository.stargazers_count,
                  language: repository.language,
                  license: repository.license?.spdx_id ?? null
                }))
              );
            } else {
              errors.push(
                "GitHub repository search is temporarily unavailable."
              );
            }

            if (
              wikipediaResult.status === "fulfilled" &&
              wikipediaResult.value.ok
            ) {
              const data = (await wikipediaResult.value.json()) as {
                pages?: Array<{
                  title: string;
                  key: string;
                  description?: string;
                }>;
              };
              resources.push(
                ...(data.pages ?? []).map((page) => ({
                  source: "Wikipedia",
                  title: page.title,
                  summary: page.description ?? null,
                  url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}`
                }))
              );
            } else {
              errors.push("Wikipedia search is temporarily unavailable.");
            }

            return { query, resources, errors };
          }
        }),

        // Server-side tool: runs automatically on the server
        getWeather: tool({
          description: "Get the current weather for a city",
          inputSchema: z.object({
            city: z.string().describe("City name")
          }),
          execute: async ({ city }) => lookupWeather(city)
        }),

        // Client-side tool: no execute function — the browser handles it
        getUserTimezone: tool({
          description:
            "Get the user's timezone and local time from their browser. Always use this for direct questions about the user's own timezone or local time.",
          inputSchema: z.object({})
        }),

        // Approval tool: requires user confirmation before executing
        calculate: tool({
          description:
            "Perform a math calculation with two numbers and an arithmetic operator.",
          inputSchema: z.object({
            a: z.coerce.number().finite().describe("First number"),
            b: z.coerce.number().finite().describe("Second number"),
            operator: z
              .enum(["+", "-", "*", "/", "%"])
              .describe("Arithmetic operator")
          }),
          execute: async ({ a, b, operator }) => {
            const ops: Record<string, (x: number, y: number) => number> = {
              "+": (x, y) => x + y,
              "-": (x, y) => x - y,
              "*": (x, y) => x * y,
              "/": (x, y) => x / y,
              "%": (x, y) => x % y
            };
            if (operator === "/" && b === 0) {
              return { error: "Division by zero" };
            }
            return {
              expression: `${a} ${operator} ${b}`,
              result: ops[operator](a, b)
            };
          }
        }),

        scheduleTask: tool({
          description:
            "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
          inputSchema: scheduleSchema,
          execute: async ({ when, description }) => {
            if (when.type === "no-schedule") {
              return "Not a valid schedule input";
            }
            const input =
              when.type === "scheduled"
                ? when.date
                : when.type === "delayed"
                  ? when.delayInSeconds
                  : when.type === "cron"
                    ? when.cron
                    : null;
            if (!input) return "Invalid schedule type";
            try {
              this.schedule(input, "executeTask", description, {
                idempotent: true
              });
              return `Task scheduled: "${description}" (${when.type}: ${input})`;
            } catch (error) {
              return `Error scheduling task: ${error}`;
            }
          }
        }),

        getScheduledTasks: tool({
          description: "List all tasks that have been scheduled",
          inputSchema: z.object({}),
          execute: async () => {
            const tasks = this.getSchedules();
            return tasks.length > 0 ? tasks : "No scheduled tasks found.";
          }
        }),

        cancelScheduledTask: tool({
          description: "Cancel a scheduled task by its ID",
          inputSchema: z.object({
            taskId: z.string().describe("The ID of the task to cancel")
          }),
          execute: async ({ taskId }) => {
            try {
              this.cancelSchedule(taskId);
              return `Task ${taskId} cancelled.`;
            } catch (error) {
              return `Error cancelling task: ${error}`;
            }
          }
        })
      },
      stopWhen: stepCountIs(20),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }

  async executeTask(description: string, _task: Schedule<string>) {
    // Do the actual work here (send email, call API, etc.)
    console.log(`Executing scheduled task: ${description}`);

    // Notify connected clients via a broadcast event.
    // We use broadcast() instead of saveMessages() to avoid injecting
    // into chat history — that would cause the AI to see the notification
    // as new context and potentially loop.
    this.broadcast(
      JSON.stringify({
        type: "scheduled-task",
        description,
        timestamp: new Date().toISOString()
      })
    );
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
