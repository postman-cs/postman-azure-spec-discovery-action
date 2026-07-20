// Disposable live-validation stack for R8/POS-396.
// Core: APIM Consumption + current HTTP API + App Service plan/site.
// Optional multi-API HTTP siblings and version-set/revision are gated.
// SOAP/GraphQL/unsupported inventory APIs are applied post-deploy by the harness
// so Azure rejection becomes requires-capability instead of a failed deployment.
//
// Clean-repo isolation:
// - Service-level postman:repo + Fox GithubOrg/GithubRepo tags are inherited across
//   multiple APIs and must NOT select alone (narrow/unresolved without path evidence).
// - Canonical harness case path-selects payments-live; Fox case path-selects orders-live.
// - Harness derives repository context from GITHUB_REPOSITORY (no --repo-slug / --api-id).
param location string = resourceGroup().location
param runMarker string
param apimName string
param appServicePlanName string
param siteName string
param repoSlug string = 'postman-cs/postman-azure-spec-discovery-action'
param publisherEmail string = 'postman-cse-validation@example.com'
param publisherName string = 'Postman CSE Validation'
param provisionMultiApi bool = true

var repoParts = split(repoSlug, '/')
var foxOrg = length(repoParts) > 0 ? repoParts[0] : 'postman-cs'
var foxRepo = length(repoParts) > 1 ? repoParts[1] : 'postman-azure-spec-discovery-action'

resource apim 'Microsoft.ApiManagement/service@2023-05-01-preview' = {
  name: apimName
  location: location
  sku: {
    name: 'Consumption'
    capacity: 0
  }
  tags: {
    'postman:run-marker': runMarker
    'postman:project-name': 'payments-live'
    // Canonical association tag (service-inherited under multi-API).
    'postman:repo': repoSlug
    // Fox association pair (service-inherited under multi-API).
    GithubOrg: foxOrg
    GithubRepo: foxRepo
  }
  properties: {
    publisherEmail: publisherEmail
    publisherName: publisherName
  }
}

resource paymentsVersionSet 'Microsoft.ApiManagement/service/apiVersionSets@2023-05-01-preview' = if (provisionMultiApi) {
  parent: apim
  name: 'payments-live-versions'
  properties: {
    displayName: 'Payments Live Versions'
    versioningScheme: 'Segment'
  }
}

resource paymentsApi 'Microsoft.ApiManagement/service/apis@2023-05-01-preview' = {
  parent: apim
  name: 'payments-live'
  properties: {
    displayName: 'Payments Live API'
    path: 'payments-live'
    protocols: [
      'https'
    ]
    apiType: 'http'
    format: 'openapi+json'
    value: loadTextContent('./app-service-stub/openapi.json')
    apiVersionSetId: provisionMultiApi ? paymentsVersionSet.id : null
    apiVersion: provisionMultiApi ? 'v1' : null
  }
}

resource paymentsApiRev2 'Microsoft.ApiManagement/service/apis@2023-05-01-preview' = if (provisionMultiApi) {
  parent: apim
  name: 'payments-live;rev=2'
  properties: {
    displayName: 'Payments Live API'
    path: 'payments-live'
    protocols: [
      'https'
    ]
    apiType: 'http'
    isCurrent: false
    sourceApiId: paymentsApi.id
    apiRevision: '2'
  }
}

resource ordersApi 'Microsoft.ApiManagement/service/apis@2023-05-01-preview' = if (provisionMultiApi) {
  parent: apim
  name: 'orders-live'
  properties: {
    displayName: 'Orders Live API'
    path: 'orders-live'
    protocols: [
      'https'
    ]
    apiType: 'http'
    format: 'openapi+json'
    value: loadTextContent('./apim-apis/orders-live.json')
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  sku: {
    name: 'F1'
    tier: 'Free'
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
  tags: {
    'postman:run-marker': runMarker
  }
}

resource site 'Microsoft.Web/sites@2023-12-01' = {
  name: siteName
  location: location
  tags: {
    'postman:run-marker': runMarker
    'postman:project-name': 'payments-live-site'
    'postman:repo': repoSlug
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      appCommandLine: 'node server.mjs'
    }
  }
}

output apimServiceName string = apim.name
output apiId string = paymentsApi.id
output gatewayHostname string = '${apim.name}.azure-api.net'
output siteHostname string = site.properties.defaultHostName
output siteResourceName string = site.name
output ordersApiName string = provisionMultiApi ? ordersApi.name : ''
