import type { Response } from 'express';

const sseClients = new Map<string, Set<Response>>();

export function broadcast(sessionId: string, data: unknown): void {
  const clients = sseClients.get(sessionId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  const dead = new Set<Response>();
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      dead.add(res);
    }
  }
  for (const res of dead) {
    clients.delete(res);
  }
}

export function addClient(sessionId: string, res: Response): void {
  if (!sseClients.has(sessionId)) sseClients.set(sessionId, new Set());
  sseClients.get(sessionId)!.add(res);
}

export function removeClient(sessionId: string, res: Response): void {
  sseClients.get(sessionId)?.delete(res);
}

export { sseClients };
