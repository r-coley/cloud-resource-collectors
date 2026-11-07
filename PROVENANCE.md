# Source and dependencies

The initial collectors were extracted from the owner's architecture project at
commit `6584399`. This repository is independent: the cloud-neutral JSON contract
is its integration boundary. Version 0.3 ports the collectors and graph utility
to Python; the earlier implementation remains available in Git history.

No Fix Inventory, Cartography or AWS Workload Discovery source code is copied into
the implementation. Research notes record references, not runtime dependencies.
Provider mappings and query definitions are maintained in this repository.

The implementation uses the official Boto3, Azure Identity/Resource Graph, Google
API client/google-auth, and Neo4j Python packages, plus jsonschema. Dependencies
and version ranges are in pyproject.toml; requirements-dev.lock.txt records the
tested development environment. Upstream package licences remain applicable.

Neo4j is a separately deployed graph backend, not a collection prerequisite.
No APOC plugin or discovery-platform runtime is required. Cloud CLIs are optional
ways to prepare supported SDK credentials; collectors never invoke subprocesses.
