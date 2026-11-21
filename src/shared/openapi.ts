import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { registry } from './route';

export function generateOpenApiSpec() {
  // Register bearerAuth security scheme before generating
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.0',
    info: { title: 'MARBOU API', version: '1.0.0', description: 'MARBOU Arabic-first classifieds marketplace' },
    servers: [{ url: '/api/v1', description: 'API v1' }],
  });
}
