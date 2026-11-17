import { record, textField } from './report-format.ts';

export interface Conditions {
  dependencies: string;
  configuration: string;
  external: string;
}

export const runtimeEnvironment = () =>
  `${process.platform}/${process.arch}; Node ${process.version}`;

/** Record observed conditions without reading or storing secret environment values. */
export function conditions(value: unknown): Conditions {
  const item = record(value);
  return {
    dependencies: textField(item.dependencies),
    configuration: textField(item.configuration),
    external: textField(item.external),
  };
}
