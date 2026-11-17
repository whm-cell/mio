/** Formal Profile waits for the kernel without imposing it on standalone plugin users. */
export { name, Config, apply } from './plugin.ts';
export const inject = ['webServer', 'tools', 'mioKernel'];
