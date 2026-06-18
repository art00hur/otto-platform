#!/usr/bin/env node
/**
 * Otto CRM MCP Server — Exposes Pipedrive CRM tools via MCP stdio protocol.
 *
 * Runs as a subprocess of OpenClaw. Agents call tools like
 * "crm_list_deals" natively instead of crafting HTTP requests.
 *
 * Usage:
 *   node crm-server.mjs
 *
 * Environment:
 *   OTTO_BACKEND_URL  — Backend URL (default: https://api.otto-ai.co)
 *   OTTO_INSTANCE_ID  — Instance ID for CRM auth
 *   OTTO_AGENT_KEY    — Agent CRM key for auth
 */

import { createInterface } from 'readline';

const BACKEND_URL = process.env.OTTO_BACKEND_URL || 'https://api.otto-ai.co';
const INSTANCE_ID = process.env.OTTO_INSTANCE_ID || '';
const AGENT_KEY = process.env.OTTO_AGENT_KEY || '';

// ── MCP Protocol ──

const TOOLS = [
  {
    name: 'crm_list_deals',
    description: 'Liste les deals du CRM Pipedrive. Retourne les deals avec titre, montant, stage, organisation.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Nombre max de deals (defaut: 50)', default: 50 },
        stageId: { type: 'string', description: 'Filtrer par stage ID' },
        pipelineId: { type: 'string', description: 'Filtrer par pipeline ID' },
      },
    },
  },
  {
    name: 'crm_get_deal',
    description: 'Detail complet d\'un deal par son ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'ID du deal' },
      },
      required: ['id'],
    },
  },
  {
    name: 'crm_search_contacts',
    description: 'Recherche de contacts par nom, email ou telephone.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Terme de recherche' },
        limit: { type: 'number', description: 'Nombre max de resultats (defaut: 20)', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'crm_list_pipelines',
    description: 'Liste tous les pipelines avec leurs stages.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'crm_list_organizations',
    description: 'Liste les organisations/entreprises du CRM.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Nombre max (defaut: 50)', default: 50 },
      },
    },
  },
  {
    name: 'crm_get_recent_changes',
    description: 'Changements recents dans le CRM (deals, contacts, activites modifies).',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Date ISO 8601 depuis laquelle chercher (ex: 2026-03-29T00:00:00Z)' },
      },
      required: ['since'],
    },
  },
  {
    name: 'crm_create_activity',
    description: 'Creer une activite (appel, reunion, email, tache) dans Pipedrive.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['call', 'email', 'meeting', 'task'], description: 'Type d\'activite' },
        subject: { type: 'string', description: 'Sujet de l\'activite' },
        activityDate: { type: 'string', description: 'Date YYYY-MM-DD' },
        body: { type: 'string', description: 'Notes/description' },
        dealId: { type: 'string', description: 'ID du deal associe' },
      },
      required: ['type', 'subject', 'activityDate'],
    },
  },
  {
    name: 'crm_add_note',
    description: 'Ajouter une note a un deal ou un contact dans Pipedrive.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'Contenu de la note' },
        dealId: { type: 'string', description: 'ID du deal' },
        contactId: { type: 'string', description: 'ID du contact' },
      },
      required: ['body'],
    },
  },
];

// Map MCP tool name → CRM action + param mapping
const TOOL_MAP = {
  crm_list_deals: { action: 'listDeals', mapParams: (p) => ({ limit: p.limit || 50, stageId: p.stageId, pipelineId: p.pipelineId }) },
  crm_get_deal: { action: 'getDeal', mapParams: (p) => ({ id: p.id }) },
  crm_search_contacts: { action: 'searchContacts', mapParams: (p) => ({ query: p.query, limit: p.limit || 20 }) },
  crm_list_pipelines: { action: 'listPipelines', mapParams: () => ({}) },
  crm_list_organizations: { action: 'listOrganizations', mapParams: (p) => ({ limit: p.limit || 50 }) },
  crm_get_recent_changes: { action: 'getRecentChanges', mapParams: (p) => ({ since: p.since }) },
  crm_create_activity: { action: 'createActivity', mapParams: (p) => ({ type: p.type, subject: p.subject, activityDate: p.activityDate, body: p.body, dealIds: p.dealId ? [p.dealId] : undefined }) },
  crm_add_note: { action: 'addNote', mapParams: (p) => ({ body: p.body, dealId: p.dealId, contactId: p.contactId }) },
};

async function callCRM(action, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(`${BACKEND_URL}/api/internal/crm/action`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-instance-id': INSTANCE_ID,
        'x-agent-crm-key': AGENT_KEY,
      },
      body: JSON.stringify({ action, params }),
      signal: controller.signal,
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || data.detail || `HTTP ${res.status}`);
    return data.data;
  } finally {
    clearTimeout(timeout);
  }
}

// ── JSON-RPC stdio handler ──

function sendResponse(id, result) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function sendError(id, code, message) {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

async function handleRequest(req) {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      return sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'otto-crm', version: '1.0.0' },
      });

    case 'notifications/initialized':
      return; // No response needed

    case 'tools/list':
      // Only expose tools when CRM is configured (agent key present)
      if (!INSTANCE_ID || !AGENT_KEY) {
        return sendResponse(id, { tools: [] });
      }
      return sendResponse(id, { tools: TOOLS });

    case 'tools/call': {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const mapping = TOOL_MAP[toolName];

      if (!mapping) {
        return sendError(id, -32602, `Unknown tool: ${toolName}`);
      }

      if (!INSTANCE_ID || !AGENT_KEY) {
        return sendResponse(id, {
          content: [{ type: 'text', text: 'Erreur: CRM non configure. Connecte Pipedrive depuis le dashboard Otto.' }],
          isError: true,
        });
      }

      try {
        const result = await callCRM(mapping.action, mapping.mapParams(toolArgs));
        return sendResponse(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        return sendResponse(id, {
          content: [{ type: 'text', text: `Erreur CRM: ${err.message}` }],
          isError: true,
        });
      }
    }

    default:
      if (method?.startsWith('notifications/')) return; // Ignore notifications
      return sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ── Main loop ──

const rl = createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  try {
    const req = JSON.parse(line);
    await handleRequest(req);
  } catch (err) {
    process.stderr.write(`MCP parse error: ${err.message}\n`);
  }
});

process.stderr.write('Otto CRM MCP server started\n');
