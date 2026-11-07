AWS service service discovery — initial connector

Purpose
Collect selected AWS configuration once per explicitly configured account/region,
then group observations by an exact, case-sensitive serviceId tag. Output uses the
same cloud-inventory/1.0.0 contract as Azure. No Fix Inventory, Cartography or graph
platform dependency is introduced. This connector was built with our own code.

Try the synthetic example (no AWS CLI, credentials or cloud calls)
Requires Node.js 22+ and the existing validator dependency installed with:
  npm ci
From the project root, use a new output directory:

node aws-discover.js \
  --config examples/aws-service.config.json \
  --inventory examples/aws-service.inventory.json \
  --output /tmp/aws-service-discovery

Open /tmp/aws-service-report.html. The example has DEMO-SERVICE-A across
London and Ireland, eight EC2 observations in Auto Scaling groups with desired
counts 6/2, regional load balancers/probes, Aurora cluster members and a global
cluster, subnets and capacity reservation configuration. DEMO-SERVICE-B deliberately
contains an unsupported tagged Lambda function, and DEMO-SERVICE-C has no visible
resources. Neither counts nor database classes imply transaction throughput.
The global cluster's reported writer flags are evidence, not an assumed regional
failover policy or proof of zero data loss.
After running npm run demo, the example is also available at:
runs/demo/aws/report.html

Live collection (not exercised in development)
Requires AWS CLI v2 already authenticated. Configure one existing profile per
account, for example an AWS IAM Identity Center/SSO or assume-role profile. The
connector does not log in, create roles or modify cloud resources. It uses the
CLI's existing credential chain if profile is omitted. It verifies STS account ID
and partition for ALL requested accounts before starting resource collection.
A mismatch or failed authentication aborts the run without resource queries.

Copy aws-service.config.json to aws-service.local.json, replace the
synthetic account ID, profile, explicit regions and catalogue. The example account
ID is deliberately synthetic. Do not run it unchanged against a real account.

mkdir -p runs
node aws-discover.js \
  --config aws-service.local.json \
  --output runs/NEW_AWS_RUN

The output directory must not already exist. No automatic organization/account or
region enumeration occurs. Accounts in aws, aws-us-gov and aws-cn partitions are
accepted with matching region prefixes; sovereign partitions have not been live
tested. There is no custom API endpoint option or credential field in the config.

Outputs
- cloud-inventory.json: cloud-neutral estate snapshot, source evidence and coverage.
- services/00001.json etc.: schema-valid per-service neutral snapshots, filtered to
  that service's resources/evidence; shared collection metadata remains present.
- aws-inventory.json: filtered AWS observations for reproducible offline processing.
- report.html: standalone local review of services, observed facts and query gaps.
Generated files/directories use owner-only permissions and new run directories.
Runs and *.local.json are excluded from Git. Known sensitive configuration keys
are filtered, but arbitrary tags/configuration may still be confidential. No secret
values, user data, application traffic or customer service data APIs are queried.

Exit status
0: selected API queries completed, permissions still unverified.
2: missing/denied/incomplete query coverage, outputs retained for review.
1: invalid config/input, identity mismatch, validation or output failure.
Success never means the whole AWS estate was visible or that protection is proven.

First resource/API coverage
EC2: instances, subnets, VPCs, capacity reservations, launch-template metadata.
Auto Scaling: groups, member instances, health/warmup configuration, scaling policies.
ELBv2: load balancers, target groups and health-probe settings, listeners/default
forwarding actions, target health observations.
RDS: instances, clusters, subnet groups, global clusters, membership/writer/promotion
tiers and configured backups/restorable times where supplied by these APIs.
Tagging: GetResources provides tags and unsupported-resource placeholders. Service
APIs collect untagged dependencies; GetResources alone never gives full inventory.
Global RDS clusters are requested through the account's first configured region.
All APIs use the official CLI, fixed read operations, argument arrays rather than a
shell, automatic CLI pagination disabled, and explicit native NextToken/Marker/
PaginationToken handling. Each request has time/output bounds; transient errors
have at most four attempts. Repeated tokens and a 1000-page ceiling mark queries
partial. Calls are sequential in this first version, limiting pressure on APIs.
Full account-region scans are shared by services; there is no scan per service.

Permissions
examples/aws-readonly-policy.json lists the exact read actions used, with Resource
"*" for these listing operations. It is an example to review with the account
owner, not a role assignment performed by the tool. SCPs, permission boundaries,
region restrictions and service errors can still limit results. STS identity
verification does not establish completeness of resource-read permissions.

Relationships and limits
AWS ARN case is preserved. Identity includes cloud, partition and account. Explicit
configuration links retain source pointers; derived ARN construction from native
IDs is deterministic and never establishes an application call path. Unresolved
references are retained. Group membership is not tag inheritance. Incoming scaling,
replication and routing child/pool/health observations can be associated with the
owned resources; traversal depth/count are bounded. Tag conflicts block automatic
ownership attribution. Configured zones are distinguished from healthy distribution.

Not yet covered
Classic ELB, Route 53/CloudFront/global ingress, ECS/EKS workloads, Lambda details,
DynamoDB/global tables, S3/backup vaults, security group rule reachability, IAM,
launch-template version contents and legacy launch configurations, warm pools,
scheduled scaling, non-default listener rules and runtime application telemetry.
Tagged unsupported resources are retained, but unsupported untagged resources may
be invisible. A complete selected API scan is never a complete cloud inventory.
Database failover behaviour, client reconnection, successful restore tests, quota
headroom, usable reserved capacity and workload demand require further evidence.
No snapshot is automatically simulation-ready. Graph import remains a separate task.

Verification
npm test
Tests use injected AWS API responses and synthetic data: pagination over 1000
instances and all token dialects, scope/identity rejection, throttling, denied APIs,
missing detail coverage, graph/evidence validation, source filtering, case-sensitive
service tagging and ARN identity, cross-region relationships, HTML escaping and
CLI estate/per-service export. No live AWS account has been scanned.

Official references reviewed 7 November 2026
https://docs.aws.amazon.com/cli/latest/reference/autoscaling/describe-auto-scaling-groups.html
https://docs.aws.amazon.com/cli/latest/reference/rds/describe-db-clusters.html
https://docs.aws.amazon.com/cli/latest/reference/resourcegroupstaggingapi/get-resources.html
https://docs.aws.amazon.com/cli/latest/reference/elbv2/describe-target-groups.html
https://docs.aws.amazon.com/cli/latest/reference/sts/get-caller-identity.html
