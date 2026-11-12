using '../infra/main.bicep'

// Preview for the SolidOS team on ODI's Azure, ahead of the full migration. Same image and config
// shape as test: Azure default hostname with pods under paths, no migrated accounts. Lives in the
// same resource group as production, with its own plan, storage and network.
param env = 'preview'
param planSku = 'B1'
// CSS main plus the fork fixes (#132, #135, #136, #138-#140): upstream main alone crashes about hourly.
param image = 'odisolidcommunity.azurecr.io/solidcommunity-gitops:hotfixes-ca52454c2'
param pullIdentityName = 'sc-runtime'
param cssConfig = 'config/test.json'
param extraArgs = '--loggingLevel info'
param maxOldSpaceMb = 1280
param storageSku = 'Premium_LRS'
param shareQuotaGb = 100
