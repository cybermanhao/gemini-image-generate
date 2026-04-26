import type { Request, Response } from 'express';
import type { Application } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { dispatchToolCall } from './tools.js';

let transport: SSEServerTransport | null = null;

const mcpServer = new Server(
  { name: 'gemini-imagen-studio', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'open_image_studio',
      description: 'Open the Gemini Image Studio web UI in a browser. Returns the URL.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Optional session ID to resume an existing session' },
        },
      },
    },
    {
      name: 'generate_image',
      description: 'Generate an image using Gemini. Set autoRefine=true to start the full auto-loop (generate -> judge -> refine until converged). When autoRefine is enabled, use get_session_status to poll for completion.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID to track this generation' },
          imageBase64: { type: 'string', description: 'Optional subject image (for image-to-image)' },
          prompt: { type: 'string', description: 'Generation prompt' },
          aspectRatio: { type: 'string', enum: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] },
          imageSize: { type: 'string', enum: ['1K', '2K', '4K'] },
          thinkingLevel: { type: 'string', enum: ['minimal', 'high'] },
          autoRefine: { type: 'boolean', description: 'If true, automatically run LAAJ and refine in a loop until converged or maxRounds reached' },
          maxRounds: { type: 'number', description: 'Maximum refinement rounds when autoRefine=true (default 3)' },
        },
        required: ['sessionId', 'prompt'],
      },
    },
    {
      name: 'refine_image',
      description: 'Refine a previously generated image using multi-turn with thoughtSignature.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          roundId: { type: 'string', description: 'The round ID to refine from' },
          instruction: { type: 'string', description: 'Refinement instruction' },
        },
        required: ['sessionId', 'roundId', 'instruction'],
      },
    },
    {
      name: 'edit_image',
      description: 'Edit an existing image using Gemini image-to-image generation. Provide the original image and a text instruction describing the desired change. Does not return thoughtSignature.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          roundId: { type: 'string', description: 'The round ID to edit' },
          prompt: { type: 'string', description: 'Edit instruction, e.g. "Replace background with pure white" or "Convert to watercolor style"' },
        },
        required: ['sessionId', 'roundId', 'prompt'],
      },
    },
    {
      name: 'get_session_status',
      description: 'Get the current status of a session (idle, generating, judging, refining, done, error). Use this to poll when autoRefine is running.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'abort_session',
      description: 'Abort an active auto-refine loop and return control to manual mode.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'export_session',
      description: 'Export all rounds and metadata of a session as JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
        },
        required: ['sessionId'],
      },
    },
    {
      name: 'reverse_prompt',
      description: 'Reverse-engineer a prompt from an image. Mode "text-to-image" returns a plain prompt. Mode "image-to-image" returns structured segments.',
      inputSchema: {
        type: 'object',
        properties: {
          imageBase64: { type: 'string' },
          mode: { type: 'string', enum: ['text-to-image', 'image-to-image'] },
        },
        required: ['imageBase64', 'mode'],
      },
    },
    {
      name: 'judge_image',
      description: 'Run LLM-as-a-Judge (LAAJ) evaluation on a generated image. Returns scores and improvement suggestions.',
      inputSchema: {
        type: 'object',
        properties: {
          imageBase64: { type: 'string' },
          prompt: { type: 'string', description: 'The prompt used to generate this image' },
          dimensions: { type: 'array', items: { type: 'string' } },
          threshold: { type: 'number', description: 'Score threshold for convergence (default 4)' },
        },
        required: ['imageBase64', 'prompt'],
      },
    },
    {
      name: 'choose_best',
      description: 'Ask the user to choose between two generated images via the web UI. Blocks until user makes a selection or times out.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID' },
          roundA: { type: 'string', description: 'Round ID of option A' },
          roundB: { type: 'string', description: 'Round ID of option B' },
          question: { type: 'string', description: 'Question to show the user, e.g. "Which pose looks more natural?"' },
        },
        required: ['sessionId', 'roundA', 'roundB'],
      },
    },
    {
      name: 'await_input',
      description: 'Wait for the user to provide a refinement instruction via the web UI. Blocks until input is received or times out.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'Session ID' },
          hint: { type: 'string', description: 'Hint text to show the user, e.g. "What would you like to change?"' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 300000)' },
        },
        required: ['sessionId'],
      },
    },
  ],
}));

mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await dispatchToolCall(request.params.name, request.params.arguments);
  } catch (err: any) {
    return { content: [{ type: 'text' as const, text: `Error: ${err.message ?? String(err)}` }], isError: true };
  }
});

export function registerMcp(app: Application) {
  app.get('/mcp/sse', async (_req: Request, res: Response) => {
    transport = new SSEServerTransport('/mcp/message', res);
    await mcpServer.connect(transport);
  });

  app.post('/mcp/message', async (req: Request, res: Response) => {
    if (!transport) {
      res.status(400).json({ error: 'No active SSE connection' });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });
}
