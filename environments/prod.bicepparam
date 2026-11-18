using '../infra/main.bicep'

// Production: solidcommunity.net, one pod per subdomain, behind Cloudflare (proxied, SSL mode
// Full (strict)). Deployed only by a manual run of the Deploy workflow with env=prod.
param env = 'prod'

// B1 handled the test benchmarks, but it has one slow vCPU and 1.75 GB. P1v3 gives 2 faster vCPUs
// and 8 GB: start-up (about 70 s of CPU) no longer starves the running container during the
// overlapped restart App Service does, and the heap can grow for ~20k pods.
param planSku = 'P1v3'

// The GHCR package is private today. Either make it public, or create a registry and a pull
// identity in the production resource group (as for test) and switch to them here.
param image = 'ghcr.io/jeswr/solidcommunity-gitops:be94fc6c2af6c5db3c842eae18c62088a55c5228'
param pullIdentityName = ''

param cssConfig = 'config/solidcommunity.net.json'
param baseUrl = 'https://solidcommunity.net/'
param customDomain = 'solidcommunity.net'
param extraArgs = '--loggingLevel info'

// Two containers run side by side for a few minutes during a restart, so each keeps to well
// under half of the 8 GB. Raise towards the droplet's 6144 only with a bigger plan.
param maxOldSpaceMb = 3072

param storageSku = 'Premium_LRS'
// 74 GB today. Premium Files IOPS and throughput also scale with the provisioned size.
param shareQuotaGb = 200

// Only Cloudflare may reach the origin. https://www.cloudflare.com/ips/ (checked 2026-10-25).
param allowedIpRanges = [
  '173.245.48.0/20'
  '103.21.244.0/22'
  '103.22.200.0/22'
  '103.31.4.0/22'
  '141.101.64.0/18'
  '108.162.192.0/18'
  '190.93.240.0/20'
  '188.114.96.0/20'
  '197.234.240.0/22'
  '198.41.128.0/17'
  '162.158.0.0/15'
  '104.16.0.0/13'
  '104.24.0.0/14'
  '172.64.0.0/13'
  '131.0.72.0/22'
  '2400:cb00::/32'
  '2606:4700::/32'
  '2803:f800::/32'
  '2405:b500::/32'
  '2405:8100::/32'
  '2a06:98c0::/29'
  '2c0f:f248::/32'
]
