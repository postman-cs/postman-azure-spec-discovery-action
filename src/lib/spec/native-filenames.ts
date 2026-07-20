import type { SpecFormat } from '../../contracts.js';

/** Stable, safe artifact filenames for preserved native specification bytes. */
export function safeNativeFilename(format: SpecFormat): string {
  switch (format) {
    case 'openapi-json':
      return 'index.json';
    case 'openapi-yaml':
      return 'index.yaml';
    case 'asyncapi-json':
      return 'asyncapi.json';
    case 'asyncapi-yaml':
      return 'asyncapi.yaml';
    case 'wsdl':
      return 'service.wsdl';
    case 'wadl':
      return 'application.wadl';
    case 'xsd':
      return 'schema.xsd';
    case 'protobuf':
      return 'service.proto';
    case 'graphql-sdl':
      return 'schema.graphql';
    case 'mcp-json':
      return 'mcp.json';
  }
}
