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
