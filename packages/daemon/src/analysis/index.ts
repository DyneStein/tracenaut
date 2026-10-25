// Entry point for tests and embedders: the analysis engine without the HTTP server.
export { Analyzer } from './analyzer.js';
export { matchRoute } from './routes.js';
export { loadWorkspace } from '../workspace.js';
export { buildTrace } from '../runtime/merge.js';
export { JourneyBuilder } from '../journey/flow.js';
export { detectStack } from '../stack.js';
