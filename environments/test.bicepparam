using '../infra/main.bicep'

// Test environment: smallest useful plan, Azure default hostname, suffix-style pod URLs
// (subdomain pods need a wildcard domain, which the azurewebsites.net hostname can't give us).
param env = 'test'
param planSku = 'B1'
param image = 'sctestffd346a6.azurecr.io/solidcommunity-gitops:main'
param pullIdentityName = 'sc-test-runtime'
param cssConfig = 'config/test.json'
param extraArgs = '--loggingLevel info'
param maxOldSpaceMb = 1280
param shareQuotaGb = 20
