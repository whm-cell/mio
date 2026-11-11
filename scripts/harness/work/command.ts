import { spawn } from 'node:child_process';
import type { StdioOptions } from 'node:child_process';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { checkedPath, deliveryPending, identifier, json } from './records.ts';
import { readConflict, recordConflict } from './reconciliation.ts';

export interface CommandActivity {
  path: string;
  owner: { version: number; pid: number; command: string; child?: number };
  retain: boolean;
}

/** Serialize cooperating commands before they read state; never steal an interrupted marker. */
export async function withTaskCommand<T>(
  root: string,
  id: string,
  command: string,
  action: (activity: CommandActivity) => Promise<T>,
): Promise<T> {
  const path = await checkedPath(root, `.work/tasks/${identifier(id)}.command.json`);
  await mkdir(dirname(path), { recursive: true });
  let marker;
  try {
    marker = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error(
      `WORK_BUSY: ${id} has an active or interrupted command; inspect ${path}. Wait for it to finish; recovery: docs/work-records.md#命令占用与异常恢复`,
    );
  }
  const activity: CommandActivity = {
    path,
    owner: { version: 1, pid: process.pid, command },
    retain: false,
  };
  try {
    await marker.writeFile(json(activity.owner));
    if (command !== 'update' && (await readConflict(root, id)) !== null)
      throw new Error(
        `WORK_RECONCILE: ${id} has an unresolved conflict; inspect context and .work/tasks/${id}/conflict.json, then use update with the current revision and a reconciliation reason`,
      );
    try {
      return await action(activity);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('WORK_CONFLICT:')) {
        // A pending delivery must be replayed first, not trapped behind another recovery gate.
        if (await deliveryPending(root, id))
          throw new Error('WORK_DELIVERY_PENDING: resume the original delivery request first');
        try {
          await recordConflict(root, id, command, message);
        } catch (failure) {
          activity.retain = true;
          throw new Error(`${message}; WORK_RECONCILE_WRITE: ${failure}; retained ${path}`);
        }
      }
      throw error;
    }
  } finally {
    await marker.close();
    if (!activity.retain) await rm(path);
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Keep the task occupied until the foreground command and its POSIX execution group end. */
export async function runCommand(
  root: string,
  argv: string[],
  stdio: StdioOptions,
  activity: CommandActivity,
) {
  const grouped = process.platform !== 'win32';
  const child = spawn(argv[0]!, argv.slice(1), { cwd: root, stdio, detached: grouped });
  activity.retain = true;
  let cancelled = false;
  const forward = (signal: NodeJS.Signals) => {
    cancelled = true;
    if (!child.pid) return;
    try {
      if (grouped) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  const finished = new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolve) => {
    child.once('error', (error) => resolve({ status: null, signal: null, error }));
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  let markerError: Error | undefined;
  try {
    if (child.pid) {
      activity.owner.child = child.pid;
      try {
        await writeFile(activity.path, json(activity.owner));
      } catch (error) {
        markerError = error as Error;
        forward('SIGTERM');
      }
    }
    const outcome = await finished;
    // Group members may need a short interval to finish after their leader closes.
    for (let attempt = 0; grouped && child.pid && groupExists(child.pid) && attempt < 20; attempt++)
      await setTimeout(50);
    const unsettled = grouped && child.pid ? groupExists(child.pid) : cancelled && !grouped;
    activity.retain = unsettled;
    if (unsettled)
      console.error(`WORK_CHILD_ACTIVE: execution may continue; retained ${activity.path}`);
    return { ...outcome, error: markerError ?? outcome.error, cancelled, unsettled };
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
