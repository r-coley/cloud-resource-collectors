# Cloud Resource Collectors

Read-only resource discovery for Azure, AWS and GCP, producing a shared JSON inventory
for resilience assessment of cloud-deployed services. This is a standalone repository:
it does not require the architecture simulator or another discovery platform.

The intended pipeline is **cloud resources → JSON → graph database → resilience queries**.
Collection and Neo4j graph import/query utilities are implemented. See
[graph/README.md](graph/README.md) for database setup, imports and project resilience
evidence queries. No database is needed to run the collectors.

## Install and test

Requires Node.js 22 or later and npm.

```sh
git clone https://github.com/r-coley/cloud-resource-collectors.git
cd cloud-resource-collectors
npm ci
npm test
```

For live collection, also install and sign in using the relevant official CLI:
Azure CLI (`az`), AWS CLI v2 (`aws`), or Google Cloud CLI (`gcloud`). Use an existing
read identity. The tool does not log in, assign roles, enable APIs or deploy resources.

## Try all three clouds without credentials

```sh
npm run demo
```

This uses only synthetic fixtures. It writes JSON and local review pages under:

```text
runs/demo/azure/cloud-inventory.json
runs/demo/aws/cloud-inventory.json
runs/demo/gcp/cloud-inventory.json
```

Each folder also has `report.html`. Open it directly in a browser. To view the
reports through a local server, optionally run `python3 -m http.server 8770 --directory
runs/demo --bind 127.0.0.1` and open `http://127.0.0.1:8770/`.

## Collect one project from a cloud

Use one command for all providers. `--project` means the following:

| Cloud | Project scope passed to the command | Optional narrowing |
|---|---|---|
| Azure | Subscription UUID | One or more resource groups |
| AWS | Account ID | One or more explicit regions are required |
| GCP | Project ID | One or more explicit regions are required |

Replace the example IDs/profile names with your own. Use a new output filename for
each test. These commands perform read operations against real cloud APIs.

### Azure

```sh
node bin/cloud-collect.js --cloud azure \
  --project YOUR_SUBSCRIPTION_UUID \
  --resource-group YOUR_RESOURCE_GROUP \
  --output runs/azure-resources.json
```

Omit `--resource-group` to collect the selected API inventory for the whole subscription.
Repeat it to select several groups. Sign in to the intended tenant beforehand.
[Azure collection details and limitations](AZURE-README.txt).

### AWS

```sh
node bin/cloud-collect.js --cloud aws \
  --project YOUR_12_DIGIT_ACCOUNT_ID \
  --profile YOUR_EXISTING_READ_PROFILE \
  --region eu-west-2 \
  --output runs/aws-resources.json
```

The signed-in account and partition are verified before resource queries. Omit
`--profile` to use the existing AWS credential chain. The flags-based form uses the
standard `aws` partition; use configuration for other supported partitions.
[AWS details](AWS-README.txt) and [example read policy](examples/aws-readonly-policy.json).

### GCP

```sh
node bin/cloud-collect.js --cloud gcp \
  --project YOUR_PROJECT_ID \
  --region europe-west2 \
  --output runs/gcp-resources.json
```

The project ID is explicitly queried and its immutable project number is recorded.
The current ambient gcloud project does not determine the scope. Optionally pass
`--identity YOUR_EXISTING_GCLOUD_ACCOUNT`. [GCP details](GCP-README.txt).

## Collect multiple projects

Repeat `--project` and, for AWS/GCP, `--region`. The output is **one JSON document**
with multiple scope records and distinct resource identities.

```sh
node bin/cloud-collect.js --cloud gcp \
  --project YOUR_FIRST_PROJECT --project YOUR_SECOND_PROJECT \
  --region europe-west2 --region europe-west1 \
  --output runs/gcp-projects.json
```

For provider-specific settings, different regions per project, GCP project numbers,
a service catalogue, or different AWS profiles per account, use a JSON configuration:

```sh
node bin/cloud-collect.js --cloud aws \
  --config scopes.local.json \
  --output runs/aws-projects.json
```

Example `scopes.local.json` (replace these synthetic IDs and profile names):

```json
{
  "accounts": [
    {"id": "111122223333", "profile": "first-readonly", "regions": ["eu-west-2"]},
    {"id": "444455556666", "profile": "second-readonly", "regions": ["eu-west-1"]}
  ]
}
```

Multiple AWS accounts normally require separate existing profiles, as above. A single
profile is not assumed to grant access to several accounts. Azure subscriptions in
one invocation must be accessible through the same tenant sign-in. One invocation
collects one cloud; run three invocations to test one scope from each provider.

Provider configuration examples: [Azure](examples/azure-service.config.json),
[AWS](examples/aws-service.config.json), [GCP](examples/gcp-service.config.json).
Do not mix `--config` with scope flags. Run `node bin/cloud-collect.js --help` for options.

## Test the command with an offline inventory

```sh
node bin/cloud-collect.js --cloud azure \
  --config examples/azure-service.config.json \
  --inventory examples/azure-service.inventory.json \
  --output runs/azure-offline.json
```

Use the corresponding AWS/GCP files with `--cloud aws` or `--cloud gcp`. Offline
inventory must match the selected configuration scope; it does not query any cloud.

## What the JSON contains

[Schema](cloud-inventory.schema.json) · [Contract](CONTRACT.txt) ·
[Azure example](examples/azure-service.cloud-inventory.json) ·
[AWS example](examples/aws-service.cloud-inventory.json) ·
[GCP example](examples/gcp-service.cloud-inventory.json)

The unified command writes all observed resources in the requested scope, including
untagged resources. No service catalogue or service ID is required. Optional service
tags/labels add service memberships; they do not filter untagged resources out of the
project inventory. Service ownership is not inherited from project/resource-group labels.

The document includes scopes, resource types/IDs, placement and configuration facts,
configuration relationships, collection statuses, timestamps and filtered source evidence.
Provider-specific settings are retained. Stable identities distinguish clouds, accounts,
projects and supported partitions. Missing data stays unknown; incomplete collection
cannot establish that a resource was deleted or that protection exists.

The collectors cover an initial set of resource types, not every service on each cloud.
Counts, tiers and placement settings do not establish transaction capacity, tested recovery
or RTO/RPO. `simulationReady` remains false. Live integration still needs verification.
See provider notes for the exact API scope and uncollected information.

## Results and troubleshooting

- Exit **0**: selected queries completed; permission coverage still needs review.
- Exit **2**: valid JSON written with partial, missing, denied or warned collections.
- Exit **1**: invalid input, authentication/scope mismatch, validation or output failure.

Start by checking `collections` and each service's `gaps`. Output files are never
overwritten. Parent folders are created if needed. Files use owner-only permissions;
`runs/` and `*.local.json` are ignored by Git. Treat exports as confidential cloud
configuration: filtering known sensitive fields is not a complete secrets detector.

The lower-level `azure-discover.js`, `aws-discover.js` and `gcp-discover.js` commands
remain available for provider-specific review bundles. Use `bin/cloud-collect.js` as
the project-inventory interface and the JSON handoff to the graph importer.

## Populate and query a graph database

After collecting JSON, use the independent graph utility in this repository:

```sh
node bin/cloud-graph.js import --input runs/azure-resources.json --input runs/aws-resources.json
node bin/cloud-graph.js projects
node bin/cloud-graph.js resilience --project YOUR_PROJECT_ID
```

Configure Neo4j first using the [graph setup and query instructions](graph/README.md).
The importer preserves evidence and snapshot history, supports repeat imports, and
never treats missing resources in a partial scan as deletions. Resilience queries
show configuration evidence and gaps for review; they do not certify resilience.
