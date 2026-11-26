import { McpServer, ResourceTemplate, completable } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Service } from './bridge.js';
import { registerTaskTools, type TaskAccess } from './tasks.js';
import { getRecentActivity } from './activity.js';

function json(value: unknown): string { return JSON.stringify(value); }

export function createTaskServer(service: Service, access: TaskAccess): McpServer {
  const server = new McpServer({ name: 'PC Remote Commander Tasks', version: '0.1.0' }, {
    capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} },
  });
  registerTaskTools(server, service, access);

  server.registerResource('selected-device', 'app://pcrc/device/selected', { title: 'Selected computer', mimeType: 'application/json', description: 'Current approved workspace and local capability state' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: json(await service.call('jan_status')) }],
  }));
  server.registerResource('computer-use-skill', 'app://pcrc/skills/computer-use', { title: 'PCRC Computer Use', mimeType: 'text/markdown', description: 'Packaged Windows app, Office and bounded monitoring workflow; reading it grants no control' }, async (uri) => {
    const guide = await service.call('jan_skill_guide');
    const skill = guide.computer_use as { content?: unknown } | undefined;
    if (typeof skill?.content !== 'string') throw new Error('Packaged PCRC Computer Use skill unavailable; update the local runtime');
    return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: skill.content }] };
  });
  server.registerResource('recent-activity', 'app://pcrc/activity/recent', { title: 'Recent activity', mimeType: 'application/json', description: 'Tool names, outcomes and latency without inputs or content' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: json({ events: getRecentActivity() }) }],
  }));
  server.registerResource('shared-tasks', 'app://pcrc/tasks/recent', { title: 'Task assignments', mimeType: 'application/json', description: 'The connected assistant task, reserved resources and handoff notes without lease tokens' }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: json(await service.call('jan_task_state')) }],
  }));
  server.registerResource('file', new ResourceTemplate('app://pcrc/files/{fileId}', { list: undefined }), {
    title: 'Workspace file', mimeType: 'application/json', description: 'A bounded UTF-8 file in the approved workspace',
  }, async (uri, variables) => {
    const fileId = variables.fileId;
    if (typeof fileId !== 'string' || !fileId || fileId.length > 512) throw new Error('Invalid file ID');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: json(await service.call('jan_read_text', { path: fileId })) }] };
  });
  if (access.control && access.capabilities.has('commands')) server.registerResource('process', new ResourceTemplate('app://pcrc/processes/{processId}', { list: undefined }), {
    title: 'Owned process', mimeType: 'application/json', description: 'Bounded output and state for an owned process',
  }, async (uri, variables) => {
    const processId = variables.processId;
    if (typeof processId !== 'string' || !processId || processId.length > 128) throw new Error('Invalid process ID');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: json(await service.call('jan_process_output', { session_id: processId, length: 4096 })) }] };
  });

  const prompt = (name: string, description: string, instruction: string) => server.registerPrompt(name, {
    description, argsSchema: z.object({ goal: completable(z.string().min(1).max(1000), (value) => [
      'Check whether my computer is connected', 'Find a file in my workspace', 'Review a safe file edit',
      'Diagnose a project command', 'Inspect the controlled browser', 'Assist with the desktop',
    ].filter((option) => option.toLowerCase().includes(String(value).toLowerCase())).slice(0, 5)) }),
  }, async ({ goal }) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `${instruction}\nGoal: ${goal}` } }] }));
  prompt('troubleshoot_connection', 'Diagnose a computer that is offline or denied', 'Call get_connection_status and get_capabilities. Explain the exact next step without requesting credentials.');
  prompt('find_and_review_file', 'Find and summarize a workspace file', 'Search by filename, inspect the chosen file, then read only the lines needed. Cite its relative path.');
  prompt('reviewed_file_edit', 'Preview and apply a safe text edit', 'Inspect and read the file, call preview_file_edit, present the concrete diff, and apply only after explicit user approval.');
  prompt('run_project_task', 'Run a project command with bounded output', 'Prefer run_diagnostic. If an arbitrary command is necessary, present it for approval, run it, then report exit status and any output limits.');
  prompt('work_in_browser', 'Navigate or interact with the isolated browser', 'List tabs and inspect the page first. Request approval before navigation, clicking, or filling. Do not enter passwords or OTP.');
  prompt('work_in_office', 'Work with an approved Excel, Word, PowerPoint or Outlook task', 'Call suggest_workflow with the app and goal. Read its steps. Identify the installed app with list_applications, obtain approval to open it, preserve originals and verify a reopened output. A COM script or launch acknowledgement is not proof of successful Office editing.');
  prompt('monitor_app_task', 'Observe a bounded app or owned process task', 'Call suggest_workflow for monitor desktop app. Agree on scope, interval, duration and stop condition. Prefer owned process output; use fresh screenshots only after privacy readiness. Monitoring does not authorize edits, retries or closing unrelated apps.');
  prompt('assist_on_desktop', 'Help with a visible desktop task', 'Capture a fresh frame, identify the target, request approval, and use that frame ID for one action. Reinspect after each action.');
  prompt('coordinate_assistants', 'Run one task safely with the single connected AI assistant', 'Inspect list_tasks before starting. Create one task and claim it immediately with the exact resources required; only one assignment may be active. Never split the work across AI identities or create waiting claims. If claim_task returns TASK_CONFLICT, inspect the active task and finish it before retrying. If it returns TASK_REVIEW_REQUIRED, inspect actual file/process/UI state and reconcile only after review. Include task_id and lease_token on assigned operations and renew within 120 seconds. Reinspect files and hashes before edits and handoff. Never replay an uncertain mutation automatically.');
  prompt('teach_browser_task', 'Teach and replay a reviewed browser task', 'Claim a ui task, open the isolated browser and ask the user to demonstrate stable controls. Start teaching, finish into a draft, inspect every recorded step and input parameter, then publish with expected completion text after review. Start a run and request approval before each exact next step. Query-bearing links, credentials, uploads and arbitrary desktop recording are unsupported.');
  return server;
}
