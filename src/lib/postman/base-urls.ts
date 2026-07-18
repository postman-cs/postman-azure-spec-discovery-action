export interface PostmanEndpointProfile {
  apiBaseUrl: string;
  iapubBaseUrl: string;
}

export const POSTMAN_ENDPOINT_PROFILES: Record<'prod', PostmanEndpointProfile> = {
  prod: {
    apiBaseUrl: 'https://api.getpostman.com',
    iapubBaseUrl: 'https://iapub.postman.co'
  }
};
