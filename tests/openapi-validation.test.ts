import { describe, expect, it } from 'vitest';

import { parseAndValidateOpenApi } from '../src/lib/spec/validate-openapi.js';

describe('OpenAPI export validation', () => {
  it('AZ-APIM-005: malformed JSON, unsupported version, missing paths, and empty paths reject', () => {
    expect(() => parseAndValidateOpenApi('{not json')).toThrow(/not parseable/);
    expect(() =>
      parseAndValidateOpenApi(JSON.stringify({ openapi: '4.0.0', info: {}, paths: { '/a': {} } }))
    ).toThrow('Specification is not Swagger 2.0 or OpenAPI 3.x');
    expect(() => parseAndValidateOpenApi(JSON.stringify({ openapi: '3.0.3', info: {} }))).toThrow(
      'Specification has no paths object'
    );
    expect(() => parseAndValidateOpenApi(JSON.stringify({ openapi: '3.0.3', info: {}, paths: {} }))).toThrow(
      'Specification has an empty paths object'
    );
  });

  it('AZ-APIM-005: valid Swagger 2.0 and OpenAPI 3.0 JSON with one path succeed', () => {
    const swagger = parseAndValidateOpenApi(
      JSON.stringify({ swagger: '2.0', info: { title: 'l', version: '1' }, paths: { '/a': {} } })
    );
    expect(swagger.version).toBe('swagger-2.0');
    expect(swagger.isJson).toBe(true);

    const openapi = parseAndValidateOpenApi(
      JSON.stringify({ openapi: '3.0.3', info: { title: 'p', version: '1' }, paths: { '/a': {} } })
    );
    expect(openapi.version).toBe('openapi-3.0');

    const yaml = parseAndValidateOpenApi('openapi: 3.1.0\ninfo:\n  title: y\n  version: "1"\npaths:\n  /a: {}\n');
    expect(yaml.version).toBe('openapi-3.1');
    expect(yaml.isJson).toBe(false);
  });

  it('accepts OpenAPI 2.0, 3.0.x, and 3.1.x separately and rejects empty/wrong-kind', () => {
    expect(
      parseAndValidateOpenApi(
        JSON.stringify({ swagger: '2.0', info: { title: 's', version: '1' }, paths: { '/pets': {} } })
      ).version
    ).toBe('swagger-2.0');

    expect(
      parseAndValidateOpenApi(
        'openapi: 3.0.1\ninfo:\n  title: a\n  version: "1"\npaths:\n  /a: {}\n'
      )
    ).toMatchObject({ version: 'openapi-3.0', isJson: false });

    expect(
      parseAndValidateOpenApi(
        JSON.stringify({ openapi: '3.1.0', info: { title: 'b', version: '1' }, paths: { '/b': {} } })
      )
    ).toMatchObject({ version: 'openapi-3.1', isJson: true });

    expect(() => parseAndValidateOpenApi('')).toThrow(/empty/i);
    expect(() =>
      parseAndValidateOpenApi(
        JSON.stringify({
          asyncapi: '2.6.0',
          info: { title: 'events', version: '1' },
          channels: { ping: {} }
        })
      )
    ).toThrow(/Swagger 2\.0 or OpenAPI 3\.x/);
    expect(() =>
      parseAndValidateOpenApi('<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"/>')
    ).toThrow(/not parseable|Swagger 2\.0 or OpenAPI 3\.x|object document/);
  });
});
