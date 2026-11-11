# Source and dependencies

This repository maintains the Python collectors, provider mappings, and graph
queries. The [cloud-neutral JSON contract](docs/CONTRACT.md) defines the interface
between collection and graph import.

The implementation contains no source copied from Fix Inventory, Cartography,
or AWS Workload Discovery.

The collectors use Boto3, Azure Identity and Resource Graph, and Google's API
client and authentication libraries. The graph utility uses the Neo4j Python
driver. Both use JSON Schema validation. See [pyproject.toml](pyproject.toml)
for dependency ranges and [requirements-dev.lock.txt](requirements-dev.lock.txt)
for the recorded development environment. Upstream package licenses apply.

Neo4j is required for graph import and queries. The collectors authenticate
through the cloud SDKs, which can use credentials from an existing CLI login.
