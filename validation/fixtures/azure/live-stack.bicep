// Disposable live-validation stack: APIM Consumption + current HTTP API + App Service plan/site.
// Deployed into a run-marked resource group by validate-live-azure-surfaces.mjs and deleted with it.
param location string = resourceGroup().location
param runMarker string
param apimName string
param appServicePlanName string
param siteName string
param publisherEmail string = 'postman-cse-validation@example.com'
param publisherName string = 'Postman CSE Validation'

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
  }
  properties: {
    publisherEmail: publisherEmail
    publisherName: publisherName
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
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: appServicePlanName
  location: location
  sku: {
    name: 'B1'
    tier: 'Basic'
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
output siteHostname string = site.properties.defaultHostName
output siteResourceName string = site.name
