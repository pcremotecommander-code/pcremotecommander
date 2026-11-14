import { readFileSync } from 'node:fs';
import { inspectPublicOutput, PrivacyError, type PrivacyRules } from './privacy-guard.js';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export const serviceImages: unique symbol = Symbol('serviceImages');
export type ServiceImage = { data: string; mimeType: 'image/jpeg' | 'image/png' };
export type ServiceData = Record<string, unknown> & { [serviceImages]?: ServiceImage[] };
export interface Service {
  call(name: string, args?: Record<string, unknown>): Promise<ServiceData>;
  close?(): Promise<void>;
}

export class ServiceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ServiceError'; }
}

const privacyRules = JSON.parse(readFileSync(new URL('../../../src/jan_mcp_commander/privacy-rules.json', import.meta.url), 'utf8')) as PrivacyRules;
export function privacyPolicy():ServiceData {
  return {enabled:true,rules_version:privacyRules.version,mode:'block detected sensitive plaintext',protected:['labeled passwords, PINs, OTPs and secret IDs','known tokens and private keys','validated payment card numbers','labeled government identifiers'],limitations:['High-confidence detection only; unlabeled or encoded secrets may not be recognized.','Screenshot pixels and arbitrary application internals are not universally inspected.','Approved arbitrary commands are not an operating-system sandbox.'],user_action:'Enter credentials privately yourself. Use non-sensitive sample content for automation.'};
}

export function assertPublicOutput(values: unknown[]): void {
  try { inspectPublicOutput(values, privacyRules); }
  catch (error) { if (error instanceof PrivacyError) throw new ServiceError(error.code, error.message); throw error; }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function serviceResult(response: { structuredContent?: unknown; content?: unknown }): ServiceData {
  let result: ServiceData | null = record(response.structuredContent) ? response.structuredContent : null;
  const content = Array.isArray(response.content) ? response.content : [];
  if (!result) {
    const text = content.find((part) => record(part) && part.type === 'text' && typeof part.text === 'string')?.text;
    if (typeof text === 'string') {
      try { const parsed: unknown = JSON.parse(text); if (record(parsed)) result = parsed; } catch { /* Return non-JSON service text as text. */ }
      if (!result) result = { text };
    }
  }
  result ??= {};
  const textValues = content.flatMap(part => {
    if (!record(part) || part.type !== 'text' || typeof part.text !== 'string') return [];
    return [part.text];
  });
  assertPublicOutput([result, ...textValues]);
  const images: ServiceImage[] = [];
  for (const part of content) {
    if (!record(part) || part.type !== 'image' || (part.mimeType !== 'image/jpeg' && part.mimeType !== 'image/png') ||
        typeof part.data !== 'string' || part.data.length > 700000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data)) continue;
    images.push({ data: part.data, mimeType: part.mimeType });
    if (images.length === 2) break;
  }
  if (images.length) result[serviceImages] = images;
  return result;
}
type PythonOptions = { python?: string; workspace: string; control?: boolean; capabilities?: string; durationMinutes?: number; browserChannel?: string;foreground?:boolean };

export function pythonServiceArgs(options: PythonOptions): string[] {
  if (!options.control) return ['-m', 'jan_mcp_commander.server'];
  const duration = options.durationMinutes ?? 60;
  const channel = options.browserChannel ?? 'chromium';
  if (!Number.isInteger(duration) || duration < 1 || duration > 480 || !['chromium', 'chrome', 'msedge'].includes(channel)) throw new Error('Invalid local control lease');
  return ['-m', 'jan_mcp_commander.control', '--workspace', options.workspace, '--capabilities', options.capabilities || 'files', '--duration-minutes', String(duration), '--browser-channel', channel, '--transport', 'stdio',...(options.foreground?['--foreground','--foreground-parent-pid',String(process.pid)]:[])];
}

export class PythonService implements Service {
  private client: Client;
  private transport: StdioClientTransport;
  private ready: Promise<void>;
  private closing = false;

  constructor(options: PythonOptions & { python: string }) {
    if (!options.workspace) throw new Error('JAN_MCP_WORKSPACE must name an approved folder');
    this.client = new Client({ name: 'pcremotecommander-task-bridge', version: '0.1.0' });
    this.transport = new StdioClientTransport({
      command: options.python,
      args: pythonServiceArgs(options),
      env: { ...process.env, JAN_MCP_WORKSPACE: options.workspace } as Record<string, string>,
      stderr: 'inherit',
    });
    this.ready = this.client.connect(this.transport);
    void this.ready.catch(() => undefined);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ServiceData> {
    if(this.closing)throw new ServiceError('CONNECTION_CLOSED','Local connection closed; inspect prior action receipts before reconnecting. No automatic retry.');
    await this.ready;
    if(this.closing)throw new ServiceError('CONNECTION_CLOSED','Local connection closed; inspect prior action receipts before reconnecting. No automatic retry.');
    const response = await this.client.callTool({ name, arguments: args });
    if (response.isError) {
      const error = serviceResult(response);
      if (typeof error.error_code === 'string' && /^[A-Z_]{3,48}$/.test(error.error_code) && typeof error.error === 'string') {
        throw new ServiceError(error.error_code, error.error.slice(0, 500));
      }
      const detail = response.content?.filter((part) => part.type === 'text').map((part) => part.text).join(' ') || 'Service denied the action';
      throw new Error(`${name}: ${detail.slice(0, 500)}`);
    }
    return serviceResult(response);
  }

  async close(): Promise<void> {
    this.closing = true;
    await this.client.close();
  }
}
