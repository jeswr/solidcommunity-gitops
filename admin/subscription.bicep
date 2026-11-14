// One-off setup for the solidcommunity.net resource group (SolidOS preview, then production), run by a subscription admin.
// Creates the resource group, a monthly budget with alerts, the operator's role assignments, and the
// container registry plus managed identities GitHub Actions deploys with.
// Everything inside the resource group is then created by infra/main.bicep from GitHub Actions.
//
//   az deployment sub create -l uksouth -f admin/subscription.bicep -p admin/subscription.bicepparam
targetScope = 'subscription'

@description('Resource group name.')
param resourceGroupName string = 'solidcommunity'

@description('Region for the resource group and everything in it.')
param location string = 'uksouth'

@description('Object ID of the person operating the deployment (az ad user show --id <email> --query id -o tsv).')
param operatorObjectId string

@description('Monthly budget for the resource group, in the billing currency.')
param monthlyBudget int = 300

@description('Email addresses that receive the budget alerts.')
param alertEmails array

@description('First day of the budget period, the 1st of a month (YYYY-MM-01).')
param budgetStartDate string

@description('Container registry name (globally unique, 5-50 alphanumerics).')
param registryName string

@description('GitHub OIDC subject prefix for the repo: repo:<owner>@<ownerId>/<repo>@<repoId>.')
param githubSubjectPrefix string

var contributor = 'b24988ac-6180-42a0-ab88-20f7382dd24c'
var rbacAdministrator = 'f58310d9-a9f6-439a-9e8d-f62e7b41a168'
// Roles the operator may hand out inside the resource group: Contributor (CI deploy identity),
// AcrPull (App Service image pull identity) and AcrPush (CI image push identity).
var assignableRoles = [
  contributor
  '7f951dda-4ed3-4680-a7ca-43fe172d538d' // AcrPull
  '8311e382-0749-4cb8-b61a-304f252e45ec' // AcrPush
]
var assignableRoleList = join(assignableRoles, ', ')

resource rg 'Microsoft.Resources/resourceGroups@2024-03-01' = {
  name: resourceGroupName
  location: location
  tags: { service: 'solidcommunity.net' }
}

module scoped 'subscription-rg.bicep' = {
  name: 'solidcommunity-rg-setup'
  scope: rg
  params: {
    operatorObjectId: operatorObjectId
    contributorRoleId: contributor
    rbacAdministratorRoleId: rbacAdministrator
    // Only lets the operator create or delete assignments of the three roles above.
    rbacCondition: '((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${assignableRoleList}})) AND ((!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${assignableRoleList}}))'
    monthlyBudget: monthlyBudget
    alertEmails: alertEmails
    budgetStartDate: budgetStartDate
    registryName: registryName
    githubSubjectPrefix: githubSubjectPrefix
  }
}

output resourceGroupId string = rg.id
output deployerClientId string = scoped.outputs.deployerClientId
output registryLoginServer string = scoped.outputs.registryLoginServer
