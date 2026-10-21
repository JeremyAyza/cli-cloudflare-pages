import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

export const server = setupServer();

// msw 3 renamed `onUnhandledRequest` to `onUnhandledFrame`; 'error' makes unmocked requests fail instead of hitting the network.
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  server.resetHandlers();
  server.events.removeAllListeners();
});
afterAll(() => server.close());
