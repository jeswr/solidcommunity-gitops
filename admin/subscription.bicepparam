using './subscription.bicep'

// Fill these in before running.
param resourceGroupName = 'solidcommunity-prod'
param location = 'uksouth'
param operatorObjectId = '<object id of Jesse Wright in the ODI tenant>'
param monthlyBudget = 250
param alertEmails = [
  '<jesse email>'
  '<it admin email>'
]
param budgetStartDate = '2026-12-01'
