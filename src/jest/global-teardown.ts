/**
 * @file
 *
 * Jest global teardown entry point.
 *
 * Jest requires `globalTeardown` to be a separate module whose default export is
 * the teardown function. It re-exports the teardown from the setup module so both
 * share the same setup state within the Jest parent process.
 */

/* v8 ignore start -- Integration-time teardown covered by integration tests, not unit tests. */

// eslint-disable-next-line import-x/no-default-export -- Jest's globalTeardown loader requires a default-export function.
export { teardown as default } from './global-setup.ts';

/* v8 ignore stop */
