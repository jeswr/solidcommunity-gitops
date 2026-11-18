// Resource-group-scoped part of admin/subscription.bicep: role assignments and the budget.
targetScope = 'resourceGroup'

param operatorObjectId string
param contributorRoleId string
param rbacAdministratorRoleId string
param rbacCondition string
param monthlyBudget int
param alertEmails array
param budgetStartDate string

resource operatorContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, operatorObjectId, contributorRoleId)
  properties: {
    principalId: operatorObjectId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
  }
}

resource operatorRbacAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, operatorObjectId, rbacAdministratorRoleId)
  properties: {
    principalId: operatorObjectId
    principalType: 'User'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', rbacAdministratorRoleId)
    condition: rbacCondition
    conditionVersion: '2.0'
  }
}

// Budgets alert; they do not stop resources. Thresholds: 50/80/100% of actual spend, 100% forecast.
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'solidcommunity-monthly'
  properties: {
    category: 'Cost'
    amount: monthlyBudget
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      actual50: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 50, thresholdType: 'Actual', contactEmails: alertEmails }
      actual80: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 80, thresholdType: 'Actual', contactEmails: alertEmails }
      actual100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Actual', contactEmails: alertEmails }
      forecast100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Forecasted', contactEmails: alertEmails }
    }
  }
}

// Identities and registry for GitHub Actions, so CI deploys without anyone holding Azure logins.
@description('Container registry name (globally unique, 5-50 alphanumerics).')
param registryName string

@description('Subject prefix of GitHub\'s OIDC token for this repo, before ":environment:<name>". GitHub uses the owner and repo IDs: repo:<owner>@<ownerId>/<repo>@<repoId>.')
param githubSubjectPrefix string

@description('GitHub environments allowed to deploy.')
param githubEnvironments array = [ 'preview', 'prod' ]

var acrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var acrPush = '8311e382-0749-4cb8-b61a-304f252e45ec'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: resourceGroup().location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}

resource deployer 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'sc-deployer'
  location: resourceGroup().location
}

@batchSize(1)
resource deployerFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = [for e in githubEnvironments: {
  parent: deployer
  name: 'github-${e}'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: '${githubSubjectPrefix}:environment:${e}'
    audiences: [ 'api://AzureADTokenExchange' ]
  }
}]

resource runtime 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'sc-runtime'
  location: resourceGroup().location
}

resource deployerContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deployer.id, contributorRoleId)
  properties: {
    principalId: deployer.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', contributorRoleId)
  }
}

resource deployerPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, deployer.id, acrPush)
  scope: registry
  properties: {
    principalId: deployer.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPush)
  }
}

resource runtimePull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, runtime.id, acrPull)
  scope: registry
  properties: {
    principalId: runtime.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPull)
  }
}

output deployerClientId string = deployer.properties.clientId
output registryLoginServer string = registry.properties.loginServer
