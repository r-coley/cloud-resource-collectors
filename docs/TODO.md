# Collector improvements

## Azure collector improvements

1. Verify coverage in a read-only Azure pilot.
   Compare collected JSON with the provider responses for a known deployment.
   Check scale sets, SQL failover groups and backup retention, load balancer
   probes, and autoscale settings. Exercise a denied or partial read and verify
   the output identifies the affected collection. Add targeted provider reads
   where the pilot shows that Resource Graph omits required records or fields.

2. Collect VM scale set instance placement and health.
   Enumerate member instances and link them to their scale set. Record each
   observed zone and any available instance health or provisioning state
   separately from the scale set's configured zones and desired capacity.

3. Resolve load balancer relationships at the subresource level.
   Link rules to their configured probes and backend pools, and resolve pool
   members where the provider exposes their identities. Keep unresolved links
   and the source evidence for each relationship.

4. Check whether capacity reservations match the recovery deployment.
   Compare reservation location, zone and SKU with the compute configuration.
   Capture reserved and allocated quantities where available, and report when
   the available quantity cannot be established.

## Cross-cloud validation


1. Run read-only pilots against known AWS and GCP deployments.
   Compare the collected JSON with provider responses. Verify that service
   membership includes expected tagged or labelled resources and that shared
   dependencies are represented with supporting references. Exercise a denied
   or partial read and verify that the affected scope is reported in the JSON.

2. Measure collection at representative multi-project scale.
   Record scan duration, API throttling and partial results across multiple
   accounts, subscriptions or projects. Reuse each scope's inventory for
   service grouping so the number of services does not multiply cloud scans.
