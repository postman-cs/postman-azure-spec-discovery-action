import { describe, expect, it } from 'vitest';

import { deriveOpenApiDocument } from '../src/lib/spec/oas-derivation.js';

describe('GraphQL SDL OpenAPI derivation', () => {
  it('creates a partial OpenAPI 3.0.3 /graphql POST shell before parsing SDL', () => {
    const result = deriveOpenApiDocument({
      content: 'type Query { ping: String! }',
      format: 'graphql-sdl',
      title: 'Payments GraphQL'
    });
    const document = JSON.parse(result!.content) as {
      openapi: string;
      paths: Record<string, {
        post: {
          requestBody: { content: Record<string, { schema: { properties: Record<string, unknown> } }> };
          responses: Record<string, unknown>;
        };
      }>;
    };

    expect(result).toMatchObject({ version: '3.0.3', completeness: 'partial', format: 'openapi-json' });
    expect(document.openapi).toBe('3.0.3');
    expect(document.paths['/graphql'].post.requestBody.content['application/json'].schema.properties).toEqual(
      expect.objectContaining({ query: expect.any(Object), operationName: expect.any(Object), variables: expect.any(Object) })
    );
    expect(document.paths['/graphql'].post.responses['200']).toBeDefined();
  });
});
