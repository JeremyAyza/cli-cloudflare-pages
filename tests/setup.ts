import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { settleRecordedRequests } from './helpers/cf.js';

export const server = setupServer();

// msw 3 renamed `onUnhandledRequest` to `onUnhandledFrame`; 'error' makes unmocked requests fail instead of hitting the network.
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(async () => {
  server.resetHandlers();
  server.events.removeAllListeners();
  await settleRecordedRequests();
});
afterAll(() => server.close());
