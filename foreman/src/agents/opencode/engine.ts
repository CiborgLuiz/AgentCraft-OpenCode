// OpenCode engine using the @opencode-ai/sdk v2.
import path from 'node:path';
import { createOpencode, createOpencodeClient } from "@opencode-ai/sdk/v2";
import { spawn } from "node:child_process";
import { findOpenCode } from "./find.js";
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
      const bin = findOpenCode(this.cfg.path) ?? '/home/ciborg/.opencode/bin/opencode';
      const proc = spawn(bin, ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
        env: { ...process.env, OPENCODE_CONFIG_CONTENT: '{}' },
      });
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          try { proc.kill('SIGTERM'); } catch {}
          resolve({ ok: false, message: 'Timeout waiting for server to start after 15000ms' });
        }, 15000);
        proc.stdout?.on('data', (d) => {
          const str = d.toString();
          if (str.includes('listening')) {
            clearTimeout(timeout);
            try { proc.kill('SIGTERM'); } catch {}
            resolve({ ok: true, account: 'opencode' });
          }
        });
        proc.on('error', (err) => {
          clearTimeout(timeout);
          resolve({ ok: false, message: err.message });
        });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: `OpenCode check failed: ${msg}` };
    }
  }

  async runTurn(spec: TurnSpec): Promise<TurnStats> {
    const stats: TurnStats = { isError: false, errors: [] };
    try {
      const oc = await createOpencode({ timeout: 60000 });
      const client = createOpencodeClient({ baseUrl: oc.server.url, headers: (oc as any).server?.password ? { 'x-opencode-password': (oc as any).server.password, authorization: `Bearer ${(oc as any).server.password}` } : {} });
      // also try setting token
      try { (client as any).client?.setConfig?.({ ...(client as any).client?.getConfig?.(), headers: { ...((client as any).client?.getConfig?.().headers||{}), 'x-opencode-password': (oc as any).server?.password } }); } catch {}


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

      if ((res as any)?.error) {
        oc.server.close();
        stats.isError = true;
        stats.errors.push(res.error instanceof Error ? res.error.message : (typeof res.error === 'object' ? JSON.stringify(res.error) : String(res.error)));
        return stats;
      }

      const sessionID = (res as any).data?.data?.id || (res as any).data?.id;
      spec.onSession(sessionID);
      const modelInfo = (res as any).data?.data?.model || (res as any).data?.model;
      if (modelInfo) {
        spec.onModel?.(`${modelInfo.providerID}/${modelInfo.id}`);
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
            const em = ev.properties?.message || (ev.properties ? JSON.stringify(ev.properties) : 'unknown error'); stats.errors.push(em);
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
