using './subscription.bicep'

// Fill these in before running.
param resourceGroupName = 'solidcommunity'
param location = 'uksouth'
param operatorObjectId = '<object id of Jesse Wright in the ODI tenant>'
param monthlyBudget = 300
param alertEmails = [
  '<jesse email>'
  '<it admin email>'
]
param budgetStartDate = '2026-12-01'
param registryName = 'odisolidcommunity'
// The repo's IDs, which GitHub puts in its OIDC token. Update the owner part if the repo moves to the ODI org
// (the repo ID stays the same): gh api repos/<owner>/solidcommunity-gitops -q '"repo:\(.owner.login)@\(.owner.id)/\(.name)@\(.id)"'
param githubSubjectPrefix = 'repo:jeswr@63333554/solidcommunity-gitops@1418651058'
