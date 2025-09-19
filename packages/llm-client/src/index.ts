export interface ChatRequest {
  model: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
}

export interface ChatClient {
  chat(req: ChatRequest): Promise<Response>;
  chatStream(req: ChatRequest): AsyncIterable<string>;
}

export interface ClientOptions {
  baseURL: string; // e.g. http://localhost:1234/v1
  apiKey?: string;
}

export class OpenAICompatClient implements ChatClient {
  constructor(private readonly opts: ClientOptions) {}

  async chat(req: ChatRequest): Promise<Response> {
    const { baseURL, apiKey } = this.opts;
    return fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(req),
    });
  }

  async *chatStream(_req: ChatRequest): AsyncIterable<string> {
    // TODO: Implement SSE/chunk streaming parsing
    throw new Error("chatStream not implemented");
  }
}

