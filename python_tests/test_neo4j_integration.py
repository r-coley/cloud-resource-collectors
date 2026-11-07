"""Runs against an isolated Neo4j service in CI; no cloud credentials required."""

from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import pytest
from cloud_resource_collectors.common import read_json, stamp, CollectorError
from cloud_resource_collectors.graph import (
    connection_from_env,
    open_driver,
    import_snapshots,
    project_resources,
    query_resilience,
    read_query,
    write_plan,
)
from cloud_resource_collectors.graph_model import prepare_import

ROOT = Path(__file__).resolve().parents[1]
pytestmark = pytest.mark.skipif(
    os.environ.get("NEO4J_TEST") != "1",
    reason="Requires isolated Neo4j integration service",
)


@pytest.fixture(scope="module")
def driver():
    config = connection_from_env()
    with open_driver(config) as driver:
        driver.verify_connectivity()
        # Only enabled explicitly against the disposable CI/test database.
        with driver.session() as session:
            session.run("MATCH (n:InventoryEntity) DETACH DELETE n").consume()
        yield driver


def test_legacy_and_python_snapshot_imports(driver):
    from cloud_resource_collectors.cli import collect_snapshot

    snapshots = [
        read_json(ROOT / "examples" / f"{c}-service.cloud-inventory.json")
        for c in ("azure", "aws", "gcp")
    ]
    assert all(r["status"] == "imported" for r in import_snapshots(driver, snapshots))
    assert all(
        r["status"] == "already-imported" for r in import_snapshots(driver, snapshots)
    )
    for c, s in zip(("azure", "aws", "gcp"), snapshots):
        scope = s["scopes"][0]["id"]
        opts = dict(project=scope, snapshot=s["snapshotId"])
        result = project_resources(driver, opts)
        assert result["resourceCount"] == sum(
            r["scopeId"] == scope for r in s["resources"]
        )
        view = query_resilience(driver, opts)
        assert (
            view["assessment"] == "requires-review"
            and view["coverage"]["unverifiedCollections"] > 0
        )
        new = collect_snapshot(
            c,
            read_json(ROOT / "examples" / f"{c}-service.config.json"),
            read_json(ROOT / "examples" / f"{c}-service.inventory.json"),
        )
        assert import_snapshots(driver, [new])[0]["status"] == "imported"


def test_same_id_changed_content_rejected(driver):
    s = read_json(ROOT / "examples/aws-service.cloud-inventory.json")
    s["limitations"].append("changed")
    with pytest.raises(CollectorError, match="different content"):
        import_snapshots(driver, [s])


def test_concurrent_reimports_idempotent(driver):
    s = read_json(ROOT / "examples/aws-service.cloud-inventory.json")
    s["limitations"].append("concurrent")
    stamp(s)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(
            pool.map(lambda _: import_snapshots(driver, [s])[0]["status"], range(2))
        )
    assert sorted(results) == ["already-imported", "imported"]


def test_partial_observation_preserves_history_without_fake_resources(driver):
    s = read_json(ROOT / "examples/aws-service.cloud-inventory.json")
    removed = s["resources"].pop()
    key = removed["key"]
    s["relationships"] = [e for e in s["relationships"] if e["from"] != key]
    for e in s["relationships"]:
        if e["target"]["resourceKey"] == key:
            e["target"].update(resourceKey=None, resolution="unresolved")
    for service in s["services"]:
        service["memberships"] = [
            m for m in service["memberships"] if m["resourceKey"] != key
        ]
    s["collections"][0].update(status="partial", paginationComplete=False)
    stamp(s)
    import_snapshots(driver, [s])
    rows = read_query(
        driver,
        "neo4j",
        "MATCH (r:Resource {key:$key}) RETURN count(r) AS count",
        {"key": key},
    )
    assert rows[0]["count"] == 1
    result = project_resources(
        driver, dict(project=s["scopes"][0]["id"], snapshot=s["snapshotId"])
    )
    assert key not in {r["key"] for r in result["resources"]}


def test_transaction_exception_rolls_back(driver):
    s = read_json(ROOT / "examples/azure-service.cloud-inventory.json")
    s["limitations"].append("rollback")
    stamp(s)
    plan = prepare_import(s)

    def fail(tx):
        write_plan(tx, plan)
        raise RuntimeError("Injected test rollback")

    with driver.session() as session:
        with pytest.raises(RuntimeError):
            session.execute_write(fail)
    rows = read_query(
        driver,
        "neo4j",
        "MATCH (s:Snapshot {snapshotId:$id}) RETURN count(s) AS count",
        {"id": s["snapshotId"]},
    )
    assert rows[0]["count"] == 0
