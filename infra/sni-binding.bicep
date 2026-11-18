// Turns on SNI TLS for an existing host name binding. It lives in a module because a Bicep file
// can't declare the same resource twice, and an App Service managed certificate can only be
// created after the host name is bound (without TLS) to the site.
param siteName string
param hostName string
param thumbprint string

resource site 'Microsoft.Web/sites@2024-11-01' existing = {
  name: siteName
}

resource binding 'Microsoft.Web/sites/hostNameBindings@2024-11-01' = {
  parent: site
  name: hostName
  properties: {
    siteName: siteName
    hostNameType: 'Verified'
    customHostNameDnsRecordType: 'CName'
    sslState: 'SniEnabled'
    thumbprint: thumbprint
  }
}
