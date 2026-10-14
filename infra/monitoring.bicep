// Monitoring and alerting for one solidcommunity.net environment.
// Azure-native only: platform metrics and container logs go to a Log Analytics workspace,
// alert rules watch them, and an action group emails the operators. When a GitHub token is
// given, the action group also opens an `incident` issue in this repo, which the incident
// workflow hands to Claude Code to diagnose (see .github/workflows/incident.yml).
//
// Cost: metric alerts and email are close to free, the workspace stays inside the monthly
// free ingestion allowance because of its daily cap, and the two log alerts are billed per
// rule. The optional availability test is billed per run, so it is off by default.

param env string
param location string

@description('Name of the App Service site to monitor.')
param siteName string

@description('Name of the App Service plan the site runs on.')
param planName string

@description('Name of the storage account holding the pod share.')
param storageName string

@description('Pod share quota in GiB, used for the "share nearly full" alert.')
param shareQuotaGb int

@description('Public URL to probe from outside Azure when the availability test is on.')
param baseUrl string

@description('Email address that receives alerts. Empty sends no email.')
param alertEmail string = ''

@description('Repository that receives incident issues, as owner/name.')
param incidentRepo string = 'jeswr/solidcommunity-gitops'

@secure()
@description('Fine-grained GitHub token with Issues: write on incidentRepo. Empty disables incident issues.')
param incidentGithubToken string = ''

@description('Daily ingestion cap for the workspace in GB. 0.15 GB/day keeps a month under the free allowance.')
param logDailyCapGb string = '0.15'

@description('Also collect per-request HTTP logs. Useful for diagnosis but by far the largest log source.')
param collectHttpLogs bool = false

@description('Probe baseUrl from outside Azure every 15 minutes. Catches DNS, TLS and proxy failures that in-platform checks miss. Billed per run.')
param availabilityTestEnabled bool = false

var site = resourceId('Microsoft.Web/sites', siteName)
var plan = resourceId('Microsoft.Web/serverfarms', planName)
var fileService = resourceId('Microsoft.Storage/storageAccounts/fileServices', storageName, 'default')
var incidentsEnabled = !empty(incidentGithubToken)

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'sc-${env}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json(logDailyCapGb) }
  }
}

resource siteRef 'Microsoft.Web/sites@2024-11-01' existing = {
  name: siteName
}

resource siteDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: siteRef
  properties: {
    workspaceId: workspace.id
    logs: [
      { category: 'AppServiceConsoleLogs', enabled: true }
      { category: 'AppServicePlatformLogs', enabled: true }
      { category: 'AppServiceHTTPLogs', enabled: collectHttpLogs }
    ]
    metrics: [ { category: 'AllMetrics', enabled: false } ]
  }
}

// --- Who gets told ----------------------------------------------------------------------

// Opens a GitHub issue labelled `incident` for every alert that fires. Resolutions are not
// forwarded; the incident workflow folds repeats of an open incident into that issue.
resource incidentApp 'Microsoft.Logic/workflows@2019-05-01' = if (incidentsEnabled) {
  name: 'sc-${env}-incident-to-github'
  location: location
  properties: {
    state: 'Enabled'
    parameters: {
      token: { value: incidentGithubToken }
    }
    definition: {
      '$schema': 'https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#'
      contentVersion: '1.0.0.0'
      parameters: {
        token: { type: 'securestring' }
      }
      triggers: {
        alert: { type: 'Request', kind: 'Http', inputs: { schema: {} } }
      }
      actions: {
        onlyFired: {
          type: 'If'
          expression: {
            equals: [ '@triggerBody()?[\'data\']?[\'essentials\']?[\'monitorCondition\']', 'Fired' ]
          }
          actions: {
            openIssue: {
              type: 'Http'
              inputs: {
                method: 'POST'
                uri: 'https://api.github.com/repos/${incidentRepo}/issues'
                headers: {
                  Accept: 'application/vnd.github+json'
                  Authorization: 'Bearer @{parameters(\'token\')}'
                  'X-GitHub-Api-Version': '2022-11-28'
                }
                body: {
                  title: '[incident] @{triggerBody()?[\'data\']?[\'essentials\']?[\'alertRule\']}'
                  labels: [ 'incident' ]
                  body: 'Alert **@{triggerBody()?[\'data\']?[\'essentials\']?[\'alertRule\']}** (@{triggerBody()?[\'data\']?[\'essentials\']?[\'severity\']}) fired at @{triggerBody()?[\'data\']?[\'essentials\']?[\'firedDateTime\']}.\n\n@{triggerBody()?[\'data\']?[\'essentials\']?[\'description\']}\n\n<details><summary>Alert payload</summary>\n\n```json\n@{triggerBody()?[\'data\']}\n```\n</details>'
                }
              }
              runtimeConfiguration: { secureData: { properties: [ 'inputs' ] } }
            }
          }
          else: { actions: {} }
        }
      }
    }
  }
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'sc-${env}-operators'
  location: 'global'
  properties: {
    groupShortName: take('sc${env}ops', 12)
    enabled: true
    emailReceivers: empty(alertEmail) ? [] : [
      { name: 'operator', emailAddress: alertEmail, useCommonAlertSchema: true }
    ]
    logicAppReceivers: incidentsEnabled ? [
      {
        name: 'github-incident'
        resourceId: incidentApp!.id
        callbackUrl: incidentApp!.listCallbackUrl().value
        useCommonAlertSchema: true
      }
    ] : []
  }
}

var actions = [ { actionGroupId: actionGroup.id } ]

// --- Metric alerts ------------------------------------------------------------------------

var metricAlerts = [
  {
    name: 'down'
    description: 'The health check (/.well-known/openid-configuration) is failing. The server is down or not answering.'
    severity: 0
    scope: site
    metric: 'HealthCheckStatus'
    aggregation: 'Average'
    operator: 'LessThan'
    threshold: 100
    window: 'PT5M'
  }
  {
    name: 'server-errors'
    description: 'More than 20 responses with a 5xx status in 5 minutes.'
    severity: 1
    scope: site
    metric: 'Http5xx'
    aggregation: 'Total'
    operator: 'GreaterThan'
    threshold: 20
    window: 'PT5M'
  }
  {
    name: 'slow'
    description: 'Average response time above 5 seconds for 15 minutes.'
    severity: 2
    scope: site
    metric: 'HttpResponseTime'
    aggregation: 'Average'
    operator: 'GreaterThan'
    threshold: 5
    window: 'PT15M'
  }
  {
    name: 'memory'
    description: 'The App Service plan has been above 90% memory for 15 minutes. Node may be close to its heap limit.'
    severity: 2
    scope: plan
    metric: 'MemoryPercentage'
    aggregation: 'Average'
    operator: 'GreaterThan'
    threshold: 90
    window: 'PT15M'
  }
  {
    name: 'cpu'
    description: 'The App Service plan has been above 90% CPU for 15 minutes.'
    severity: 2
    scope: plan
    metric: 'CpuPercentage'
    aggregation: 'Average'
    operator: 'GreaterThan'
    threshold: 90
    window: 'PT15M'
  }
  {
    name: 'disk-nearly-full'
    description: 'The pod share is more than 80% of its quota. Raise shareQuotaGb before writes start failing.'
    severity: 2
    scope: fileService
    metric: 'FileCapacity'
    aggregation: 'Average'
    operator: 'GreaterThan'
    threshold: shareQuotaGb * 858993459 // 0.8 GiB in bytes
    window: 'PT1H'
  }
]

resource metricAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = [for a in metricAlerts: {
  name: 'sc-${env}-${a.name}'
  location: 'global'
  dependsOn: [ siteDiagnostics ]
  properties: {
    description: a.description
    severity: a.severity
    enabled: true
    scopes: [ a.scope ]
    evaluationFrequency: a.window == 'PT1H' ? 'PT15M' : 'PT1M'
    windowSize: a.window
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: a.metric
          metricName: a.metric
          timeAggregation: a.aggregation
          operator: a.operator
          threshold: a.threshold
        }
      ]
    }
    actions: actions
  }
}]

// --- Log alerts ---------------------------------------------------------------------------
// Thresholds are first guesses. Tune them once the test environment has a few days of logs.

var logAlerts = [
  {
    name: 'error-logs'
    description: 'CSS logged more than 50 errors in 15 minutes. Common causes on the old server were expired locks and notification storage errors.'
    severity: 2
    query: 'AppServiceConsoleLogs | where ResultDescription has " error: " or ResultDescription has "Lock expired"'
    threshold: 50
  }
  {
    name: 'restarts'
    description: 'The container stopped, crashed or failed to start.'
    severity: 1
    query: 'AppServicePlatformLogs | where Message has_any ("exited", "didn\'t respond", "failed to start", "OOMKilled", "terminated")'
    threshold: 0
  }
]

resource logAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = [for a in logAlerts: {
  name: 'sc-${env}-${a.name}'
  location: location
  dependsOn: [ siteDiagnostics ]
  properties: {
    description: a.description
    severity: a.severity
    enabled: true
    scopes: [ workspace.id ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    autoMitigate: true
    criteria: {
      allOf: [
        {
          query: a.query
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: a.threshold
          failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
        }
      ]
    }
    actions: { actionGroups: [ actionGroup.id ] }
  }
}]

// --- Outside-in probe (optional) ----------------------------------------------------------

resource insights 'Microsoft.Insights/components@2020-02-02' = if (availabilityTestEnabled) {
  name: 'sc-${env}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
  }
}

resource probe 'Microsoft.Insights/webtests@2022-06-15' = if (availabilityTestEnabled) {
  name: 'sc-${env}-probe'
  location: location
  tags: { 'hidden-link:${insights.id}': 'Resource' }
  properties: {
    SyntheticMonitorId: 'sc-${env}-probe'
    Name: 'sc-${env}-probe'
    Kind: 'standard'
    Enabled: true
    Frequency: 900
    Timeout: 30
    RetryEnabled: true
    Locations: [ { Id: 'emea-nl-ams-azr' }, { Id: 'emea-gb-db3-azr' } ]
    Request: {
      RequestUrl: '${baseUrl}.well-known/openid-configuration'
      HttpVerb: 'GET'
      ParseDependentRequests: false
    }
    ValidationRules: {
      ExpectedHttpStatusCode: 200
      SSLCheck: startsWith(baseUrl, 'https://')
      SSLCertRemainingLifetimeCheck: 7
    }
  }
}

resource probeAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = if (availabilityTestEnabled) {
  name: 'sc-${env}-unreachable'
  location: 'global'
  properties: {
    description: 'The public URL failed the outside-in probe from both locations.'
    severity: 0
    enabled: true
    scopes: [ probe.id, insights.id ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.WebtestLocationAvailabilityCriteria'
      webTestId: probe.id
      componentId: insights.id
      failedLocationCount: 2
    }
    actions: actions
  }
}

output workspaceId string = workspace.id
output workspaceCustomerId string = workspace.properties.customerId
