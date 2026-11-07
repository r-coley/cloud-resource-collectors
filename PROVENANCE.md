# Source and dependencies

The initial collectors were extracted from the owner's architecture project at
commit `6584399`. This repository is independent: it imports no files or packages
from that project. The JSON contract is the integration boundary for future consumers.

No Fix Inventory, Cartography or AWS Workload Discovery source code has been copied
into the implementation. The research notes identify useful references for future
mapping improvements, not runtime dependencies.

Ajv and its dependencies are installed through npm using this repository's lockfile.
Their upstream package licences remain applicable. The official cloud CLIs are
separately installed prerequisites only for the respective live collection modes.
