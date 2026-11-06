"""Pure public-projection boundary: no PostgreSQL fixture or external transport."""

from alcor_api.site_settings import DEFAULTS, public_projection


async def test_unknown_restored_private_keys_never_expand_public_contract():
    class Result:
        async def fetchone(self):
            return None

    class Connection:
        async def execute(self, query):
            assert query == "SELECT 1 FROM restore_quarantine WHERE category='external_delivery_disabled'"
            return Result()

    row = {
        "settings": {
            "title": "Synthetic",
            "smtpPassword": "SyntheticPrivate9",
            "futurePrivateProvider": {"token": "SyntheticPrivate9"},
        },
        "allow_register": True,
    }
    result = await public_projection(Connection(), row, False)
    assert set(result) == (set(DEFAULTS)-{"pwaIcon"}) | {"allowRegister", "emailRegistration"}
    assert result["title"] == "Synthetic"
    assert "SyntheticPrivate9" not in str(result)
    assert row["settings"]["smtpPassword"] == "SyntheticPrivate9"
