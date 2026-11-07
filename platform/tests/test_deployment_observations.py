from alcor_api import deployment_observations as observations
from pydantic import SecretStr
import pytest

P = "/api/deployment"
SHA = "a" * 40


@pytest.mark.parametrize("conclusion,jobs,expected", [
    ("success", [{"name": "Publish linux/amd64 image", "status": "completed", "conclusion": "success"}], "published"),
    ("success", [{"name": "Publish linux/amd64 image", "status": "completed", "conclusion": "skipped"}], "reused"),
    ("success", [{"name": "checks", "status": "completed", "conclusion": "success"}], "unknown"),
    ("failure", [], "failed"),
    ("cancelled", [], "failed"),
])
async def test_historical_publication_uses_publish_job_evidence(monkeypatch, conclusion, jobs, expected):
    value = observations.run_view(type("Settings", (), {"deployment_repository": "synthetic/repo"})(), run())
    value["conclusion"] = conclusion
    monkeypatch.setattr(observations, "github_json", lambda *_: {"jobs": jobs})
    before = dict(value)
    assert await observations.publication_results(None, [value]) == {123: expected}
    assert value == before  # Never rewrite original receipts or infer a deployable image.


async def test_historical_publication_missing_or_partial_evidence_stays_unknown(monkeypatch):
    settings = type("Settings", (), {"deployment_repository": "synthetic/repo"})()
    value = observations.run_view(settings, run())
    def offline(*_):
        raise OSError()
    monkeypatch.setattr(observations, "github_json", offline)
    assert await observations.publication_results(settings, [value]) == {123: "unknown"}
    monkeypatch.setattr(observations, "github_json", lambda *_: {
        "jobs": [{"name": "Publish linux/amd64 image", "status": "completed", "conclusion": "success"}],
        "total_count": 101,
    })
    assert await observations.publication_results(settings, [value]) == {123: "unknown"}
    value["status"] = "in_progress"
    assert await observations.publication_results(settings, [value]) == {123: "pending"}
    value["event"] = "push"
    assert await observations.publication_results(settings, [value]) == {123: None}


def setup(app):
    app.state.settings.deployment_repository = "synthetic/alcor-api"
    app.state.settings.deployment_image = "ghcr.io/synthetic/alcor-api"
    app.state.settings.deployment_github_token = SecretStr("synthetic-only")


def run(ident=123, sha=SHA):
    return {
        "id": ident,
        "head_sha": sha,
        "name": "Publish AlcorApi",
        "display_title": "Synthetic run",
        "status": "completed",
        "conclusion": "success",
        "created_at": "2026-10-31T00:00:00Z",
        "updated_at": "2026-10-31T00:02:00Z",
        "path": ".github/workflows/docker-publish.yml",
        "event": "workflow_dispatch",
        "html_url": "https://untrusted.invalid/",
    }


async def test_source_check_and_real_job_steps_are_mapped_without_untrusted_urls(app, monkeypatch):
    setup(app)

    def github(settings, path):
        if path == "/commits/main":
            return {"sha": SHA}
        if "/jobs?" in path:
            return {
                "jobs": [
                    {
                        "id": 1,
                        "name": "publish",
                        "status": "completed",
                        "conclusion": "success",
                        "steps": [
                            {"number": 1, "name": "Run tests", "status": "completed", "conclusion": "success"}
                        ],
                    }
                ]
            }
        return {"workflow_runs": [run()]}

    monkeypatch.setattr(observations, "github_json", github)
    result = await observations.observation(app.state.settings)
    assert result["source"]["sha"] == SHA and result["check"]["sha"] == SHA
    assert result["jobs"][0]["steps"][0]["name"] == "Run tests"
    assert result["build"]["url"] == "https://github.com/synthetic/alcor-api/actions/runs/123"

    def wrong(settings, path):
        if path == "/commits/main":
            return {"sha": SHA}
        return {"workflow_runs": [run(sha="b" * 40)]}

    monkeypatch.setattr(observations, "github_json", wrong)
    assert (await observations.observation(app.state.settings))["check"] is None


async def test_history_server_pagination_and_errors_are_not_empty_success(client, admin, app, monkeypatch):
    setup(app)
    calls = []

    def github(settings, path):
        calls.append(path)
        if "/jobs?" in path:
            return {"jobs": [{"name": "Publish linux/amd64 image", "status": "completed", "conclusion": "success"}]}
        return {"workflow_runs": [run()], "total_count": 1469}

    monkeypatch.setattr(observations, "github_json", github)
    result = await client.get(P + "/history?page=2")
    assert result.status_code == 200 and result.json()["total"] == 1469
    assert result.json()["items"][0]["publication"] == "published"
    assert calls == ["/actions/runs?branch=main&per_page=5&page=2", "/actions/runs/123/jobs?per_page=100"]
    assert (await client.get(P + "/history?page=0")).status_code == 422

    def offline(*args):
        raise OSError()

    monkeypatch.setattr(observations, "github_json", offline)
    assert (await client.get(P + "/history?page=2")).status_code == 503


async def test_heatmap_deduplicates_pages_and_keeps_incomplete_history_unknown(
    client, admin, app, monkeypatch
):
    setup(app)

    def github(settings, path):
        if "page=1&" in path:
            return [
                {"sha": str(i), "commit": {"committer": {"date": "2026-10-30T16:30:00Z"}}} for i in range(50)
            ]
        raise OSError()

    monkeypatch.setattr(observations, "github_json", github)
    result = (await client.get(P + "/activity")).json()
    assert result["counts"] == {"2026-10-31": 50} and not result["complete"] and result["loaded"] == 50

    def complete(settings, path):
        return [{"sha": SHA, "commit": {"committer": {"date": "2026-10-30T16:30:00Z"}}}]

    monkeypatch.setattr(observations, "github_json", complete)
    result = (await client.get(P + "/activity")).json()
    assert result["counts"] == {"2026-10-31": 1} and result["complete"]

    def offline(*args):
        raise OSError()

    monkeypatch.setattr(observations, "github_json", offline)
    assert (await client.get(P + "/activity")).status_code == 503


async def test_unconfigured_history_has_no_fake_zero_counts(client, admin):
    result = (await client.get(P + "/activity")).json()
    assert result["counts"] is None and result["loaded"] is None and not result["complete"]
    assert (await client.get(P + "/history")).json()["total"] is None


async def test_package_link_uses_image_name_and_correct_owner_route(app, monkeypatch):
    setup(app)
    app.state.settings.deployment_image = "ghcr.io/synthetic/custom-image"

    def github(settings, path):
        if path == "":
            return {"owner": {"login": "Synthetic", "type": "User"}}
        if path == "/commits/main":
            return {"sha": SHA}
        if "/jobs?" in path:
            return {"jobs": []}
        return {"workflow_runs": [run()]}

    monkeypatch.setattr(observations, "github_json", github)
    result = await observations.observation(app.state.settings)
    assert result["package_url"] == "https://github.com/users/synthetic/packages/container/custom-image"
    assert (
        observations.package_page(app.state.settings, "Organization")
        == "https://github.com/orgs/synthetic/packages/container/custom-image"
    )


async def test_package_metadata_failure_does_not_hide_new_source_commit(app, monkeypatch):
    setup(app)

    def github(settings, path):
        if path == "":
            raise OSError()
        if path == "/commits/main":
            return {"sha": "b" * 40}
        if "/jobs?" in path:
            return {"jobs": []}
        return {"workflow_runs": []}

    monkeypatch.setattr(observations, "github_json", github)
    result = await observations.observation(app.state.settings)
    assert result["source"]["sha"] == "b" * 40
    assert result["source_error"] is None
    assert result["check"] is None and result["build"] is None
    assert result["package_url"] == "https://github.com/synthetic?tab=packages"
