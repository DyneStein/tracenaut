import { transformAsync, transformSync, type TransformOptions } from '@babel/core';
import tracenautInstrument, { type InstrumentOptions } from './babel-plugin.js';

export { RUNTIME_GLOBAL, parseProbeId, type InstrumentOptions, type ProbeKind } from './babel-plugin.js';
export { createProbeRuntime, newProbeContext, type ProbeRuntime, type ProbeContext, type ProbeCall } from './runtime.js';

const INSTRUMENTABLE = /\.(m|c)?[jt]sx?$/;

export function isInstrumentable(filename: string) {
  return INSTRUMENTABLE.test(filename) && !filename.includes('/node_modules/') && !filename.endsWith('.d.ts');
}

function babelOptions(filename: string, options: InstrumentOptions, extra: TransformOptions): TransformOptions {
  const isTs = /\.(m|c)?tsx?$/.test(filename);
  const isTsx = filename.endsWith('.tsx');
  const plugins: NonNullable<NonNullable<TransformOptions['parserOpts']>['plugins']> = [];
  if (isTs) plugins.push('typescript');
  if (!isTs || isTsx) plugins.push('jsx');
  // Decorators (Angular-, NestJS- or MobX-style classes) are only parsed and printed back;
  // the code that implements them is left to the project's own compiler.
  plugins.push('decorators-legacy');
  return {
    filename,
    babelrc: false,
    configFile: false,
    sourceType: 'unambiguous',
    parserOpts: { plugins },
    generatorOpts: { decoratorsBeforeExport: true },
    plugins: [[tracenautInstrument, options]],
    ...extra,
  };
}

export async function instrument(code: string, filename: string, options: InstrumentOptions, extra: TransformOptions = {}) {
  return transformAsync(code, babelOptions(filename, options, extra));
}

export function instrumentSync(code: string, filename: string, options: InstrumentOptions, extra: TransformOptions = {}) {
  return transformSync(code, babelOptions(filename, options, extra));
}
