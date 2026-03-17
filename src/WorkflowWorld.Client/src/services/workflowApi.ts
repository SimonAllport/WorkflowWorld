import type { WorkflowDefinition, WorkflowInstance, WorkflowStats } from '../types/workflow';

const BASE = ''; // proxied via vite in dev, same origin in prod

async function fetchJson<T>(url: string): Promise<T> {
  const resp = await fetch(`${BASE}${url}`, { credentials: 'include' });
  if (!resp.ok) throw new Error(`API error: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

export async function getWorkflows(): Promise<WorkflowDefinition[]> {
  return fetchJson('/api/workflows');
}

export async function getWorkflow(id: string): Promise<WorkflowDefinition> {
  return fetchJson(`/api/workflows/${id}`);
}

export async function getInstances(workflowId: string): Promise<WorkflowInstance[]> {
  return fetchJson(`/api/workflows/${workflowId}/instances`);
}

export async function getStats(workflowId: string): Promise<WorkflowStats> {
  return fetchJson(`/api/workflows/${workflowId}/stats`);
}

export async function repairInstance(processInstanceId: number, comment?: string): Promise<boolean> {
  const resp = await fetch(`${BASE}/api/instances/${processInstanceId}/repair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ comment }),
  });
  return resp.ok;
}

export async function redirectInstance(processInstanceId: number, targetUser: string): Promise<boolean> {
  const resp = await fetch(`${BASE}/api/instances/${processInstanceId}/redirect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ targetUser }),
  });
  return resp.ok;
}

export async function goToActivity(processInstanceId: number, targetActivity: string): Promise<boolean> {
  const resp = await fetch(`${BASE}/api/instances/${processInstanceId}/goto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ targetActivityName: targetActivity }),
  });
  return resp.ok;
}

export async function stopInstance(processInstanceId: number): Promise<boolean> {
  const resp = await fetch(`${BASE}/api/instances/${processInstanceId}/stop`, {
    method: 'POST',
    credentials: 'include',
  });
  return resp.ok;
}
