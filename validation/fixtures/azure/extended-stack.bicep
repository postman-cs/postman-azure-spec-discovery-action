// Optional extended disposable resources for R8/POS-396.
// Deployed only when corresponding provision flags are enabled.
// All root resources carry the run marker for guarded teardown.
param location string = resourceGroup().location
param runMarker string
param logicAppName string
param templateSpecName string
param eventGridTopicName string
param eventGridSubName string
param webhookEndpointUrl string
param functionAppName string = ''
param appServicePlanId string = ''
param provisionLogicApp bool = true
param provisionTemplateSpec bool = true
param provisionEventGrid bool = true
param provisionFunctionApp bool = false

resource logicApp 'Microsoft.Logic/workflows@2019-05-01' = if (provisionLogicApp) {
  name: logicAppName
  location: location
  tags: {
    'postman:run-marker': runMarker
    'postman:project-name': 'payments-logic'
  }
  properties: {
    state: 'Enabled'
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      parameters: {}
      triggers: {
        manual: {
          type: 'Request'
          kind: 'Http'
          inputs: {
            schema: {
              type: 'object'
              properties: {
                ping: {
                  type: 'string'
                }
              }
            }
          }
        }
      }
      actions: {
        Response: {
          type: 'Response'
          inputs: {
            statusCode: 200
            body: {
              status: 'ok'
            }
          }
        }
      }
      outputs: {}
    }
  }
}

resource templateSpec 'Microsoft.Resources/templateSpecs@2022-02-01' = if (provisionTemplateSpec) {
  name: templateSpecName
  location: location
  tags: {
    'postman:run-marker': runMarker
    'postman:project-name': 'payments-templatespec'
  }
  properties: {
    description: 'Embedded APIM OpenAPI template for live validation'
  }
}

resource templateSpecVersion 'Microsoft.Resources/templateSpecs/versions@2022-02-01' = if (provisionTemplateSpec) {
  parent: templateSpec
  name: 'v1'
  location: location
  tags: {
    'postman:run-marker': runMarker
  }
  properties: {
    description: 'v1'
    mainTemplate: {
      '$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#'
      contentVersion: '1.0.0.0'
      resources: [
        {
          type: 'Microsoft.ApiManagement/service/apis'
          apiVersion: '2023-05-01-preview'
          name: 'apim-live/payments-templatespec'
          properties: {
            displayName: 'Payments TemplateSpec API'
            path: 'payments-templatespec'
            protocols: [
              'https'
            ]
            format: 'openapi+json'
            value: '{"openapi":"3.0.3","info":{"title":"Payments TemplateSpec API","version":"1.0.0"},"paths":{"/items":{"get":{"responses":{"200":{"description":"ok"}}}}}}'
          }
        }
      ]
    }
  }
}

resource eventGridTopic 'Microsoft.EventGrid/topics@2025-02-15' = if (provisionEventGrid) {
  name: eventGridTopicName
  location: location
  tags: {
    'postman:run-marker': runMarker
    'postman:project-name': 'payments-eventgrid'
  }
  properties: {
    inputSchema: 'EventGridSchema'
  }
}

resource eventGridSubscription 'Microsoft.EventGrid/topics/eventSubscriptions@2025-02-15' = if (provisionEventGrid) {
  parent: eventGridTopic
  name: eventGridSubName
  properties: {
    destination: {
      endpointType: 'WebHook'
      properties: {
        endpointUrl: webhookEndpointUrl
      }
    }
    filter: {
      includedEventTypes: [
        'Microsoft.Resources.ResourceWriteSuccess'
      ]
    }
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = if (provisionFunctionApp && !empty(functionAppName) && !empty(appServicePlanId)) {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  tags: {
    'postman:run-marker': runMarker
    'postman:project-name': 'payments-functions'
  }
  properties: {
    serverFarmId: appServicePlanId
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20-lts'
      appSettings: [
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
      ]
    }
  }
}

output logicAppNameOut string = provisionLogicApp ? logicApp.name : ''
output templateSpecNameOut string = provisionTemplateSpec ? templateSpec.name : ''
output eventGridTopicNameOut string = provisionEventGrid ? eventGridTopic.name : ''
output functionAppNameOut string = provisionFunctionApp ? functionApp.name : ''
