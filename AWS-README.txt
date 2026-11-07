AWS resource collection — Python 0.3

Install
Python 3.11+; follow README.md for virtual environment and pip installation.

Offline example (no cloud credentials or network)
cloud-collect --cloud aws --config examples/aws-service.config.json \
  --inventory examples/aws-service.inventory.json --output runs/aws-offline.json
cloud-demo also writes synthetic JSON and HTML reports under runs/demo/.

Live collection
Uses Boto3's credential chain. Configure existing read-only profiles (including
SSO or assume-role profiles), environment credentials or workload credentials.
--profile selects an existing profile. STS verifies every requested account and
partition before resource queries. It does not create roles or authenticate for you.
Regions are explicit. aws, aws-us-gov and aws-cn are supported configuration
partitions; sovereign endpoints have not been live tested.

Copy examples/aws-service.config.json to a *.local.json file and replace the
synthetic project scopes and credentials/profile references before collecting:
cloud-collect --cloud aws --config scopes.local.json --output runs/aws-resources.json

Output is one cloud-inventory/1.0.0 JSON document, including all observed resources
in scope, optional service memberships, facts, relationships, source evidence and
collection coverage. Existing files are never overwritten. Files use owner-only
permissions; runs/ and *.local.json are excluded from Git. Known sensitive fields
are filtered, but exports can still contain confidential configuration.

Exit 0 = selected queries complete (visibility unverified); 2 = partial JSON saved;
1 = configuration, credentials, scope, validation or output error. No query success
establishes tested resilience. Live provider integration has not yet been verified.

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
All APIs use Boto3 with fixed read operations and explicit native NextToken/Marker/
PaginationToken handling. Each request has network timeouts; transient errors
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
No snapshot is automatically simulation-ready. Graph import is a separate command in this repository.


Verification
python -m pytest
Offline fixtures, injected API responses and SDK request-shape checks are tested.
No live cloud project is queried by the tests. Neo4j integration runs in CI.
