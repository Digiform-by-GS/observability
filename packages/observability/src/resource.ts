import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import type { Resource } from '@opentelemetry/resources';
import type { ResolvedConfig } from './types.js';

const ATTR_DEPLOYMENT_ENVIRONMENT = 'deployment.environment';

export function buildResource(config: ResolvedConfig): Resource {
  return resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    [ATTR_DEPLOYMENT_ENVIRONMENT]: config.environment,
    ...config.resourceAttributes,
  });
}
