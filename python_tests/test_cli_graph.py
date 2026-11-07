from pathlib import Path
import pytest
from cloud_resource_collectors.cli import collect_run, graph_run
from cloud_resource_collectors.common import CollectorError, read_json
from cloud_resource_collectors.graph import (
    choose_project,
    connection_from_env,
    resilience_evidence,
    write_plan,
)
from cloud_resource_collectors.graph_model import prepare_import

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("cloud", ["azure", "aws", "gcp"])
def test_collect_cli_offline_and_no_overwrite(cloud, tmp_path):
    dest = tmp_path / "output.json"
    args = [
        "--cloud",
        cloud,
        "--config",
        str(ROOT / "examples" / f"{cloud}-service.config.json"),
        "--inventory",
        str(ROOT / "examples" / f"{cloud}-service.inventory.json"),
        "--output",
        str(dest),
    ]
    assert collect_run(args) == 0
    assert read_json(dest)["resources"]
    assert dest.stat().st_mode & 0o777 == 0o600
    with pytest.raises(CollectorError, match="already exists"):
        collect_run(args)


def test_graph_rejects_invalid_inputs_before_connect(tmp_path, monkeypatch):
    from cloud_resource_collectors import graph

    monkeypatch.setattr(
        graph, "open_driver", lambda _: pytest.fail("Must validate before connecting")
    )
    path = tmp_path / "invalid.json"
    path.write_text("{}")
    with pytest.raises(CollectorError):
        graph_run(["import", "--input", str(path)])


@pytest.mark.parametrize(
    "uri", ["http://localhost:7474", "bolt://user:secret@localhost:7687", "bolt://"]
)
def test_unsafe_graph_connection_rejected(uri):
    with pytest.raises(CollectorError):
        connection_from_env({"NEO4J_URI": uri, "NEO4J_PASSWORD": "test"})


def test_project_selection_uses_collection_time_not_import_time():
    rows = [
        dict(
            project="p",
            selectorHash="s",
            origin="live",
            snapshotId="new",
            collectedTo="2026-11-07T01:00:00Z",
        ),
        dict(
            project="p",
            selectorHash="s",
            origin="live",
            snapshotId="old",
            collectedTo="2026-11-06T01:00:00Z",
        ),
    ]
    assert choose_project(rows)["snapshotId"] == "new"
    rows[1]["origin"] = "synthetic"
    with pytest.raises(CollectorError, match="multiple"):
        choose_project(rows)


def test_evidence_unknown_is_not_false_or_certified():
    resource = dict(
        key="r",
        name="n",
        kind="compute",
        region="r",
        zones=None,
        placementMeaning="unknown",
        facts=[
            dict(name="automaticRepairsPolicy.enabled", status="observed", value=False)
        ],
    )
    view = resilience_evidence(
        {},
        [resource],
        coverage=[
            dict(
                status="partial",
                paginationComplete=False,
                permissionCoverage="unverified",
            )
        ],
        counts={"resourceCount": 20},
    )
    assert view["assessment"] == "requires-review" and view["coverage"]["truncated"]
    check = next(c for c in view["checks"] if c["id"] == "automatic-recovery")
    assert check["items"][0]["facts"][0]["value"] is False


def test_unsupported_graph_labels_rejected_before_write():
    plan = prepare_import(read_json(ROOT / "examples/aws-service.cloud-inventory.json"))
    plan["nodes"][0]["label"] = "Unsafe"
    with pytest.raises(CollectorError, match="Unsupported"):
        write_plan(None, plan)
