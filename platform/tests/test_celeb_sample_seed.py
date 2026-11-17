"""One-time recovery of the pre-migration public celebrity examples."""

from alcor_api.celeb_core import Celebs, seed_bundled_samples


async def test_bundled_samples_are_seeded_once_on_an_empty_catalogue(admin, db):
    assert await seed_bundled_samples(db, require_legacy=False) == {"seeded": 6}
    listing = await Celebs(db).list()
    assert [item["id"] for item in listing["celebs"]] == [
        "buffett",
        "pelosi",
        "huang",
        "cathie",
        "trump",
        "duan",
    ]
    by_id = {item["id"]: item for item in listing["celebs"]}
    assert by_id["pelosi"]["dataSource"] == "sample"
    assert by_id["buffett"]["dataSource"] == "13f"
    assert by_id["buffett"]["dataAuthority"] == "administrator_registered_disclosure"
    assert by_id["buffett"]["holdings"]
    # The seed is one-time: a nonempty catalogue is never overwritten.
    assert await seed_bundled_samples(db, require_legacy=False) == {"seeded": 0, "reason": "not_empty"}
    async with db.connection() as conn:
        assert (await (await conn.execute("SELECT count(*) n FROM celeb_heads")).fetchone())["n"] == 6
