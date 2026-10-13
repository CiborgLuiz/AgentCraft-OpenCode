// OpenCode engine using the @opencode-ai/sdk v2.
import path from 'node:path';
import { createOpencode, createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { OpenCodeConfig } from '../../config.js';
import type { Foreman } from '../../foreman.js';
import type { AuthCheck, Engine, Role, TurnSpec, TurnStats } from '../engine.js';

export class OpenCodeEngine implements Engine {
  readonly id = 'opencode' as const;
  readonly label = 'OpenCode';

  constructor(
    private fm: Foreman,
    private cfg: OpenCodeConfig,
  ) {}

  model(role: Role): string {
    return role === 'lead' ? this.cfg.leadModel ?? 'default' : this.cfg.workerModel ?? 'default';
  }

  authFailedMessage(detail: string): string {
    return `OpenCode authentication failed (${detail}). Check your OpenCode auth/config, then restart the Foreman.`;
  }

  async checkAuth(): Promise<AuthCheck> {
    try {
      const oc = await createOpencode({ timeout: 15000 });
      oc.server.close();
      return { ok: true, account: 'opencode' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: `OpenCode check failed: ${msg}` };
    }
  }

  async runTurn(spec: TurnSpec): Promise<TurnStats> {
    const stats: TurnStats = { isError: false, errors: [] };
    try {
      const oc = await createOpencode({ timeout: 20000 });
      const client = createOpencodeClient({ baseUrl: oc.server.url });

      // Create session
      const res = await client.v2.session.create({
        location: {
          directory: path.dirname(spec.cwd),
          workspaceID: spec.cwd,
        },
        model: this.model(spec.role) && this.model(spec.role) !== 'default' ? (() => {
          const m = this.model(spec.role);
          const hasSlash = m.includes('/');
          return hasSlash ? { id: m.split('/')[1]!, providerID: m.split('/')[0]! } : { id: m, providerID: 'default' };
        })() : undefined,
      });

      if (res.error) {
        oc.server.close();
        stats.isError = true;
        stats.errors.push(String(res.error));
        return stats;
      }

      const sessionID = res.data.data.id;
      spec.onSession(sessionID);
      if (res.data.data.model) {
        spec.onModel?.(`${res.data.data.model.providerID}/${res.data.data.model.id}`);
      }

      // Send prompt
      await client.v2.session.prompt({
        sessionID,
        prompt: { text: spec.prompt },
      });

      // Subscribe to events and wait for completion
      try {
        const events = await client.v2.session.events({ sessionID });
        const stream = events.stream;
        for await (const event of stream) {
          if (spec.abort.signal.aborted) break;
          const ev = event as any;
          if (ev?.type === 'session.error') {
            stats.isError = true;
            stats.errors.push(ev.properties?.message || 'unknown error');
          }
        }
      } catch (e) {
        if (!spec.abort.signal.aborted) {
          // Ignore if it's just the stream ending
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('abort') || msg.includes('closed')) {
            // expected on abort
          } else {
            stats.isError = true;
            stats.errors.push(msg);
          }
        }
      }

      oc.server.close();
      return stats;
    } catch (e) {
      stats.isError = true;
      stats.errors.push(e instanceof Error ? e.message : String(e));
      return stats;
    }
  }
}
