import { isUuidV4 } from './identifiers.ts';
import { utcISOString } from './time.ts';

export type LogLevel = 'info' | 'warn' | 'error';
export interface LogContext {
  requestId?: string;
  jobId?: string;
  attemptId?: string;
  messageId?: string;
}
export type LogSink = (line: string, level: LogLevel) => void | Promise<void>;

const handledStreams = new WeakSet<NodeJS.WriteStream>();
const blockedStreams = new WeakSet<NodeJS.WriteStream>();
const standardSink: LogSink = (line, level) => {
  const stream = level === 'info' ? process.stdout : process.stderr;
  if (!handledStreams.has(stream)) {
    stream.on('error', () => {});
    handledStreams.add(stream);
  }
  if (blockedStreams.has(stream)) return;
  if (!stream.write(line, () => {})) {
    blockedStreams.add(stream);
    stream.once('drain', () => blockedStreams.delete(stream));
  }
};

function safeContext(context: LogContext): LogContext {
  const safe: LogContext = {};
  for (const key of ['requestId', 'jobId', 'attemptId', 'messageId'] as const) {
    const value = context[key];
    if (typeof value === 'string' && isUuidV4(value)) safe[key] = value;
  }
  return safe;
}

/** service, component and event are fixed application labels, never user input. */
export function createLogger(service: string, component: string, sink: LogSink = standardSink) {
  const safeService = /^[a-z][a-z0-9-]{0,31}$/.test(service) ? service : 'invalid';
  const safeComponent = /^[a-z][a-z0-9-]{0,31}$/.test(component) ? component : 'invalid';
  const logger = (context: LogContext) => ({
    child: (extra: LogContext) => logger({ ...context, ...safeContext(extra) }),
    info: (event: string, extra: LogContext = {}) => write('info', event, context, extra),
    warn: (event: string, extra: LogContext = {}) => write('warn', event, context, extra),
    error: (event: string, extra: LogContext = {}) => write('error', event, context, extra),
  });
  const write = (level: LogLevel, event: string, context: LogContext, extra: LogContext) => {
    try {
      const safeEvent = /^[A-Z][A-Z0-9_]{0,79}$/.test(event) ? event : 'INVALID_EVENT';
      const written = sink(
        `${JSON.stringify({ timestamp: utcISOString(), level, service: safeService, component: safeComponent, event: safeEvent, ...context, ...safeContext(extra) })}\n`,
        level,
      );
      if (written) void written.catch(() => {});
    } catch {
      // Logging must not alter the business outcome.
    }
  };
  return logger({});
}
