import type { MediaExecutor } from './media-execution.ts';
import { executeBasic } from './plans/basic.ts';
import { executeTrim } from './plans/trim.ts';

export const executeMedia: MediaExecutor = (command, context) => {
  return command.operation === 'video.trim'
    ? executeTrim(command, context)
    : executeBasic(command, context);
};
