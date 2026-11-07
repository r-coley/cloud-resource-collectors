# Graph import — next stage

The graph importer will live in this repository alongside the collectors. It is
not implemented yet, and collecting JSON does not require a database.

The intended flow is:

```text
Azure / AWS / GCP → collectors → cloud-inventory.json → graph importer → graph database
                                                                          ↓
                                                        project/service resilience queries
```

The importer will consume `cloud-inventory/1.0.0`, validate the complete file before
writing, and namespace observations by snapshot ID while retaining stable resource
keys. Service membership, deployment containment and configuration references must
remain distinct relationships. Unresolved targets remain references, not invented
observed resources.

Imports should be idempotent and preserve evidence, timestamps and collection gaps.
A partial scan must not delete previously observed resources. Historical observations
must remain distinguishable from current configuration. Inferred resilience findings
will need rule versions and supporting evidence; missing evidence cannot be a pass.

The graph database technology, connection format and database creation/import command
will be decided when implementing this stage. No database platform is currently a
collector runtime dependency.
