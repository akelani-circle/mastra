import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { PinoLogger } from '@mastra/loggers';
import {
  Observability,
  MastraStorageExporter,
  MastraPlatformExporter,
  SensitiveDataFilter,
} from '@mastra/observability';
import { circlePaymentAgent } from './agents/circle-payment-agent';
import { controlPlaneRoutes } from './control-plane';
import { studioCallerMiddleware } from './studio';

export const mastra = new Mastra({
  agents: { circlePaymentAgent },
  server: {
    // Terms acceptance and OTP login, for a front end whose user has no shell. Mounted at the root
    // rather than under Mastra's `/api` prefix — so `/circle/status` — and gated on
    // `CONTROL_PLANE_TOKEN`. See `./control-plane`.
    apiRoutes: controlPlaneRoutes,
    // Studio sends no `user-id`, which `./tenancy` refuses. This names one for it. See `./studio`.
    middleware: studioCallerMiddleware,
  },
  storage: new LibSQLStore({
    id: 'mastra-storage',
    // In memory only. Point this at a hosted LibSQL/Postgres URL to survive a restart.
    url: ':memory:',
  }),
  logger: new PinoLogger({
    name: 'Mastra',
    level: 'info',
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [
          new MastraStorageExporter(), // Persists observability events to Mastra Storage
          new MastraPlatformExporter(), // Sends observability events to Mastra Platform (if MASTRA_CLOUD_ACCESS_TOKEN is set)
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(), // Redacts sensitive data like passwords, tokens, keys
        ],
      },
    },
  }),
});
