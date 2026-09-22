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
    // Mounted at the root, not under Mastra's `/api` prefix — so `/circle/status`.
    apiRoutes: controlPlaneRoutes,
    // Studio sends no `user-id`, which `./tenancy` refuses. This names one for it.
    middleware: studioCallerMiddleware,
  },
  storage: new LibSQLStore({
    id: 'mastra-storage',
    // Point this at a hosted LibSQL/Postgres URL to survive a restart.
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
          new MastraStorageExporter(),
          new MastraPlatformExporter(), // Needs MASTRA_CLOUD_ACCESS_TOKEN.
        ],
        spanOutputProcessors: [
          new SensitiveDataFilter(),
        ],
      },
    },
  }),
});
