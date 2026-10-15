// solidcommunity.net on Azure App Service.
// Based on theodi/css-azure-deployment (private.bicep): a Linux App Service running the
// CSS container, with pod data on an Azure Files share reached over a private endpoint.
// Differences from that draft: everything is parameterised per environment, the image is
// our own (CSS + Mashlib + config baked in) instead of `community-server:latest` plus an
// uploaded config, secrets come in as secure parameters, and the storage key is never
// exposed as a deployment output.

@description('Short environment name, used in resource names (e.g. test, prod).')
param env string

param location string = resourceGroup().location

@description('App Service plan SKU. B1 is enough for a test environment; production wants P1v3 or larger.')
param planSku string = 'B1'

@description('Full container image reference, e.g. ghcr.io/jeswr/solidcommunity-gitops:<sha>.')
param image string

@description('Public base URL of the server. Empty means https://<site>.azurewebsites.net/.')
param baseUrl string = ''

@description('CSS config entry file inside the image (relative to /app).')
param cssConfig string = 'config/test.json'

@description('Extra CSS CLI arguments, e.g. --loggingLevel info.')
param extraArgs string = '--loggingLevel info'

@description('Node heap limit in MB (live server uses 6144).')
param maxOldSpaceMb int = 1536

@description('Azure Files share quota in GiB.')
param shareQuotaGb int = 100

@secure()
@description('SMTP password (SendGrid API key). Empty disables the email override.')
param smtpPassword string = ''

@description('Name of an existing user-assigned identity in this resource group with AcrPull on the registry. Empty pulls the image anonymously.')
param pullIdentityName string = ''

var suffix = uniqueString(resourceGroup().id, env)
var siteName = 'sc-${env}-${suffix}'
var storageName = take('sc${env}${suffix}', 24)
var shareName = 'pods'
var mountPath = '/data'
var privateFilesDnsZoneName = 'privatelink.file.${environment().suffixes.storage}'
var resolvedBaseUrl = empty(baseUrl) ? 'https://${siteName}.azurewebsites.net/' : baseUrl

resource vnet 'Microsoft.Network/virtualNetworks@2023-09-01' = {
  name: 'sc-${env}-vnet'
  location: location
  properties: {
    addressSpace: { addressPrefixes: [ '10.0.0.0/16' ] }
    subnets: [
      {
        name: 'files'
        properties: {
          addressPrefix: '10.0.1.0/28'
          privateEndpointNetworkPolicies: 'Disabled'
        }
      }
      {
        name: 'web'
        properties: {
          addressPrefix: '10.0.2.0/27'
          delegations: [
            { name: 'webapp', properties: { serviceName: 'Microsoft.Web/serverFarms' } }
          ]
        }
      }
    ]
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    publicNetworkAccess: 'Disabled'
    networkAcls: { bypass: 'None', defaultAction: 'Deny' }
  }

  resource files 'fileServices' = {
    name: 'default'
    resource share 'shares' = {
      name: shareName
      properties: { shareQuota: shareQuotaGb }
    }
  }
}

resource filesEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = {
  name: '${storageName}-pe'
  location: location
  properties: {
    subnet: { id: vnet.properties.subnets[0].id }
    privateLinkServiceConnections: [
      {
        name: '${storageName}-pls'
        properties: { privateLinkServiceId: storage.id, groupIds: [ 'file' ] }
      }
    ]
  }
}

resource filesDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: privateFilesDnsZoneName
  location: 'global'
}

resource filesDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: filesDnsZone
  name: '${vnet.name}-link'
  location: 'global'
  properties: {
    registrationEnabled: false
    virtualNetwork: { id: vnet.id }
  }
}

resource filesDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = {
  parent: filesEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      { name: 'file', properties: { privateDnsZoneId: filesDnsZone.id } }
    ]
  }
}

resource plan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: 'sc-${env}-plan'
  location: location
  sku: { name: planSku }
  kind: 'linux'
  properties: { reserved: true }
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = if (!empty(pullIdentityName)) {
  name: empty(pullIdentityName) ? 'unused' : pullIdentityName
}

resource site 'Microsoft.Web/sites@2024-11-01' = {
  name: siteName
  location: location
  kind: 'app,linux,container'
  identity: empty(pullIdentityName) ? null : {
    type: 'UserAssigned'
    userAssignedIdentities: { '${pullIdentity!.id}': {} }
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    virtualNetworkSubnetId: vnet.properties.subnets[1].id
    outboundVnetRouting: { applicationTraffic: true, contentShareTraffic: true }
    siteConfig: {
      linuxFxVersion: 'sitecontainers'
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      webSocketsEnabled: true
      healthCheckPath: '/.well-known/openid-configuration'
      appSettings: [
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'false' }
        { name: 'CSS_BASE_URL', value: resolvedBaseUrl }
        { name: 'CSS_CONFIG', value: cssConfig }
        { name: 'CSS_ROOT_FILE_PATH', value: mountPath }
        { name: 'SC_EXTRA_ARGS', value: extraArgs }
        { name: 'NODE_OPTIONS', value: '--max-old-space-size=${maxOldSpaceMb}' }
        { name: 'SMTP_PASSWORD', value: smtpPassword }
      ]
      azureStorageAccounts: {
        pods: {
          type: 'AzureFiles'
          accountName: storage.name
          shareName: shareName
          mountPath: mountPath
          protocol: 'Smb'
          accessKey: storage.listKeys().keys[0].value
        }
      }
    }
  }
  dependsOn: [ filesDnsGroup, filesDnsLink ]
}

resource main 'Microsoft.Web/sites/sitecontainers@2024-11-01' = {
  parent: site
  name: 'main'
  properties: {
    image: image
    targetPort: '3000'
    isMain: true
    authType: empty(pullIdentityName) ? 'Anonymous' : 'UserAssigned'
    userManagedIdentityClientId: empty(pullIdentityName) ? null : pullIdentity!.properties.clientId
    environmentVariables: [
      { name: 'CSS_BASE_URL', value: 'CSS_BASE_URL' }
      { name: 'CSS_CONFIG', value: 'CSS_CONFIG' }
      { name: 'CSS_ROOT_FILE_PATH', value: 'CSS_ROOT_FILE_PATH' }
      { name: 'SC_EXTRA_ARGS', value: 'SC_EXTRA_ARGS' }
      { name: 'NODE_OPTIONS', value: 'NODE_OPTIONS' }
      { name: 'SMTP_PASSWORD', value: 'SMTP_PASSWORD' }
    ]
  }
}

output siteName string = site.name
output defaultHostName string = site.properties.defaultHostName
output baseUrl string = resolvedBaseUrl
