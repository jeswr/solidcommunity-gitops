using '../infra/main.bicep'

// Preview for the SolidOS team on ODI's Azure, ahead of the full migration. Same image and config
// shape as test: pods under paths, no migrated accounts. Lives in the same resource group as
// production, with its own plan, storage and network.
param env = 'preview'
param planSku = 'B1'
// CSS main plus the fork fixes (#132, #135, #136, #138-#140): upstream main alone crashes about hourly.
// Built by the image workflow from this branch (with the redesign merged in) with
// css_repo=https://github.com/jeswr/CommunitySolidServer.git, css_ref=ca52454c297e54ecbf4ab83ebdae6ef4335c8512.
param image = 'odisolidcommunity.azurecr.io/solidcommunity-gitops:redesign-4e4e6c25d'
param pullIdentityName = 'sc-runtime'
param cssConfig = 'config/test.json'
param extraArgs = '--loggingLevel info'
param maxOldSpaceMb = 1280
param storageSku = 'Premium_LRS'
param shareQuotaGb = 100
// Fresh root whenever the landing page changes (v4: the ODI logo was removed from it): the landing page (templates/root/wac/index.html) is only written
// when the root is created, and the earlier data belonged to the old azurewebsites.net base URL.
// That data stays in the share root.
param dataSubPath = 'v4'

// Served at solidos.solid-experiments.org (Cloudflare DNS, managed by ODI). The records must be
// DNS only (grey cloud), or the managed certificate can't be issued or renewed:
//   CNAME solidos        -> sc-preview-a34dqfq3bqsng.azurewebsites.net
//   TXT   asuid.solidos  =  the customDomainVerificationId deployment output
param baseUrl = 'https://solidos.solid-experiments.org/'
param managedCertHostName = 'solidos.solid-experiments.org'
