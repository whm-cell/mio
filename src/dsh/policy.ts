import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-tools';

/** The foundation and kernel own the same deny policy for their respective lifetimes. */
export function denyModelTools(ctx: Context): void {
  ctx.tools.guard(() => 'MIO_TOOL_DENIED: no model tool is authorized in the Mio profile');
}
