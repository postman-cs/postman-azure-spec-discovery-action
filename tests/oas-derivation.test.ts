import { describe, expect, it } from 'vitest';

import { applyDeclaredFidelity, deriveOpenApiDocument } from '../src/lib/spec/oas-derivation.js';

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

describe('OpenAPI derivation fidelity', () => {
  it('keeps OpenAPI 3.x full and Swagger 2.0 partial, without upgrading declared fidelity', () => {
    const openapi31 = deriveOpenApiDocument({
      content: JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'api', version: '1' },
        paths: { '/a': {} }
      }),
      format: 'openapi-json'
    });
    expect(openapi31).toMatchObject({ completeness: 'full', version: '3.1.0' });

    const swagger = deriveOpenApiDocument({
      content: JSON.stringify({
        swagger: '2.0',
        info: { title: 'api', version: '1' },
        paths: { '/a': {} }
      }),
      format: 'openapi-json'
    });
    expect(swagger).toMatchObject({ completeness: 'partial', version: '3.0.3' });

    expect(applyDeclaredFidelity(openapi31!, { completeness: 'partial' }).completeness).toBe('partial');
    expect(applyDeclaredFidelity(openapi31!, { contractClass: 'reconstructed' }).completeness).toBe('partial');
    expect(applyDeclaredFidelity(swagger!, { contractClass: 'authoritative' }).completeness).toBe('partial');
  });

  it('does not invent full completeness for native non-OpenAPI formats', () => {
    expect(
      deriveOpenApiDocument({
        content: 'asyncapi: 2.6.0\ninfo:\n  title: e\n  version: "1"\nchannels:\n  ping: {}\n',
        format: 'asyncapi-yaml'
      })
    ).toBeUndefined();

    expect(
      deriveOpenApiDocument({
        content: 'syntax = "proto3";\nmessage Ping { string id = 1; }\n',
        format: 'protobuf'
      })
    ).toBeUndefined();
  });
});
